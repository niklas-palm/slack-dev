// Slack events → the agent's microVM.
//
//   1. Verify the Slack signing-secret HMAC. This is the real authentication for a public route.
//   2. Answer Slack's one-time url_verification challenge.
//   3. Keep only app_mention, only from an APPROVED channel; drop Slack's retries.
//   4. Add 👀 so the human knows we saw it.
//   5. Route the thread to a microVM — reuse the warm one from DynamoDB, or run a new one — and POST
//      the prompt to /invoke inside it. Same thread ⇒ same VM ⇒ the agent still has the conversation.
//   6. Ack. The agent does the (possibly minutes-long) work and replies in-thread itself.
//
// The image ARN comes from the SSM parameter `npm run image` publishes, so no ARN is hardcoded and a
// rebuilt image is picked up without touching this function.
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import {
  type MicroVm,
  getMicrovm,
  runMicrovm,
  terminateMicrovm,
  usable,
  vmRequest,
} from "./microvm.js";

const REGION = process.env.AWS_REGION!;
const SIGNING_SECRET_PARAM = process.env.SIGNING_SECRET_PARAM!;
const BOT_TOKEN_PARAM = process.env.BOT_TOKEN_PARAM!;
const SESSION_TABLE = process.env.SESSION_TABLE!;
const IMAGE_ARN_PARAM = process.env.MICROVM_IMAGE_ARN_PARAM!;
const VM_ROLE_ARN = process.env.MICROVM_ROLE_ARN!;
/** Idle seconds before a VM suspends — NOT its lifetime (a fixed 8h). See infra/lib/config.ts. */
const IDLE_SECONDS = Number(process.env.MICROVM_IDLE_SECONDS ?? 900);

/** The port the agent serves on inside the VM (runtime/src/config.ts HOOK_PORT). */
const AGENT_PORT = 9000;

/**
 * Channel ids this agent answers in — a comma-separated list baked in at deploy time, or empty for
 * "any channel the bot is in".
 *
 * Enforced HERE, in the ingress, not in the agent: by the time the runtime has a prompt it has already
 * cost a microVM and a model call, and the agent could be talked into replying anyway. An unapproved
 * mention should cost nothing and produce no sign of life — so this check runs before the 👀.
 */
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

/** Ids, never names: the event payload has only the id, so matching a name would need an API lookup. */
export function channelAllowed(
  channel: string,
  allowed: string[] = ALLOWED_CHANNELS,
): boolean {
  return allowed.length === 0 || allowed.includes(channel);
}

const ssm = new SSMClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

// Warm-container SSM cache. A cached value can go stale across a deploy — most dangerously the
// runtime ARN, which is republished whenever the runtime is REPLACED: a warm Lambda would keep
// invoking a deleted ARN, producing the silent "eyes but no reply" failure. So callers can force a
// refetch, and invalidate() drops a key so the next read goes back to SSM.
const cache = new Map<string, string>();

async function ssmValue(name: string, refresh = false): Promise<string> {
  if (!refresh) {
    const hit = cache.get(name);
    if (hit) return hit;
  }
  const r = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const value = r.Parameter?.Value;
  if (!value) throw new Error(`empty SSM parameter: ${name}`);
  cache.set(name, value);
  return value;
}

interface LambdaEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
interface SlackEvent {
  type?: string;
  text?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  bot_id?: string;
  app_id?: string;
}
interface SlackCallback {
  type?: string;
  event?: SlackEvent;
  challenge?: string;
}

function header(
  h: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return h[name] ?? h[name.toLowerCase()];
}

export function verifySignature(
  signature: string | undefined,
  timestamp: string | undefined,
  body: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!signature || !timestamp) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > 300)
    return false; // 5-min replay window
  const expected =
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The routing key for a thread: the DynamoDB partition key, and the agent's in-VM session id. Stable
 *  per thread — that's what makes a follow-up reach the same VM, with the conversation still in it. */
export function sessionIdFor(threadTs: string): string {
  return `slack-${threadTs}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
}

async function slackCall(
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok?: boolean; error?: string }> {
  const token = await ssmValue(BOT_TOKEN_PARAM);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    // fetch has no default timeout, and this runs INSIDE a 10s Lambda before the runtime is invoked —
    // a hung 👀 call therefore eats the whole budget, the invoke never happens, and Slack retries into
    // the retry-drop below. That is exactly the "eyes but no reply" class this file exists to prevent.
    signal: AbortSignal.timeout(3_000),
  });
  const parsed = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  // Never report a falsy error: a non-JSON body (proxy page, 5xx) parsed to {}, so the failure notice's
  // own log line read "ALSO failed: undefined" — naming no reason for the last-resort failure.
  if (parsed.ok) return parsed;
  return {
    ...parsed,
    ok: false,
    error:
      parsed.error ||
      `Slack returned an unreadable response (HTTP ${res.status})`,
  };
}

/** Best-effort 👀. Not fatal — but log a failure, because "no eyes" is the first symptom we debug. */
async function addEyes(channel: string, ts: string): Promise<void> {
  try {
    const r = await slackCall("reactions.add", {
      channel,
      timestamp: ts,
      name: "eyes",
    });
    if (!r.ok && r.error !== "already_reacted")
      console.warn(`[slack] reactions.add failed: ${r.error ?? "unknown"}`);
  } catch (e) {
    console.warn("[slack] reactions.add threw", e);
  }
}

/**
 * The thread's microVM: the warm one if there is one, otherwise a fresh one.
 *
 * A stored row can outlive its VM — idle-terminated, max duration reached, crashed — so the state is
 * always re-checked rather than trusted. That check is what stops a thread from silently going dead
 * for the rest of the day after its first VM is reclaimed.
 */
async function vmForThread(sessionId: string): Promise<MicroVm> {
  const stored = await readRow(sessionId);
  const reusable = await reuse(stored?.microvmId);
  if (reusable) return reusable;

  const imageArn = await ssmValue(IMAGE_ARN_PARAM);
  const vm = await runMicrovm({
    imageArn,
    executionRoleArn: VM_ROLE_ARN,
    idleSeconds: IDLE_SECONDS,
  });
  console.log(`[route] ran ${vm.microvmId} for ${sessionId}`);

  // CLAIM the slot conditionally. A consistent read only shows rows already committed — it does not
  // serialize two Lambdas in flight, so two mentions ~1s apart both missed, both ran a VM, and the
  // second PutItem overwrote the first. That left the first VM orphaned (nothing points at it, so
  // nothing ever terminates it: 8h of billing) and split the thread across two agents that can't see
  // each other's messages.
  //
  // Losing the race is fine and cheap: we terminate the VM we just started and use the winner's, so
  // the thread keeps ONE conversation.
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: SESSION_TABLE,
        Item: {
          threadKey: { S: sessionId },
          microvmId: { S: vm.microvmId },
          // TTL is housekeeping only — the state check in reuse() is what keeps routing correct. Past
          // the 8h ceiling a VM cannot exist, so the row is certainly stale by then.
          expiresAt: { N: String(Math.floor(Date.now() / 1000) + 32_400) },
        },
        // Only claim a slot that is empty, or held by the VM we just decided was unusable.
        ConditionExpression:
          "attribute_not_exists(threadKey) OR microvmId = :previous",
        ExpressionAttributeValues: {
          ":previous": { S: stored?.microvmId ?? "" },
        },
      }),
    );
  } catch (e) {
    if ((e as { name?: string }).name !== "ConditionalCheckFailedException") {
      // The VM is running, so answer this mention with it. A lost write means the NEXT message starts
      // another VM — degraded, not broken.
      console.warn(`[route] could not store the session row: ${String(e)}`);
      return vm;
    }
    const winner = await reuse((await readRow(sessionId))?.microvmId);
    if (winner) {
      console.log(`[route] lost the race; using ${winner.microvmId}, dropping ${vm.microvmId}`);
      await terminate(vm.microvmId);
      return winner;
    }
    // The winner's VM is already unusable — ours is the better answer; keep it.
    console.warn(`[route] lost the race but the winner is gone; keeping ${vm.microvmId}`);
  }

  return vm;
}

/** The thread's row, or undefined. A read failure must not lose the mention — we fall through. */
async function readRow(
  sessionId: string,
): Promise<{ microvmId: string } | undefined> {
  try {
    const res = await ddb.send(
      new GetItemCommand({
        TableName: SESSION_TABLE,
        Key: { threadKey: { S: sessionId } },
        // Eventually-consistent would miss the row written seconds ago by the previous message in a
        // fast back-and-forth. Doesn't serialize concurrent writers — that's the claim above.
        ConsistentRead: true,
      }),
    );
    const id = res.Item?.microvmId?.S;
    return id ? { microvmId: id } : undefined;
  } catch (e) {
    console.warn(`[route] session lookup failed: ${String(e)}`);
    return undefined;
  }
}

/**
 * The VM behind an id, if it can still serve. A stored row outlives its VM — idle-terminated, past its
 * 8h ceiling, crashed — so the state is always re-checked rather than trusted. Without that, a thread
 * goes permanently dead once its first VM is reclaimed.
 */
async function reuse(microvmId?: string): Promise<MicroVm | undefined> {
  if (!microvmId) return undefined;
  try {
    const vm = await getMicrovm(microvmId);
    if (usable(vm.state)) {
      console.log(`[route] reusing ${vm.microvmId} (${vm.state})`);
      return vm;
    }
    // It can't serve, and it may still be billing — let it go rather than waiting for the ceiling.
    console.log(`[route] ${microvmId} is ${vm.state} — starting a fresh one`);
    if (vm.state === "SUSPENDING" || vm.state === "RUNNING")
      await terminate(microvmId);
  } catch (e) {
    // Most likely already gone (404). Same outcome: start a fresh one.
    console.log(`[route] ${microvmId} unavailable (${String(e).slice(0, 120)})`);
  }
  return undefined;
}

/** Best-effort terminate. A VM bills until it stops, so a failure here is worth a log line. */
async function terminate(microvmId: string): Promise<void> {
  await terminateMicrovm(microvmId).catch((e: unknown) =>
    console.warn(`[route] could not terminate ${microvmId}: ${String(e)}`),
  );
}

/**
 * Hand the prompt to the agent inside the VM.
 *
 * `/invoke` returns as soon as the turn is queued — the work takes minutes and the agent reports
 * progress through Slack itself, so nothing waits here. A brand-new VM may still be booting, so a
 * connection failure is retried a few times before giving up.
 */
async function invokeAgent(
  vm: MicroVm,
  sessionId: string,
  prompt: string,
  slack: Record<string, string>,
  deadlineMs: number,
): Promise<void> {
  const body = JSON.stringify({ sessionId, prompt, source: "slack", slack });
  let lastError = "";

  // Retry against a DEADLINE, not a fixed ladder. A fresh VM needs a few seconds before its endpoint
  // forwards traffic, so retrying is right — but the back-off has to fit the Lambda's remaining time
  // with room to spare for the failure notice. A ladder that outran the timeout meant the Lambda was
  // killed mid-loop, so the catch block that tells the human anything never ran: 👀 and permanent
  // silence, since Slack's own retry is deliberately dropped as a duplicate.
  while (Date.now() < deadlineMs) {
    try {
      const res = await vmRequest(vm, AGENT_PORT, {
        method: "POST",
        path: "/invoke",
        body,
        // Bounded by whatever budget is left, so one slow call can't eat the whole window.
        timeoutMs: Math.max(2_000, Math.min(10_000, deadlineMs - Date.now())),
      });
      if (res.status < 300) {
        console.log(
          `[invoke] ${vm.microvmId} session=${sessionId} status=${res.status} ${res.body.slice(0, 200)}`,
        );
        return;
      }
      lastError = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
    } catch (e) {
      lastError = String(e).slice(0, 200);
    }
    // No sleep if there's no time left to use it — that wasted the budget the notice needs.
    if (Date.now() + 2_500 >= deadlineMs) break;
    console.log(`[invoke] not ready (${lastError}); retrying`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`agent never accepted the prompt: ${lastError}`);
}

export async function handler(
  ev: LambdaEvent,
  context?: { getRemainingTimeInMillis?: () => number },
): Promise<{ statusCode: number; body: string }> {
  // Reserve time to POST the failure notice: the only thing that tells a human the agent never
  // started. Without the reservation the retry loop consumed the whole budget and the notice — and so
  // any signal at all — was lost. Falls back to a conservative 20s when there's no context (tests).
  const remaining = context?.getRemainingTimeInMillis?.() ?? 25_000;
  const invokeDeadline = Date.now() + Math.max(3_000, remaining - 6_000);
  const headers = ev.headers ?? {};
  const rawBody = ev.isBase64Encoded
    ? Buffer.from(ev.body ?? "", "base64").toString("utf8")
    : (ev.body ?? "");

  const secret = await ssmValue(SIGNING_SECRET_PARAM);
  if (
    !verifySignature(
      header(headers, "X-Slack-Signature"),
      header(headers, "X-Slack-Request-Timestamp"),
      rawBody,
      secret,
    )
  ) {
    return { statusCode: 401, body: "invalid signature" };
  }

  let body: SlackCallback;
  try {
    body = JSON.parse(rawBody) as SlackCallback;
  } catch {
    return { statusCode: 400, body: "invalid json" };
  }

  // One-time handshake when you register the events URL.
  if (body.type === "url_verification" && body.challenge) {
    return { statusCode: 200, body: body.challenge };
  }

  const event = body.event;
  // Log why a callback is dropped — otherwise "I mentioned it and got nothing" is undebuggable.
  if (
    body.type !== "event_callback" ||
    event?.type !== "app_mention" ||
    event.bot_id ||
    event.app_id
  ) {
    console.log(
      `[event] ignored: type=${body.type} event=${event?.type} bot=${event?.bot_id ?? event?.app_id ?? "-"}`,
    );
    return { statusCode: 200, body: "ok (ignored)" };
  }
  // Silent by design: no 👀, no message, nothing. Someone who invites the bot into their own channel
  // and mentions it gets an inert bot, and a prober learns nothing about which channels exist. The log
  // line is the only trace, and it's the first thing to grep when a legitimate channel looks dead.
  if (event.channel && !channelAllowed(event.channel)) {
    console.log(
      `[event] channel not allowed: channel=${event.channel} user=${event.user ?? "-"} — ignoring`,
    );
    return { statusCode: 200, body: "ok (channel not allowed)" };
  }
  if (!event.channel || !event.user || !event.ts) {
    console.warn(
      `[event] incomplete app_mention: channel=${event.channel} user=${event.user} ts=${event.ts}`,
    );
    return { statusCode: 200, body: "ok (incomplete)" };
  }
  // Slack retries when it doesn't get an ack within 3s. We invoke asynchronously and ack fast, so a
  // retry means Slack missed our ack — the original invoke is already running. Dropping it prevents
  // the agent from doing the same work twice.
  const retry = header(headers, "X-Slack-Retry-Num");
  if (retry !== undefined) {
    console.log(`[event] retry ignored (num=${retry}, ts=${event.ts})`);
    return { statusCode: 200, body: "ok (retry ignored)" };
  }

  // thread_ts is absent when the mention starts a new thread; then the message itself is the root.
  const threadTs = event.thread_ts ?? event.ts;
  const slack = {
    channel_id: event.channel,
    thread_ts: threadTs,
    slack_user_id: event.user,
    trigger_message_ts: event.ts,
  };
  console.log(
    `[event] app_mention channel=${event.channel} user=${event.user} thread=${threadTs}`,
  );

  await addEyes(event.channel, event.ts);
  try {
    const sessionId = sessionIdFor(threadTs);
    const vm = await vmForThread(sessionId);
    await invokeAgent(
      vm,
      sessionId,
      stripMention(event.text ?? ""),
      slack,
      invokeDeadline,
    );
  } catch (e) {
    // This is the "eyes but no reply" case. The agent can't apologize — it never ran — so say it here.
    console.error(`[event] could not reach the agent ts=${event.ts}:`, e);
    const posted = await slackCall("chat.postMessage", {
      channel: event.channel,
      thread_ts: threadTs,
      text: ":warning: I couldn't start on that — please mention me again to retry.",
      unfurl_links: false,
    }).catch((err) => ({ ok: false, error: String(err) }));
    if (!posted.ok)
      console.error("[event] failure notice ALSO failed:", posted.error);
  }

  return { statusCode: 200, body: "ok" };
}
