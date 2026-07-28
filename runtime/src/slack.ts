// The Slack calls the RUNTIME itself makes: thread status reactions, and a fallback message when a
// turn dies. Everything the AGENT does in Slack lives in slack-tools.ts, which builds on this.
//
// Why the runtime owns status at all: a reaction that lies is worse than no reaction. If the agent
// were solely responsible for clearing 🟡, a crash or a forgotten final tool call would leave a thread
// looking busy forever. So the runtime sets 🟡 before the turn and always attempts a terminal 🟢/🔴 after
// it, whatever happens. Slack itself can still refuse a reaction (rate limit, missing scope); the sweep
// removes the stale ones first, so a refused add leaves the message with NO status colour rather than a
// wrong one, and emits slack_status_warning.
import { SLACK_API_BASE } from "./config.js";
import { emit } from "./emit.js";

/** Per-call ceiling for a Slack request. Reactions and posts are small; a slow one is a stalled one. */
const SLACK_TIMEOUT_MS = 8_000;

/** The four status reactions. Mutually exclusive: setting one clears the others. */
export const STATUS_EMOJI = {
  working: "large_yellow_circle",
  waiting: "question",
  done: "large_green_circle",
  failed: "red_circle",
} as const;

export type ThreadStatus = keyof typeof STATUS_EMOJI;

/** The Slack ids the trigger Lambda passes through on the invocation payload. */
export interface SlackTarget {
  channel_id: string;
  thread_ts: string;
  trigger_message_ts?: string;
  slack_user_id?: string;
  /**
   * Later mentions folded into this same turn (see deliver() in agent.ts). Each one got a 👀 from the
   * ingress, so each needs the terminal reaction too — otherwise a correction sits on a bare 👀 while the
   * turn it joined goes 🟢 on the first message, and the person who corrected it sees no acknowledgement.
   */
  alsoReactTo?: string[];
}

/** The status the runtime reports when it has no bot token, in both places that can detect it. */
export const NO_BOT_TOKEN = "SLACK_BOT_TOKEN unavailable";

/**
 * How many injected messages one turn will react to.
 *
 * BOUNDED on purpose. `setThreadStatus` reacts to every timestamp on every status change (4 Slack calls
 * each, looped serially), so the list is a multiplier on both latency and rate-limit pressure — and
 * `/terminate` has a hard, unraisable 60s budget it has to fit in. Reactions are also the least important
 * thing here: the injected message is answered in the same thread either way. Keep the most RECENT ones,
 * since the newest correction is the one someone is waiting on.
 */
const MAX_ALSO_REACT = 4;

/**
 * Fold a later mention's trigger message into an already-running turn's target, so the terminal reaction
 * lands on it too. De-duplicated (a mention can be delivered twice) and capped — see MAX_ALSO_REACT.
 */
export function alsoReactTo(target: SlackTarget, ts: string): void {
  const next = [...new Set([...(target.alsoReactTo ?? []), ts])];
  if (next.length > MAX_ALSO_REACT) {
    emit("also_react_capped", { dropped: next.length - MAX_ALSO_REACT, cap: MAX_ALSO_REACT });
  }
  target.alsoReactTo = next.slice(-MAX_ALSO_REACT);
}

/**
 * Narrow an unknown payload field to a usable target — a malformed one must not break the turn.
 * `alsoReactTo` is deliberately NOT read from the payload: it's runtime-internal state, never wire input.
 */
export function asSlackTarget(value: unknown): SlackTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.channel_id !== "string" || typeof v.thread_ts !== "string") return undefined;
  return {
    channel_id: v.channel_id,
    thread_ts: v.thread_ts,
    ...(typeof v.trigger_message_ts === "string" ? { trigger_message_ts: v.trigger_message_ts } : {}),
    ...(typeof v.slack_user_id === "string" ? { slack_user_id: v.slack_user_id } : {}),
  };
}

/** A Slack API response. `ok:false` always carries a usable `error` — see the normalisation below. */
export type SlackResponse = { ok?: boolean; error?: string; [k: string]: unknown };

/**
 * The ONE way this codebase talks to Slack. POST with `body`, GET with `params`.
 *
 * Guarantees two things every caller relies on: a request can't hang forever (fetch has no default
 * timeout — one stall measured at 300s, and a status sweep is 8 calls), and a failure always carries a
 * non-empty `error` string, so no caller can return `{error: undefined}` — neither an error nor a
 * success, which is the one shape the tools' contract forbids.
 */
export async function slackCall(
  method: string,
  args: { body?: Record<string, unknown>; params?: Record<string, string> } = {},
): Promise<SlackResponse> {
  const token = process.env.SLACK_BOT_TOKEN;
  // No token means a local or direct test invoke: report it rather than throwing on every call.
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN is not set" };
  try {
    const query = args.params ? `?${new URLSearchParams(args.params)}` : "";
    const res = await fetch(`${SLACK_API_BASE}/${method}${query}`, {
      method: args.body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(args.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      ...(args.body ? { body: JSON.stringify(args.body) } : {}),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const parsed = ((await res.json().catch(() => ({}))) ?? {}) as SlackResponse;
    if (parsed.ok) return parsed;
    const error = typeof parsed.error === "string" && parsed.error ? parsed.error : `Slack returned HTTP ${res.status}`;
    return { ...parsed, ok: false, error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Move the thread to one status, clearing the other three first so two never show at once.
 *
 * Applied to BOTH the thread parent and the triggering message, since a mention deep in a thread is
 * where the person is looking. 👀 is deliberately left alone — it's the acknowledgement, not a status.
 * Best-effort throughout: a failed reaction must never take down a turn that otherwise worked.
 *
 * Not serialized here, and doesn't need to be: the tool callers hold the per-turn lock, and the
 * runtime's own calls (server.ts) are strictly before or after the model runs. So no two can overlap.
 */
export async function setThreadStatus(target: SlackTarget, status: ThreadStatus): Promise<boolean> {
  // The turn's OWN messages — the thread and the mention that started it. The return value speaks for
  // these only.
  const own = [...new Set([target.thread_ts, target.trigger_message_ts].filter((t): t is string => Boolean(t)))];
  // Plus courtesy reactions on mentions folded into this turn. A rate limit on one of THOSE must not
  // report the status as failed: the caller turns a false into "I may not have finished everything",
  // which is a confusing warning under a turn that succeeded and is correctly marked on its own message.
  const timestamps = [...new Set([...own, ...(target.alsoReactTo ?? [])])];
  let ok = true;

  for (const [index, timestamp] of timestamps.entries()) {
    // The three removes are independent, so run them together — sequentially they were 3× the
    // latency on the path that blocks the start of every turn.
    const stale = Object.entries(STATUS_EMOJI).filter(([name]) => name !== status);
    const removed = await Promise.all(
      stale.map(([, emoji]) => slackCall("reactions.remove", { body: { channel: target.channel_id, timestamp, name: emoji } })),
    );
    removed.forEach((r, i) => {
      // no_reaction just means it wasn't set — the common case, not a problem.
      if (!r.ok && !["no_reaction", "message_not_found"].includes(r.error ?? "")) {
        emit("slack_status_warning", { method: "reactions.remove", emoji: stale[i]?.[1], error: r.error });
      }
    });

    const added = await slackCall("reactions.add", { body: { channel: target.channel_id, timestamp, name: STATUS_EMOJI[status] } });
    if (!added.ok && !["already_reacted"].includes(added.error ?? "")) {
      if (index < own.length) ok = false;
      emit("slack_status_warning", { method: "reactions.add", status, error: added.error, timestamp });
    }
  }

  emit("thread_status", { status, emoji: STATUS_EMOJI[status], channel: target.channel_id, ok });
  return ok;
}

/** Post to the thread. Used ONLY for the runtime's failure fallback — the agent has reply_to_thread. */
export async function postMessage(target: SlackTarget, text: string): Promise<boolean> {
  const r = await slackCall("chat.postMessage", {
    body: { channel: target.channel_id, thread_ts: target.thread_ts, text, unfurl_links: false },
  });
  if (!r.ok) emit("slack_post_failed", { error: r.error });
  return Boolean(r.ok);
}
