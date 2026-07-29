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

import { buildAgent, clearInFlight, deliver, drain, restoreInFlight, runAgent } from "./agent.js";
import { HOOK_PORT } from "./config.js";
import { emit } from "./emit.js";
import { invokeGate } from "./invoke-gate.js";
import { loadSecretsFromSsm } from "./secrets.js";
import { alsoReactTo, NO_BOT_TOKEN, postMessage, setThreadStatus } from "./slack.js";
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
async function handleInvoke(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const sessionId = String(body.sessionId ?? body.session_id ?? "default");
  const raw = body.prompt;
  const text =
    typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";

  // One more read before refusing: /run's may have failed on a transient SSM/KMS error, and refusing a
  // turn the VM could serve is the worse outcome. Rules in invoke-gate.ts, where they're testable.
  if (!process.env.SLACK_BOT_TOKEN) await ensureSecrets({ retry: true });
  const gate = invokeGate(text, Boolean(process.env.SLACK_BOT_TOKEN));
  if (!gate.ok) {
    emit("invoke_refused", { session_id: sessionId, status: gate.status, error: gate.error });
    return { status: gate.status, body: { status: "rejected", error: gate.error } };
  }

  // A Slack payload naming a channel this agent may not post in is REFUSED here, loudly, rather than
  // silently yielding an undefined target. Getting that wrong is worse than the bug it guards: the target
  // would be undefined, `if (!slackTurn) return` below would skip every fallback, and a full model call
  // would run and be billed while the person sat on a bare 👀 for ever — no message, no colour, nothing.
  // A non-200 instead lets the INGRESS report the failure, which is the component that has the token.
  //
  // Note the two copies of the allowlist have different update paths (the ingress reads the CDK task env,
  // the runtime reads the baked image), so a skew is a live possibility — see docs/iterating.md.
  if (body.slack != null && !slackTurnFromPayload(body.slack)) {
    emit("invoke_refused", { session_id: sessionId, status: 403, error: "channel not allowed" });
    return { status: 403, body: { status: "rejected", error: "channel not allowed for this agent" } };
  }

  // The Slack ids go into per-turn STATE that the Slack tools read — never into the prompt. The model
  // therefore has no way to name a channel, so it can only ever reply where it was summoned.
  const slackTurn = slackTurnFromPayload(body.slack);

  // A mention that arrives while this session is already working is INJECTED into the running turn
  // rather than queued behind it — that's the difference between "stop, wrong repo" landing in time
  // and landing after the PR is open. See deliver() in agent.ts.
  if (running.has(sessionId)) {
    deliver(sessionId, text);
    // The injected mention has its OWN trigger message, and the running turn only knows the first one —
    // so a correction kept a bare 👀 for ever while the turn it joined went 🟢 on an older message.
    const live = turns.get(sessionId);
    const extra = slackTurn?.target.trigger_message_ts;
    if (live && extra) alsoReactTo(live.target, extra);
    emit("message_injected", { session_id: sessionId, chars: text.length });
    return { status: 200, body: { status: "injected", session_id: sessionId } };
  }

  void queue(sessionId, text, slackTurn).catch(reportError);
  return { status: 200, body: { status: "accepted", session_id: sessionId } };
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
            // Drop `alsoReactTo`: those timestamps belong to the turn that just ended and already carry
            // its terminal reaction. Inherited, they'd accumulate down a long thread and every later
            // status change would re-react to messages settled turns ago.
            slackTurn && newSlackTurn({ ...slackTurn.target, alsoReactTo: undefined }),
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
    // The run completed, so any injected correction was actually answered — drop the recovery copy, or
    // the drain in `finally` would requeue a message the agent has already dealt with.
    clearInFlight(args.sessionId);
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
    // That truncation also removes a correction the injection hook pushed in, and the hook already
    // emptied the inbox — so without this the only copy is gone and the finally block below drains
    // nothing. The person would be told to mention again, and the retry would re-run the very request
    // the correction was cancelling.
    restoreInFlight(args.sessionId);

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
 * Resolve the SSM secrets onto process.env, once per VM.
 *
 * `/run` is delivered at least once and `/resume` may fire many times, so this latches rather than
 * re-reading on every hook — but ONLY on a genuine success. A read that failed must stay un-latched so
 * the next hook retries it; latching regardless is what let a VM run its whole life mute after one
 * transient SSM error. `retry` forces an attempt even when latched (/invoke's last chance before it
 * refuses the turn).
 *
 * It never re-reads a var that IS set, so a mid-life rotation doesn't land — see the note printed by
 * scripts/put-secrets.sh. A VM lives at most 8h, so the next one picks it up.
 */
let secretsLoaded = false;
async function ensureSecrets({ retry = false }: { retry?: boolean } = {}): Promise<void> {
  if (secretsLoaded && !retry) return;
  const failed = await loadSecretsFromSsm().catch((err) => {
    emit("secrets_unavailable", { error: err instanceof Error ? err.message : String(err) });
    return ["*"];
  });
  if (failed.length) emit("secrets_unavailable", { targets: failed });
  else secretsLoaded = true;
}

/**
 * How long /terminate spends telling people their turn died, before answering the hook anyway.
 *
 * Comfortably inside the API's 60s ceiling for this hook: overrunning it means the handler is killed
 * mid-loop, so threads it hadn't reached yet get NOTHING — worse than a partial sweep.
 */
const TERMINATE_BUDGET_MS = 45_000;

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
          return send(500, { ok: false, error: NO_BOT_TOKEN });
        }
        return send(200, { ok: true });
      }
      if (path === `${HOOK_BASE}/resume` && req.method === "POST") {
        // Memory survives suspension, so the Agent and its conversation are still here. Still call this:
        // if the /run read FAILED, this is another chance before the next turn.
        await ensureSecrets();
        return send(200, { ok: true });
      }
      // A working turn generates no INBOUND traffic, so a long one can be suspended mid-flight and thaw
      // into a dead socket. Nothing in here can prevent it — log it so the symptom is diagnosable.
      // See docs/lambda-microvms.md#idle-suspend-and-lifetime.
      if (path === `${HOOK_BASE}/suspend` && req.method === "POST") {
        if (running.size > 0) emit("suspended_mid_turn", { sessions: [...running] });
        return send(200, { ok: true }); // nothing to flush; state lives in memory across suspend
      }
      // The VM is going away — at its 8h ceiling, or after too long suspended. Any turn in flight dies
      // with it, so the runtime's promise that a thread never ends on 🟡 would be broken: no reply, no
      // 🔴, just a busy-looking thread forever. Say so while there's still time.
      //
      // 60s is the API's MAXIMUM for this hook (terminateTimeoutInSeconds, min 1 / max 60), so there is
      // no headroom to buy if the work overruns — and the work is Slack calls, which can each take the
      // full 8s timeout. Sessions run concurrently, but within one the message and the status sweep are
      // serial, so a bad case is real. Race the whole thing against our own deadline and let the message
      // win: "your work died" is the part a person needs; the 🔴 is decoration on top of it.
      if (path === `${HOOK_BASE}/terminate` && req.method === "POST") {
        const notifyAll = Promise.all(
          [...running].map(async (sessionId) => {
            const turn = turns.get(sessionId);
            if (!turn) return;
            emit("terminated_mid_turn", { session_id: sessionId });
            await postMessage(
              turn.target,
              ":warning: My sandbox was reclaimed before I finished. Mention me again and I'll pick this up — I'll have lost the earlier context, so a one-line recap helps.",
            ).catch(() => undefined);
            // Terminal reaction on THIS turn's own messages only — courtesy reactions on folded-in
            // mentions are dropped here. setThreadStatus loops timestamps serially (4 calls each), so
            // with the alsoReactTo cap full one session can spend most of the 45s budget on reactions
            // while other sessions get no notice at all. The MESSAGE above is the part that matters;
            // this is the one path where the trade is clearly worth it.
            await setThreadStatus(
              { ...turn.target, alsoReactTo: undefined },
              "failed",
            ).catch(() => undefined);
          }),
        );
        const finished = await Promise.race([
          notifyAll.then(() => true),
          new Promise<false>((r) => setTimeout(() => r(false), TERMINATE_BUDGET_MS)),
        ]);
        // Returning before the sweep finishes is deliberate: a 200 now beats being killed mid-loop, which
        // is what left the remaining threads un-notified entirely.
        if (!finished) emit("terminate_notice_incomplete", { sessions: running.size });
        return send(200, { ok: true });
      }

      // --- the agent surface -------------------------------------------------------------------
      if (path === "/invoke" && req.method === "POST") {
        const result = await handleInvoke(await readJson(req));
        return send(result.status, result.body);
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
