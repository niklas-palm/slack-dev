// The agent's Slack tools: reply, ask, status, read, upload, download.
//
// These are real tools, not shell recipes, for three reasons:
//   1. SAFETY — the channel and thread come from the INVOCATION, never from the model. The agent
//      cannot post into a channel it wasn't summoned from, because it has no parameter to say so.
//   2. RELIABILITY — no shell quoting. A reply containing backticks, quotes, `$`, or newlines is just
//      a string argument; as a curl-in-bash recipe it was one bad quote away from a mangled message.
//   3. OBSERVABILITY — `replied` is tracked, so the runtime can tell whether the human actually heard
//      anything and fall back if not.
//
// Slack ids are read from `invocationState.slackTurn`, which server.ts puts there per turn. Per-turn
// state rather than a module global on purpose: the ids belong to one message, and threading them
// through the invocation keeps a later turn from ever replying into the wrong thread.
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { tool as strandsTool } from "@strands-agents/sdk";
import { z } from "zod";

import { WORKSPACE_DIR as WORKSPACE } from "./config.js";
import { emit } from "./emit.js";
import {
  type SlackResponse,
  type SlackTarget,
  asSlackTarget,
  slackCall,
  setThreadStatus,
} from "./slack.js";

// Same widening as tools.ts: the callbacks return discriminated unions that JSONValue rejects.
type ToolFactory = <S extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  inputSchema: S;
  callback: (
    input: z.infer<S>,
    ctx?: { invocationState?: Record<string, unknown> },
  ) => unknown;
}) => unknown;

const tool = strandsTool as unknown as ToolFactory;

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Per-turn Slack state. Tools run CONCURRENTLY, so ONE rule keeps this honest: every mutation a TOOL
 * makes happens inside `turn.lock` (see `withTurn`), together with the Slack call it describes. The
 * exception is `pending`, which no tool touches — agent.ts's hooks own both ends of it, outside the lock
 * and by design: its whole job is to be observable BEFORE the work enters the lock.
 *
 * `replied` is the load-bearing field — the runtime checks it to tell a real answer from a silent 👀.
 * Anything derivable is derived (see `isWaiting`) rather than stored, so two fields can't disagree.
 */
export interface SlackTurn {
  target: SlackTarget;
  replied: boolean;
  status: "working" | "waiting" | "done" | "failed" | null;
  /** A `set_thread_status` call has already failed, so we stop inviting a retry that can't succeed. */
  statusFailed: boolean;
  /** Dedupes identical posts within one turn, so a retrying model can't double-post. */
  posted: Map<string, string>;
  /** Serializes every state mutation for this turn. Never awaited from inside a locked section. */
  lock: Promise<unknown>;
  /**
   * The tools the model asked for in THIS batch, keyed by tool-use id — each a promise that settles when
   * that call finishes. Both ends live in agent.ts's hooks: BeforeToolsEvent declares, AfterToolCallEvent
   * settles. No tool touches it.
   *
   * `set_thread_status` has to know whether a reply is *coming*, not just whether one is already in
   * flight. Knowing the NAMES isn't enough: waiting on the turn lock only observes work that has already
   * entered it, so with `set_thread_status` declared first there was nothing to wait for and it warned
   * that nothing had been posted. Holding a promise per declared call removes the ordering question. Keyed
   * by id, not name, so a batch calling one tool twice gets two independent gates.
   */
  pending: Map<
    string,
    {
      name: string;
      done: Promise<void>;
      settle: (ok: boolean) => void;
      /** Whether the call succeeded. Undefined until it settles. */
      ok?: boolean;
    }
  >;
  /**
   * Replies + files DELIVERED by the batch running right now — reset by the BeforeToolsEvent hook.
   *
   * Per BATCH, not per turn: `posted` accumulates for the whole turn, so using it to answer "did the
   * model also reply in THIS batch?" meant one early progress update ("Looking into it…") disabled
   * `ask_user` for the rest of the turn — every later question posted with no ❓, and the runtime then
   * marked the thread 🔴 under an open question.
   */
  deliveredThisBatch: number;
  /** Posts this batch tried and Slack refused. Same batch scope as `deliveredThisBatch`. */
  failedPosts: number;
}

export function newSlackTurn(target: SlackTarget): SlackTurn {
  return {
    target,
    replied: false,
    status: null,
    posted: new Map(),
    deliveredThisBatch: 0,
    failedPosts: 0,
    statusFailed: false,
    lock: Promise.resolve(),
    pending: new Map(),
  };
}

/** True when the turn ended by asking the person something. Derived, so it can't contradict `status`. */
export function isWaiting(turn: SlackTurn): boolean {
  return turn.status === "waiting";
}

/**
 * Run `body` with exclusive access to this turn's Slack state.
 *
 * Serial by construction: each call chains onto the previous one, so a Slack request and the state write
 * describing it are never interleaved with another tool's. Callers must NOT nest.
 */
function withTurn<T>(turn: SlackTurn, body: () => Promise<T>): Promise<T> {
  const next = turn.lock.then(body);
  // Keep the chain usable after a rejection; the caller still receives the real error.
  turn.lock = next.catch(() => undefined);
  return next;
}

/** The tools that put something in front of the human, and so decide whether a status is truthful. */
const POSTING_TOOLS = new Set(["reply_to_thread", "upload_file"]);

/**
 * Wait for the posting tools this batch declared, so a status reaction is never judged before them.
 *
 * Never holds the lock, so it can't self-deadlock. Waits on the DECLARED work rather than the lock's
 * current contents — the lock only shows what has already entered it, which made this gate depend on the
 * order the model happened to list its tools in.
 */
async function settleDeclaredPosts(turn: SlackTurn): Promise<void> {
  const posting = [...turn.pending.values()].filter((p) =>
    POSTING_TOOLS.has(p.name),
  );
  await Promise.all(posting.map((p) => p.done));
}

/** Register a declared call so waiters can await it. Called once per call, before any body runs. */
export function declarePending(
  turn: SlackTurn,
  toolUseId: string,
  name: string,
): void {
  let settle = (_ok: boolean): void => {};
  const done = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  turn.pending.set(toolUseId, { name, done, settle });
}

/**
 * Release a declared call's gate, recording whether it succeeded. Called from a hook that fires however
 * the call ended, so `ok: false` covers a Slack rejection, a schema failure, and a throw alike.
 */
export function finishPending(
  turn: SlackTurn,
  toolUseId: string,
  ok: boolean,
): void {
  const entry = turn.pending.get(toolUseId);
  if (entry) {
    entry.ok = ok;
    entry.settle(ok);
  }
}

/**
 * Did a post in this batch FAIL? Then the turn must not end — the model needs another round to retry.
 *
 * Counts both a call Slack rejected (`failedPosts`, recorded by the tool itself) and one that never ran
 * at all (`ok === false`, recorded by the hook from the SDK's result status).
 */
export function postFailedThisBatch(turn: SlackTurn): boolean {
  return (
    turn.failedPosts > 0 ||
    [...turn.pending.values()].some(
      (p) => POSTING_TOOLS.has(p.name) && p.ok === false,
    )
  );
}

/** Pull this turn's SlackTurn out of the invocation state, if the turn came from Slack at all. */
function turnOf(ctx?: {
  invocationState?: Record<string, unknown>;
}): SlackTurn | undefined {
  const turn = ctx?.invocationState?.slackTurn;
  return turn && typeof turn === "object" ? (turn as SlackTurn) : undefined;
}

const NO_SLACK = {
  error: "this turn did not come from Slack, so there is no thread to act on",
  hint: "you were invoked directly for testing — just answer in your final message",
} as const;

// Thin named aliases over the one Slack helper in slack.ts, so each call site reads as POST or GET.
const slackApi = (
  method: string,
  body: Record<string, unknown>,
): Promise<SlackResponse> => slackCall(method, { body });
const slackGet = (
  method: string,
  params: Record<string, string>,
): Promise<SlackResponse> => slackCall(method, { params });

function scopeHint(error: string | undefined): string {
  if (error === "missing_scope" || error === "not_in_channel") {
    return "the bot needs the right scope and must be a member of the channel";
  }
  if (error === "not_authed" || error === "invalid_auth")
    return "the Slack bot token is missing or invalid";
  return "check the Slack error and adjust";
}

/**
 * Post once per distinct (kind, text) within a turn — a repeated call returns the first timestamp.
 *
 * Runs inside the turn lock, so the check-then-post and the `replied`/`status` writes it implies are
 * one atomic step. Two identical replies issued together can't both miss the dedupe map, and a reply
 * can't land in the middle of ask_user's reaction sweep.
 */
function postOnce(
  turn: SlackTurn,
  kind: string,
  text: string,
): Promise<{ ts?: string; duplicate: boolean; error?: string }> {
  return withTurn(turn, async () => {
    const key = `${kind} ${text}`;

    // A reply after ask_user means the agent answered rather than waited — leaving ❓ would strand the
    // thread. Belt-and-braces: ask_user already stands down for a reply in its batch, so this only
    // covers a tool invoked outside the hooks (as the tests do). A duplicate reply is still a reply.
    const clearWait = (): void => {
      if (kind === "reply" && turn.status === "waiting") turn.status = null;
    };

    // `has`, not truthiness: Slack can return ok without a `ts`, and "" read back as falsy disabled
    // the dedupe entirely.
    if (turn.posted.has(key)) {
      clearWait();
      return { ts: turn.posted.get(key), duplicate: true };
    }

    const r = await slackApi("chat.postMessage", {
      channel: turn.target.channel_id,
      thread_ts: turn.target.thread_ts,
      text,
      unfurl_links: false,
    });
    if (!r.ok) {
      // A refused post must keep the turn open (see postFailedThisBatch): the model sees this error in
      // its tool result, but only gets to act on it if endTurn doesn't fire first.
      if (kind === "reply") turn.failedPosts++;
      return { duplicate: false, error: r.error ?? "unknown Slack error" };
    }

    turn.posted.set(key, String(r.ts ?? ""));
    // A question is NOT an answer: counting it as `replied` let a question-only turn end 🟢 with the
    // "you have posted nothing" warning suppressed, and told the runtime it was a silent success.
    if (kind === "reply") {
      turn.replied = true;
      turn.deliveredThisBatch++;
    }
    clearWait();
    return { ts: String(r.ts ?? ""), duplicate: false };
  });
}

// --- tools -----------------------------------------------------------------

const replyToThread = tool({
  name: "reply_to_thread",
  description: `Post a message to the Slack thread you were summoned from. THIS IS HOW THE HUMAN HEARS FROM YOU.

Your assistant text reaches nobody — only what you post here. Use it for progress updates on long work,
and ALWAYS for your substantive answer.

Use Slack mrkdwn, not GitHub markdown: *bold* (single asterisks), _italic_, \`code\`, triple-backtick
blocks, <https://url|label> links, • or - bullets. NO # headings, NO **double asterisks**, NO tables.`,
  inputSchema: z.object({
    text: z.string().min(1).describe("The message, in Slack mrkdwn."),
  }),
  callback: async ({ text }, ctx) => {
    const turn = turnOf(ctx);
    if (!turn) return NO_SLACK;
    if (!text.trim()) return { error: "text must not be empty" };

    const r = await postOnce(turn, "reply", text);
    if (r.error) return { error: r.error, hint: scopeHint(r.error) };
    return { success: true, ts: r.ts, duplicate: r.duplicate };
  },
});

const setStatus = tool({
  name: "set_thread_status",
  description: `Set the thread's terminal status reaction. Make this your FINAL tool call.

Use "done" after you have successfully posted your answer, or "failed" after you have posted an
explanation of what went wrong. The four status reactions are mutually exclusive — this clears the
others. The 👀 acknowledgement stays. The runtime already set 🟡 working, so don't set that.`,
  inputSchema: z.object({
    status: z
      .enum(["done", "failed"])
      .describe('"done" on success, "failed" after explaining a failure.'),
  }),
  callback: async ({ status }, ctx) => {
    const turn = turnOf(ctx);
    if (!turn) return NO_SLACK;

    // Let any post declared in THIS batch finish before judging whether anything reached the human —
    // otherwise we warn about a reply that is about to succeed and the model posts a duplicate.
    await settleDeclaredPosts(turn);

    return withTurn(turn, async () => {
      const ok = await setThreadStatus(turn.target, status);
      // Record it ONLY if the reaction landed. Claiming a status Slack rejected tells the runtime the
      // thread is closed while it still shows 🟡 — a reaction that lies, which this protocol exists to
      // prevent. The sweep and this write share a critical section, so they can't describe different runs.
      if (!ok) {
        // "try again" only helps a TRANSIENT refusal. A permanent one (the message was deleted, or this VM
        // is serving a session id whose message never existed) fails identically for ever — and the model
        // dutifully obeyed the hint, so one turn called this three times on a `message_not_found`. Invite
        // one retry, then stop asking: the reply already landed, and the runtime marks the thread at the
        // end of the turn regardless, so a missing colour is not worth more of it.
        const hint = turn.statusFailed
          ? "do NOT retry — this failure is not transient. The runtime marks the thread when the turn ends. Carry on."
          : "try set_thread_status again, once. If it fails the same way, it is not transient.";
        turn.statusFailed = true;
        return {
          success: false,
          status,
          error: "Slack did not accept the reaction, so the thread still shows 🟡",
          hint,
        };
      }
      // Reset: a transient failure earlier in the turn must not make the FIRST failure of a later,
      // genuinely-retryable sequence look like the second. (Reachable via the set-before-reply path
      // below, which tells the model to set the status again.)
      turn.statusFailed = false;
      turn.status = status;
      // A status without a reply is the silent-success trap; tell the model plainly so it can fix it.
      if (!turn.replied) {
        return {
          success: true,
          status,
          warning:
            "you have not posted anything to the thread yet — the human has seen NOTHING",
          hint: "call reply_to_thread with your answer, then set the status again",
        };
      }
      return { success: true, status };
    });
  },
});

const askUser = tool({
  name: "ask_user",
  description: `Ask the person a question in the thread and end your turn waiting for their answer.

Posts the question, sets the ❓ waiting reaction, and finishes the turn — they must @-mention you again
to continue. Use this when a request is genuinely ambiguous or a decision is theirs to make, not to
confirm routine steps.

If Slack rejects the reaction this returns success:false and the turn does NOT end — call it again, or
answer and use set_thread_status if you'd rather finish.`,
  inputSchema: z.object({
    question: z.string().min(1).describe("The question, in Slack mrkdwn."),
  }),
  callback: async ({ question }, ctx) => {
    const turn = turnOf(ctx);
    if (!turn) return NO_SLACK;
    if (!question.trim()) return { error: "question must not be empty" };

    const r = await postOnce(turn, "question", question);
    if (r.error) return { error: r.error, hint: scopeHint(r.error) };

    // If the model ALSO replied in this batch, that reply is the real answer and wins — don't leave the
    // thread waiting on a question the agent went on to answer itself. But wait for it and check it
    // SUCCEEDED: deferring to a reply that failed left a question with no ❓ and no terminal reaction.
    await settleDeclaredPosts(turn);
    if (turn.deliveredThisBatch > 0) {
      return {
        success: true,
        ts: r.ts,
        duplicate: r.duplicate,
        waiting: false,
        note: "you also replied in this batch, so the thread is not left waiting",
      };
    }

    return withTurn(turn, async () => {
      const ok = await setThreadStatus(turn.target, "waiting");
      if (!ok) {
        // The QUESTION landed — only the ❓ didn't. So never say "call ask_user again": that re-posts the
        // question (dedupe keys on the text, so a reworded one gets through), and on a permanent refusal
        // it loops for ever. Same lesson as set_thread_status above: our hint drove the loop.
        turn.statusFailed = true;
        return {
          success: false,
          ts: r.ts,
          error: "the question posted, but Slack did not accept the waiting reaction",
          hint: "do NOT call ask_user again — the question is already in the thread and would be re-posted. Stop here; the person has been asked.",
        };
      }
      turn.statusFailed = false;
      turn.status = "waiting";
      return { success: true, ts: r.ts, duplicate: r.duplicate, waiting: true };
    });
  },
});

const readThread = tool({
  name: "read_thread",
  description: `Read the Slack thread you were summoned from, oldest message first.

Your own conversation memory already covers this thread for this session, so use this only to see
context from BEFORE this session started, or to find files someone attached.`,
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .optional()
      .describe("Maximum messages to return (default 100)."),
  }),
  callback: async ({ limit }, ctx) => {
    const turn = turnOf(ctx);
    if (!turn) return NO_SLACK;

    const r = await slackGet("conversations.replies", {
      channel: turn.target.channel_id,
      ts: turn.target.thread_ts,
      limit: String(Math.min(Math.max(limit ?? 100, 1), 100)),
    });
    if (!r.ok) return { error: r.error, hint: scopeHint(r.error) };

    const messages = (r.messages as Array<Record<string, unknown>>) ?? [];
    return {
      count: messages.length,
      messages: messages.map((m) => ({
        user: m.user ?? m.bot_id ?? "unknown",
        text: m.text ?? "",
        ts: m.ts ?? "",
        ...(Array.isArray(m.files) && m.files.length
          ? {
              files: (m.files as Array<Record<string, unknown>>).map((f) => ({
                id: f.id,
                name: f.name,
                mimetype: f.mimetype,
                size: f.size,
              })),
            }
          : {}),
      })),
    };
  },
});

const uploadFile = tool({
  name: "upload_file",
  description: `Upload a file from the workspace to the thread — a log, a diff, a report, an image.

Prefer this over pasting a long block into a message. The person cannot see your workspace, so upload
the file rather than mentioning its path.`,
  inputSchema: z.object({
    path: z.string().describe("Path to the file, relative to the workspace."),
    title: z
      .string()
      .optional()
      .describe("Display title (defaults to the filename)."),
    comment: z
      .string()
      .optional()
      .describe("Message to post alongside the file."),
  }),
  callback: async ({ path, title, comment }, ctx) => {
    const turn = turnOf(ctx);
    if (!turn) return NO_SLACK;

    try {
      const fp = resolve(WORKSPACE, path);
      if (fp !== WORKSPACE && !fp.startsWith(WORKSPACE + "/")) {
        return {
          error: `path traversal not allowed; stay inside ${WORKSPACE}`,
        };
      }
      const stat = statSync(fp);
      if (!stat.isFile()) return { error: `not a regular file: ${path}` };
      if (stat.size === 0)
        return {
          error: "file is empty",
          hint: "Slack rejects an empty upload",
        };
      if (stat.size > MAX_FILE_BYTES)
        return { error: `file exceeds ${MAX_FILE_BYTES} bytes` };

      const name = basename(fp);
      // Slack's modern upload: reserve a URL, PUT the bytes, then complete.
      const reserved = await slackGet("files.getUploadURLExternal", {
        filename: name,
        length: String(stat.size),
      });
      if (!reserved.ok)
        return { error: reserved.error, hint: scopeHint(reserved.error) };

      const uploadUrl = String(reserved.upload_url ?? "");
      const fileId = String(reserved.file_id ?? "");
      if (!uploadUrl || !fileId)
        return { error: "Slack did not return an upload URL" };

      // A timeout like every Slack call has (slack.ts): this raw PUT is the one request that used to
      // have none, and set_thread_status waits on this tool — so a stalled socket parked the whole turn.
      // Generous relative to an API call, because it is uploading up to MAX_FILE_BYTES.
      const put = await fetch(uploadUrl, {
        method: "POST",
        body: new Uint8Array(readFileSync(fp)),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!put.ok) return { error: `upload failed with HTTP ${put.status}` };

      // The completion call and the `replied` write it justifies share the lock, like every other
      // state mutation.
      return await withTurn(turn, async () => {
        const completed = await slackApi("files.completeUploadExternal", {
          files: [{ id: fileId, title: title ?? name }],
          channel_id: turn.target.channel_id,
          thread_ts: turn.target.thread_ts,
          ...(comment ? { initial_comment: comment } : {}),
        });
        if (!completed.ok) {
          turn.failedPosts++;
          return { error: completed.error, hint: scopeHint(completed.error) };
        }

        turn.replied = true; // an uploaded file IS visible output
        turn.deliveredThisBatch++;
        return { success: true, file_id: fileId, name, bytes: stat.size };
      });
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        hint: "check the path exists inside the workspace",
      };
    }
  },
});

const downloadFile = tool({
  name: "download_file",
  description: `Download a file someone attached to this thread into the workspace, so you can read it.

Use read_thread first to find the file id. Only files attached to THIS thread can be downloaded.`,
  inputSchema: z.object({
    file_id: z.string().describe("File id from read_thread."),
    save_as: z
      .string()
      .optional()
      .describe("Filename to save as (defaults to the original name)."),
  }),
  callback: async ({ file_id, save_as }, ctx) => {
    const turn = turnOf(ctx);
    if (!turn) return NO_SLACK;

    try {
      // Confirm the file really is in this thread — otherwise the agent could pull any file the bot
      // can see, which is a wider reach than being summoned to one thread should grant.
      const thread = await slackGet("conversations.replies", {
        channel: turn.target.channel_id,
        ts: turn.target.thread_ts,
        limit: "100",
      });
      if (!thread.ok)
        return { error: thread.error, hint: scopeHint(thread.error) };
      const attached = new Set(
        ((thread.messages as Array<Record<string, unknown>>) ?? []).flatMap(
          (m) =>
            Array.isArray(m.files)
              ? (m.files as Array<Record<string, unknown>>).map((f) =>
                  String(f.id),
                )
              : [],
        ),
      );
      if (!attached.has(file_id)) {
        return {
          error: "that file is not attached to this thread",
          hint: "use read_thread to list the files here",
        };
      }

      const info = await slackGet("files.info", { file: file_id });
      if (!info.ok) return { error: info.error, hint: scopeHint(info.error) };
      const file = info.file as Record<string, unknown>;
      const size = Number(file.size ?? 0);
      if (size > MAX_FILE_BYTES)
        return { error: `file exceeds ${MAX_FILE_BYTES} bytes` };

      const url = String(file.url_private_download ?? file.url_private ?? "");
      if (!url) return { error: "Slack did not provide a download URL" };

      const name = basename(save_as ?? String(file.name ?? `${file_id}.bin`));
      const fp = resolve(WORKSPACE, name);
      if (!fp.startsWith(WORKSPACE + "/"))
        return { error: "save_as must stay inside the workspace" };

      // A private file redirects to a CDN that still wants the auth header, so keep it across redirects.
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN ?? ""}`,
        },
        redirect: "follow",
      });
      if (!res.ok) return { error: `download failed with HTTP ${res.status}` };
      const bytes = Buffer.from(await res.arrayBuffer());
      // Slack serves an HTML login page instead of a 401 when auth is wrong — catch that.
      if (
        bytes
          .subarray(0, 256)
          .toString("utf8")
          .toLowerCase()
          .includes("<!doctype html")
      ) {
        return {
          error: "received an HTML page instead of the file",
          hint: "the bot token may lack files:read",
        };
      }
      const { writeFileSync } = await import("node:fs");
      writeFileSync(fp, bytes);
      return {
        success: true,
        path: name,
        bytes: bytes.length,
        mimetype: file.mimetype,
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const SLACK_TOOLS = [
  replyToThread,
  setStatus,
  askUser,
  readThread,
  uploadFile,
  downloadFile,
];

/** Build this turn's Slack state from an invocation payload, or undefined for a direct/test invoke. */
export function slackTurnFromPayload(slack: unknown): SlackTurn | undefined {
  const target = asSlackTarget(slack);
  if (!target) return undefined;
  emit("slack_turn", {
    channel: target.channel_id,
    thread_ts: target.thread_ts,
  });
  return newSlackTurn(target);
}
