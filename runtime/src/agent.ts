// The agent: one Strands Agent on one model (Claude Opus 5 via Bedrock, eu-west-1).
import { existsSync } from "node:fs";

import {
  AfterToolCallEvent,
  AfterToolsEvent,
  Agent,
  BedrockModel,
  BeforeModelCallEvent,
  BeforeToolsEvent,
  ContextWindowOverflowError,
  Message,
  NullConversationManager,
  TextBlock,
} from "@strands-agents/sdk";
import { AgentSkills } from "@strands-agents/sdk/vended-plugins/skills";

import {
  AGENT_NAME,
  MAX_TOKENS,
  MAX_TURNS,
  MODEL_ID,
  REGION,
  SKILLS_DIR,
} from "./config.js";
import { emit } from "./emit.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  SLACK_TOOLS,
  declarePending,
  finishPending,
  isWaiting,
  postFailedThisBatch,
} from "./slack-tools.js";
import type { SlackTurn } from "./slack-tools.js";
import { ALL_TOOLS } from "./tools.js";

const TOOLS = [...ALL_TOOLS, ...SLACK_TOOLS];

/**
 * Messages that arrived while a turn was already running, per session.
 *
 * A mention mid-task is usually a course correction ("stop, wrong repo") — worthless if the agent only
 * sees it after finishing. So instead of queueing the mention as its own turn, the runtime drops it here
 * and a BeforeModelCallEvent hook folds it into the conversation before the next model call. The agent
 * can't miss it, and there's no cancellation to reason about: it simply learns something new mid-thought.
 */
const inboxes = new Map<string, string[]>();

/** Hand a message to a session's running turn. Called by server.ts when a turn is already in flight. */
export function deliver(sessionId: string, text: string): void {
  const inbox = inboxes.get(sessionId);
  if (inbox) inbox.push(text);
  else inboxes.set(sessionId, [text]);
}

/**
 * Take anything still undelivered for a session, emptying the inbox.
 *
 * A message can arrive after the LAST model call of a turn but before the turn is marked finished — the
 * hook never fires again, so it would be accepted and then silently lost, which is the worst outcome for
 * a correction ("STOP, wrong repo" swallowed, no answer, no error). server.ts drains at the end of every
 * turn and runs the leftovers as a follow-up turn instead.
 */
export function drain(sessionId: string): string[] {
  const inbox = inboxes.get(sessionId) ?? [];
  inboxes.delete(sessionId);
  return inbox;
}

/**
 * Messages handed to the model but not yet survived by a completed model call.
 *
 * Exists because delivery and crash-recovery destroyed each other. `BeforeModelCallEvent` splices the
 * inbox EMPTY and pushes the text into `agent.messages` — so that push is the only copy — and if the next
 * model call throws, `runTurn`'s catch truncates `agent.messages` back to `historyLength` and takes the
 * correction with it. `drain()` then finds nothing, no follow-up turn is queued, and the person is told
 * "mention me again to retry" — where a retry re-runs the ORIGINAL request their correction was
 * cancelling. agent.ts's own header calls an unanswered correction the worst outcome; this closes the one
 * path that produced it.
 */
const inFlight = new Map<string, string[]>();

/** Put delivered-but-unanswered messages back in the inbox, so the crash path can requeue them. */
export function restoreInFlight(sessionId: string): void {
  const pending = inFlight.get(sessionId);
  if (!pending?.length) return;
  inFlight.delete(sessionId);
  const inbox = inboxes.get(sessionId);
  // Unshift: these arrived BEFORE anything the inbox has picked up since.
  if (inbox) inbox.unshift(...pending);
  else inboxes.set(sessionId, [...pending]);
  emit("in_flight_restored", { session_id: sessionId, count: pending.length });
}

/** Delivery survived a model call, so it can no longer be lost by a truncation. */
export function clearInFlight(sessionId: string): void {
  inFlight.delete(sessionId);
}

export function buildAgent(sessionId: string): Agent {
  const agent = new Agent({
    name: AGENT_NAME,
    model: new BedrockModel({
      modelId: MODEL_ID,
      region: REGION,
      maxTokens: MAX_TOKENS,
      // Caches the tools + growing conversation prefix each turn — a long Slack thread re-reads
      // most of its context from cache instead of paying for it again.
      cacheConfig: { strategy: "auto" },
    }),
    // No `toolExecutor`, so tools run CONCURRENTLY (the SDK default) — deliberately, and this design
    // depends on it both ways round. A three-command fan-out measured 13.7s concurrent vs 21.3s
    // sequential end-to-end, because the agent's fan-out tool is run_bash (greps, `gh api`, log queries),
    // not local file reads. And `settleDeclaredPosts` waits for a SIBLING call while holding its own tool
    // slot, so `toolExecutor: "sequential"` would DEADLOCK a turn that lists set_thread_status before its
    // reply. Don't change the executor without removing that gate first.
    tools: TOOLS as never,
    // Skills are progressive disclosure: the plugin lists each skill's name + description in the
    // prompt and exposes a `skills` tool that loads the full instructions on demand. So the github
    // recipe costs one line of context until the agent actually needs it. (Slack is NOT a skill —
    // it's structured tools, so the reply path can't depend on the model shelling out correctly.)
    plugins: existsSync(SKILLS_DIR)
      ? [new AgentSkills({ skills: [SKILLS_DIR] })]
      : [],
    systemPrompt: buildSystemPrompt(),
    printer: false,
    // Full, verbatim history — no sliding window, no summarization. Without this the SDK defaults to
    // SlidingWindowConversationManager(40), which silently evicts the oldest turns once a thread
    // passes 40 messages; since a Slack thread reuses one Agent for 8h, that would quietly cap what
    // a long conversation remembers. There's no snapshot store to hit a size limit on (memory lives
    // in-process only), so the real ceiling is the model's context window — and if a thread ever
    // overflows it, runAgent below fails LOUDLY rather than returning a blank reply.
    conversationManager: new NullConversationManager(),
  });

  // Fold in anything the human sent mid-turn, before the model thinks again.
  agent.addHook(BeforeModelCallEvent, (event) => {
    const pending = inboxes.get(sessionId);
    if (!pending?.length) return;
    const messages = pending.splice(0);
    // Keep a copy until a model call completes: the splice above leaves the push below as the ONLY copy,
    // and a throw in that call truncates it away. See inFlight/restoreInFlight.
    inFlight.set(sessionId, messages);
    emit("message_delivered", {
      session_id: sessionId,
      count: messages.length,
    });
    // Labelled so the model can tell a live interruption from its own earlier reasoning, and told
    // plainly that it may override the original request — that's the whole point of interrupting.
    event.agent.messages.push(
      new Message({
        role: "user",
        content: [
          new TextBlock(
            `[The teammate sent this while you were working — it is newer than the request above and ` +
              `may change or cancel it]\n${messages.join("\n")}`,
          ),
        ],
      }),
    );
  });

  // Record which tools the model asked for BEFORE any of them runs, and release each one as it ends.
  //
  // set_thread_status needs to know whether a reply is COMING, not just whether one is in flight —
  // otherwise it warns "the human has seen NOTHING" about a reply about to succeed. That's a fact in the
  // model's message, read synchronously here, rather than something to infer from timing.
  //
  // Declaring and releasing belong together, in hooks, because the release must happen on EVERY path.
  // Releasing from inside the tools looked equivalent and wasn't: a declared reply whose arguments fail
  // schema validation never runs its body, so its gate never opened and the whole turn hung on 🟡 until
  // the microVM was reaped. AfterToolCallEvent fires however a call ended — validation failure, a hook
  // cancelling it, an unknown tool, a throw — so it cannot be skipped.
  agent.addHook(BeforeToolsEvent, (event) => {
    const turn = (
      event.invocationState as { slackTurn?: SlackTurn } | undefined
    )?.slackTurn;
    if (!turn) return;
    const blocks = (event.message?.content ?? []) as Array<{
      type?: string;
      name?: string;
      toolUseId?: string;
    }>;
    turn.pending.clear();
    // Per-batch, so an earlier progress update can't be mistaken for an answer to a question asked now.
    turn.deliveredThisBatch = 0;
    turn.failedPosts = 0;
    for (const b of blocks) {
      if (b.type === "toolUseBlock" && b.name && b.toolUseId)
        declarePending(turn, b.toolUseId, b.name);
    }
  });

  agent.addHook(AfterToolCallEvent, (event) => {
    const turn = (
      event.invocationState as { slackTurn?: SlackTurn } | undefined
    )?.slackTurn;
    // `status === "error"` is how the SDK reports a call that never produced a result — a schema
    // rejection, a throw, a cancellation. A tool that RAN and returned `{error: …}` is a normal result
    // to the SDK, so each posting tool records its own outcome (`turn.failedPosts`) under the lock; this
    // hook only has to catch the calls that never got that far.
    if (turn)
      finishPending(
        turn,
        event.toolUse.toolUseId,
        event.result.status !== "error",
      );
  });

  // ENFORCE the turn ending rather than trusting the prompt to: `ask_user` and `set_thread_status` both
  // claim to finish the turn, and endTurn is what makes that true.
  //
  // It requires a delivered reply as well as a terminal status, and that conjunct is load-bearing — on a
  // status alone it would halt before the model could act on set_thread_status's "you have not posted
  // anything" recovery, losing the answer entirely.
  agent.addHook(AfterToolsEvent, (event) => {
    const turn = (
      event.invocationState as { slackTurn?: SlackTurn } | undefined
    )?.slackTurn;
    if (!turn) return;
    // A post Slack REFUSED must not end the turn: the model sees the error in its tool result but needs
    // another round to act on it. Ending here lost the message silently — a rejected reply alongside a
    // successful sibling still went 🟢 and the runtime reported the turn as a success.
    if (postFailedThisBatch(turn)) return;
    if (isWaiting(turn))
      event.endTurn = "Waiting for the teammate to reply in Slack.";
    else if (
      turn.replied &&
      (turn.status === "done" || turn.status === "failed")
    ) {
      event.endTurn = "Thread status is terminal.";
    }
  });

  emit("session_start", {
    session_id: sessionId,
    agent: AGENT_NAME,
    model_id: MODEL_ID,
    tool_count: TOOLS.length,
  });
  return agent;
}

/**
 * Run one turn to completion, emitting a structured log line per model message and tool result.
 * Returns the agent's final text — which is for the LOGS, not the user: the user only ever sees
 * what the agent posts to Slack itself.
 */
export async function runAgent(
  agent: Agent,
  prompt: string,
  sessionId: string,
  slackTurn?: SlackTurn,
): Promise<{ text: string; stopReason?: string }> {
  let finalText = "";
  let stopReason: string | undefined;
  // The Slack tools read `slackTurn` from here rather than from a module global, so the ids reaching
  // a tool always belong to the message being handled (see slack-tools.ts).
  const stream = agent.stream(prompt as never, {
    invocationState: { session_id: sessionId, slackTurn },
    // A safety ceiling on one turn. Without it a model stuck retrying a failing tool runs until the
    // microVM dies, spending tokens with only 👀/🟡 visible — the runtime guarantees a terminal
    // reaction, not a bounded cost. Generous: real coding turns use a few dozen.
    limits: { turns: MAX_TURNS },
  });

  try {
    for await (const event of stream) {
      const ev = event as {
        type?: string;
        message?: {
          content?: Array<{
            type?: string;
            text?: string;
            name?: string;
            toolUseId?: string;
            input?: unknown;
          }>;
        };
        result?: {
          toolUseId?: string;
          content?: unknown[];
          stopReason?: string;
        };
      };

      // Why the loop ended. `limitTurns` means we hit MAX_TURNS, which otherwise looks identical to a
      // turn that simply finished — so the runtime would tell the human "I finished working but didn't
      // post an answer", which is false on both halves, with nothing in the logs naming the cap.
      if (ev.type === "agentResultEvent" && ev.result?.stopReason) {
        stopReason = ev.result.stopReason;
        emit("stop_reason", { session_id: sessionId, stop_reason: stopReason });
      }

      if (ev.type === "modelMessageEvent") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "textBlock" && block.text) {
            emit("text", { session_id: sessionId, content: block.text });
            finalText = block.text; // last assistant text wins
          } else if (block.type === "toolUseBlock" && block.name) {
            emit("tool_input", {
              session_id: sessionId,
              name: block.name,
              tool_use_id: block.toolUseId,
              input: block.input ?? {},
            });
          }
        }
      } else if (ev.type === "toolResultEvent" && ev.result) {
        emit("tool_result", {
          session_id: sessionId,
          tool_use_id: ev.result.toolUseId,
          result: serializeToolResult(ev.result.content ?? []).slice(0, 4000),
        });
      }
    }
  } catch (e) {
    if (e instanceof ContextWindowOverflowError) {
      // NullConversationManager never trims, so this is unrecoverable for this thread — a retry hits
      // the same wall. The agent never got a turn, so it can't apologize in Slack itself; this
      // grep-able line is the only signal. Rethrow so the caller surfaces it as a hard error too.
      console.error(
        `[ALERT] context-window-overflow session="${sessionId}" messages=${agent.messages.length} — ` +
          `conversation exceeded the model's context window (no auto-trim). Start a fresh thread to recover.`,
      );
      emit("stream_error", {
        session_id: sessionId,
        error: e.message,
        alert: "context_window_overflow",
      });
      throw e;
    }
    // RETHROW rather than returning quietly. A swallowed stream error looks to the caller like a turn
    // that simply had nothing to say, so the thread would get the misleading "I finished working but
    // didn't post an answer" instead of "I hit an error" — and the real cause would only be in the
    // logs. Let server.ts own the apology and the 🔴.
    emit("stream_error", {
      session_id: sessionId,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  return { text: finalText, stopReason };
}

function serializeToolResult(content: unknown[]): string {
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      const b = block as { text?: unknown; json?: unknown };
      if (b?.text !== undefined) return String(b.text);
      if (b?.json !== undefined) return JSON.stringify(b.json);
      return JSON.stringify(block);
    })
    .join("");
}
