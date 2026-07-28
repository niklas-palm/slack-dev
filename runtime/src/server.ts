// The in-VM server: Lambda MicroVM lifecycle hooks + the /invoke surface the ingress Lambda calls.
//
// We own the whole image, so this is a plain `node:http` server — no runtime SDK, no contract beyond
// answering the hook paths Lambda POSTs to. See docs/lambda-microvms.md for the mechanics.
//
// ONE microVM PER SLACK THREAD. The ingress Lambda routes a thread to its VM (a DynamoDB lookup), so
// every message in a thread lands here, where the Agent — and its full conversation — stays in memory
// for the life of the VM. Follow-ups therefore have complete context with no snapshot storage; if the
// VM is reaped, the next mention starts a fresh one.
//
// A Strands Agent is not concurrency-safe (it mutates its own message list), so runs for one session
// are SERIALIZED through a promise chain. That also preserves message order within a thread.
import { createServer } from "node:http";

import { type Agent, ContextWindowOverflowError } from "@strands-agents/sdk";

import { buildAgent, deliver, drain, runAgent } from "./agent.js";
import { HOOK_PORT } from "./config.js";
import { emit } from "./emit.js";
import { loadSecretsFromSsm } from "./secrets.js";
import { postMessage, setThreadStatus } from "./slack.js";
import {
  type SlackTurn,
  isWaiting,
  newSlackTurn,
  slackTurnFromPayload,
} from "./slack-tools.js";

const agents = new Map<string, Agent>();
const chains = new Map<string, Promise<unknown>>();

/** Sessions with a turn in flight, so a new mention knows to inject rather than queue. */
const running = new Set<string>();

/** The Slack thread each in-flight turn belongs to, so /terminate can tell it the VM is going away. */
const turns = new Map<string, SlackTurn>();

/** Where Lambda POSTs the lifecycle hooks. */
const HOOK_BASE = "/aws/lambda-microvms/runtime/v1";

/**
 * Handle one incoming mention: inject into a running turn, or queue a new one.
 *
 * Returns immediately either way — the work takes minutes and the caller is a Lambda on Slack's 3s
 * clock. Progress and the answer reach the human through the agent's own Slack tools.
 */
function handleInvoke(body: Record<string, unknown>): Record<string, unknown> {
  const sessionId = String(body.sessionId ?? body.session_id ?? "default");
  const raw = body.prompt;
  const text =
    typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";
  if (!text) return { status: "rejected", error: "missing 'prompt' in payload" };

  // The Slack ids go into per-turn STATE that the Slack tools read — never into the prompt. The model
  // therefore has no way to name a channel, so it can only ever reply where it was summoned.
  const slackTurn = slackTurnFromPayload(body.slack);

  // A mention that arrives while this session is already working is INJECTED into the running turn
  // rather than queued behind it — that's the difference between "stop, wrong repo" landing in time
  // and landing after the PR is open. See deliver() in agent.ts.
  if (running.has(sessionId)) {
    deliver(sessionId, text);
    emit("message_injected", { session_id: sessionId, chars: text.length });
    return { status: "injected", session_id: sessionId };
  }

  void queue(sessionId, text, slackTurn).catch(reportError);
  return { status: "accepted", session_id: sessionId };
}

function queue(
  sessionId: string,
  prompt: string,
  slackTurn?: SlackTurn,
): Promise<unknown> {
  // Synchronously, BEFORE the chain: the caller decides inject-vs-queue by reading this set, and doing
  // it inside the .then() left a microtask window where two mentions in the same tick both saw it empty
  // — so a correction became its own queued turn instead of reaching the turn it was correcting.
  running.add(sessionId);
  if (slackTurn) turns.set(sessionId, slackTurn);
  const next = (chains.get(sessionId) ?? Promise.resolve())
    .then(async () => {
      try {
        return await runTurn({ sessionId, prompt, slackTurn });
      } finally {
        running.delete(sessionId);
        turns.delete(sessionId);
        // A message can land after the turn's last model call, when the injection hook will never fire
        // again. Run whatever is left as its own turn rather than dropping it — an unanswered correction
        // is the one outcome this feature must never produce.
        const late = drain(sessionId);
        if (late.length) {
          emit("late_messages_requeued", {
            session_id: sessionId,
            count: late.length,
          });
          // A FRESH turn on the same thread, never the finished one. Reusing it carried over `posted`
          // (so a reply repeating turn 1's text was dropped as a duplicate) plus `replied`/`status`
          // (so the runtime saw a clean success and warned nobody) — the correction vanished silently,
          // which is the exact failure this drain exists to prevent.
          void queue(
            sessionId,
            late.join("\n"),
            slackTurn && newSlackTurn(slackTurn.target),
          );
        }
      }
    })
    .catch(reportError);
  chains.set(sessionId, next);
  return next;
}

/**
 * One turn, with the thread-status protocol enforced AROUND the model rather than delegated to it.
 *
 * 👀 is already on the message (the ingress Lambda). Here the runtime sets 🟡 before the turn and
 * always attempts a terminal 🟢/🔴 after it — because a reaction that lies is worse than no reaction, and an
 * agent that crashes or forgets its final tool call would otherwise leave a thread looking busy
 * forever. The agent still owns the MEANING (done vs failed vs waiting); the runtime only ensures the
 * thread never ends up stuck on 🟡.
 */
async function runTurn(args: {
  sessionId: string;
  prompt: string;
  slackTurn?: SlackTurn;
}): Promise<void> {
  const { slackTurn } = args;
  if (slackTurn) {
    slackTurn.status = "working";
    await setThreadStatus(slackTurn.target, "working");
  }

  const agent = ensureAgent(args.sessionId);
  // Strands appends the user message BEFORE calling the model and doesn't roll it back when the call
  // throws. Since the Agent is cached for the whole session, one ThrottlingException would otherwise
  // leave an orphaned `user` message that every later turn re-sends — junk that accumulates forever
  // and that NullConversationManager will never trim.
  const historyLength = agent.messages.length;

  try {
    const { text: answer, stopReason } = await runAgent(
      agent,
      args.prompt,
      args.sessionId,
      slackTurn,
    );
    emit("session_end", {
      session_id: args.sessionId,
      answer,
      stop_reason: stopReason,
      replied: slackTurn?.replied ?? null,
    });
    // Hitting MAX_TURNS ends the stream normally, so without this the fallback below would claim
    // "I finished working" about a turn that was cut off mid-task, and invite a retry that burns the
    // same budget again.
    const hitLimit = stopReason === "limitTurns";

    if (!slackTurn) return;

    // Waiting is a legitimate non-terminal end state — but only if the question really is unanswered.
    // A reply in the same batch wins: ask_user waits for it and skips ❓ when it delivered, so an
    // answered question can't strand the thread.
    if (isWaiting(slackTurn)) return;

    // A turn is only a success if the human got something AND the agent said how it ended. Either
    // half alone is a failure: no reply means an unanswered 👀; a reply with no terminal status is
    // usually a turn that posted "Looking into X…" and then stopped — auto-closing that as 🟢 would
    // paint an unfinished task green, which is worse than leaving it visibly stuck.
    const closed = slackTurn.status === "done" || slackTurn.status === "failed";
    if (!slackTurn.replied || !closed) {
      emit("incomplete_turn", {
        session_id: args.sessionId,
        replied: slackTurn.replied,
        status: slackTurn.status,
        stop_reason: stopReason,
      });
      await postMessage(
        slackTurn.target,
        hitLimit
          ? ":warning: I hit my work limit for one turn and stopped part-way. Mention me again to continue — narrowing the request helps."
          : slackTurn.replied
            ? // It DID answer — say only what we actually know, which is that it never confirmed it had
              // finished. Claiming "the work above may be incomplete" under a good answer reads as a
              // failure and invites the human to re-run work that was already done.
              ":warning: I may not have finished everything — I didn't mark this thread complete. Mention me again if something's missing."
            : ":warning: I finished working but didn't manage to post an answer. Please mention me again to retry.",
      );
      await setThreadStatus(slackTurn.target, "failed");
    }
  } catch (err) {
    // The turn died. The agent can't apologize, so the runtime does it and marks the thread 🔴.
    reportError(err);
    agent.messages.length = historyLength; // drop the orphaned user message (see above)

    // A context-window overflow is permanent for this session: the history is already too long, so
    // every retry hits the same wall. Drop the Agent so a follow-up mention starts clean instead of
    // failing identically forever — the posted message tells them to try again, so it must work.
    if (err instanceof ContextWindowOverflowError)
      agents.delete(args.sessionId);

    if (slackTurn) {
      // ALWAYS post, even if the agent already said something: a bare 🔴 under a "Looking into X…"
      // leaves the human to guess whether it finished, and the reason is only in CloudWatch.
      await postMessage(
        slackTurn.target,
        ":warning: I hit an error working on that. Please mention me again to retry.",
      );
      await setThreadStatus(slackTurn.target, "failed");
    }
  }
}

/** The session's Agent, built on first use and kept for the life of the microVM (see the header). */
function ensureAgent(sessionId: string): Agent {
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = buildAgent(sessionId);
    agents.set(sessionId, agent);
  }
  return agent;
}

function reportError(err: unknown): void {
  // Every invocation is fire-and-forget, so this is the ONLY signal that a run died — it's how the
  // "eyes but no reply" failure class becomes visible at all.
  emit("error", {
    error: err instanceof Error ? err.message : String(err),
    trace: err instanceof Error && err.stack ? err.stack : "",
  });
}

async function readJson(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the SSM secrets onto process.env, once per VM (`/run` is delivered at least once, and
 * `/resume` may fire many times). `force` re-reads them, which is how a rotation reaches a long-lived VM.
 */
let secretsLoaded = false;
async function ensureSecrets(force = false): Promise<void> {
  if (secretsLoaded && !force) return;
  try {
    await loadSecretsFromSsm();
    secretsLoaded = true;
  } catch (err) {
    // Don't latch on failure — the next hook should try again rather than run without credentials.
    emit("secrets_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const server = createServer((req, res) => {
  const send = (code: number, obj: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const path = new URL(req.url ?? "/", "http://vm").pathname;

  void (async () => {
    try {
      // --- Lambda lifecycle hooks ---------------------------------------------------------------
      //
      // `ready` fires once, at IMAGE BUILD time, and 200 is the signal to snapshot. Everything slow
      // (npm install, the skills, the tools) is already baked by the Dockerfile, and the agent itself
      // needs no warming — it holds no connection until the first turn. So this is genuinely
      // instant, and the snapshot captures a process already listening.
      if (path === `${HOOK_BASE}/ready` && req.method === "POST") {
        return send(200, { ready: true });
      }
      // `run` fires PER VM, and it is the only place secrets can be read.
      //
      // This is not an optimization — it's the difference between a working agent and one that posts
      // nothing. The snapshot captures the whole process, including its environment, so anything read
      // at boot is read ONCE, at image-build time, with the BUILD role's credentials (which can't
      // decrypt SSM) and is then frozen into every VM. Reading here instead means the VM's own
      // execution role does it, a rotated secret lands on the next VM without an image rebuild, and no
      // secret is ever baked into a snapshot shared by every thread.
      if (path === `${HOOK_BASE}/run` && req.method === "POST") {
        await readJson(req); // the payload carries nothing we need; the prompt comes via /invoke
        await ensureSecrets();
        // Fail the hook if the agent can't talk to Slack. Slack is how EVERY other failure gets
        // reported, so without a token the agent works and the human sees only the 👀 — forever. A
        // non-200 here surfaces it as a VM that never came up, which the ingress reports.
        if (!process.env.SLACK_BOT_TOKEN) {
          console.error(
            "[ALERT] SLACK_BOT_TOKEN is not set — the agent cannot reply, react, or report failures. " +
              "Check SLACK_BOT_TOKEN_PARAM and that the microVM execution role may read + decrypt it.",
          );
          return send(500, { ok: false, error: "SLACK_BOT_TOKEN unavailable" });
        }
        return send(200, { ok: true });
      }
      if (path === `${HOOK_BASE}/resume` && req.method === "POST") {
        // Memory survives suspension, so the Agent and its conversation are still here. Re-read the
        // secrets anyway: a rotation while this VM slept would otherwise go unnoticed for its 8h life.
        await ensureSecrets(true);
        return send(200, { ok: true });
      }
      if (path === `${HOOK_BASE}/suspend` && req.method === "POST") {
        return send(200, { ok: true }); // nothing to flush; state lives in memory across suspend
      }
      // The VM is going away — at its 8h ceiling, or after too long suspended. Any turn in flight dies
      // with it, so the runtime's promise that a thread never ends on 🟡 would be broken: no reply, no
      // 🔴, just a busy-looking thread forever. Say so while there's still time (the hook has 60s).
      if (path === `${HOOK_BASE}/terminate` && req.method === "POST") {
        await Promise.all(
          [...running].map(async (sessionId) => {
            const turn = turns.get(sessionId);
            if (!turn) return;
            emit("terminated_mid_turn", { session_id: sessionId });
            await postMessage(
              turn.target,
              ":warning: My sandbox was reclaimed before I finished. Mention me again and I'll pick this up — I'll have lost the earlier context, so a one-line recap helps.",
            ).catch(() => undefined);
            await setThreadStatus(turn.target, "failed").catch(() => undefined);
          }),
        );
        return send(200, { ok: true });
      }

      // --- the agent surface -------------------------------------------------------------------
      if (path === "/invoke" && req.method === "POST") {
        return send(200, handleInvoke(await readJson(req)));
      }
      if (path === "/healthz") return send(200, { ok: true });
      send(404, { error: "not found" });
    } catch (err) {
      reportError(err);
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

// Serve immediately. Deliberately NO secret read here: this runs during the IMAGE BUILD, whose
// credentials are the build role's (no SSM, no KMS), and whatever the process holds at that moment is
// frozen into the snapshot every VM restores from. Secrets are read in `/run` instead — see there.
server.listen(HOOK_PORT, () => emit("server_listening", { port: HOOK_PORT }));
