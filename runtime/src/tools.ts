// The agent's toolset: files, shell, Python, images.
//
// Two rules hold everywhere in this file:
//   1. A tool NEVER throws — it returns `{error, hint}` and the agent adapts. A thrown tool aborts
//      the turn, which in Slack looks like silence.
//   2. Every path is resolved inside WORKSPACE_DIR. `run_bash` is deliberately unrestricted (that's
//      what makes the agent useful) but it still runs with the workspace as its cwd.
//
// Tool and parameter names are snake_case because that's the surface the models are trained on
// (read_file, old_text, …). Don't camelCase them.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { tool as strandsTool } from "@strands-agents/sdk";
import { z } from "zod";

import { MODEL_ID, REGION, WORKSPACE_DIR as WORKSPACE } from "./config.js";

// Tool bodies return discriminated `{success,…} | {error,hint}` unions, which TypeScript infers
// with implicit `?: undefined` keys that Strands' JSONValue rejects. Serialization handles undefined
// fine, so widen the callback's return type once here instead of casting at every call site. Inputs
// stay fully typed through the Zod schema.
type ToolFactory = <S extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  inputSchema: S;
  callback: (input: z.infer<S>) => unknown;
}) => unknown;

const tool = strandsTool as unknown as ToolFactory;

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_OUTPUT = 64_000;
/** Per-line ceiling for read_file. Anything longer is clipped AND reported (see read_file). */
const MAX_LINE = 2_000;
const IMAGE_FORMATS: Record<string, "jpeg" | "png" | "gif" | "webp"> = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".gif": "gif",
  ".webp": "webp",
};

// --- helpers ---------------------------------------------------------------

function safePath(rel: string | null | undefined): string {
  const p = resolve(WORKSPACE, rel ?? "");
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + "/")) {
    throw new Error(`path traversal not allowed; stay inside ${WORKSPACE}`);
  }
  return p;
}

function fail(e: unknown, hint?: string): { error: string; hint?: string } {
  return { error: e instanceof Error ? e.message : String(e), ...(hint ? { hint } : {}) };
}

/**
 * Truncate to `max` UTF-16 units WITHOUT splitting a surrogate pair.
 *
 * A bare `.slice(0, n)` can cut an emoji in half and leave a lone high surrogate. That string isn't
 * well-formed, so `JSON.stringify` emits `"\ud83d"`, Bedrock rejects the request body, and the SDK
 * throws `ModelError` — killing the entire turn rather than returning a tool error. Verified against
 * real Bedrock: reading a file of 1500 emoji at an odd offset took the whole turn down, and a retry
 * hit the same wall. Every place we clip model-visible text must go through this.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // A trailing high surrogate has lost its pair — drop it.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function isBinary(path: string, sample = 8192): boolean {
  try {
    const buf = Buffer.alloc(sample);
    const fd = openSync(path, "r");
    let read = 0;
    try {
      read = readSync(fd, buf, 0, sample, 0);
    } finally {
      closeSync(fd);
    }
    if (read === 0) return false;
    const chunk = buf.subarray(0, read);
    if (chunk.includes(0)) return true;
    // A NUL check alone isn't enough: plenty of binaries have no NUL in their first 8 KB, and treating
    // one as text meant edit_file read it as `utf8` (mangling every byte >=0x80) and wrote it back —
    // reporting success while destroying the file. So require the sample to be losslessly UTF-8; if a
    // decode would lose bytes, we must not round-trip this file as text. (A partial read can end
    // mid-character, which is expected rather than corruption — hence the trim.)
    const text = read === sample ? trimPartialTail(chunk) : chunk;
    if (Buffer.compare(Buffer.from(text.toString("utf8"), "utf8"), text) !== 0) return true;
    const textChars = new Set([7, 8, 9, 10, 12, 13, 27]);
    let nonText = 0;
    for (const b of chunk) if (!(textChars.has(b) || b >= 0x20)) nonText++;
    return nonText / read > 0.3;
  } catch {
    return true;
  }
}

/**
 * Trim an incomplete multi-byte UTF-8 sequence off the end of a buffer.
 *
 * Any cut at an arbitrary byte offset can split a character; leaving the fragment makes `toString`
 * render a U+FFFD replacement char. Drops at most 3 bytes.
 */
function trimPartialTail(buf: Buffer): Buffer {
  for (let i = 1; i <= 3 && buf.length - i >= 0; i++) {
    const b = buf[buf.length - i]!;
    if (b < 0x80) break; // ASCII: nothing incomplete
    if (b >= 0xc0) {
      // A lead byte this close to the end is only complete if its whole sequence fits.
      const needed = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return i < needed ? buf.subarray(0, buf.length - i) : buf;
    }
  }
  return buf;
}

/** Decode captured bytes, dropping an incomplete sequence at either edge (see trimPartialTail). */
function decode(buf: Buffer): string {
  let start = 0;
  // Leading continuation bytes are the tail of a character whose lead byte was dropped.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return trimPartialTail(buf.subarray(start)).toString("utf8");
}

/**
 * Collects a child's output while REFUSING to grow without bound.
 *
 * `out += chunk` costs memory proportional to what the command PRINTS, not what we return: 250 MB of
 * stdout drove RSS to 828 MB, and past ~600 MB the string throws inside a stream listener, which is an
 * uncaughtException that kills the runtime. Easy to hit by accident (`cat` a log, `git log -p`).
 *
 * So keep only what we'd return anyway — a head and a rolling tail, both capped. The tail matters: it's
 * where a failing build puts its error.
 */
class BoundedOutput {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  total = 0;

  private readonly keep = Math.floor(MAX_OUTPUT / 2);

  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.head.length < this.keep) {
      const take = Math.min(chunk.length, this.keep - this.head.length);
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
    }
    // Keep only the last `keep` bytes, so the retained tail is a consistent size rather than whatever
    // the final stream chunk happened to be.
    if (chunk.length) this.tail = Buffer.concat([this.tail, chunk]).subarray(-this.keep);
  }

  /** The text to hand back, with a marker if anything was dropped. */
  text(): { text: string; truncated: boolean } {
    const omitted = this.total - this.head.length - this.tail.length;

    // Nothing dropped means head and tail are CONTIGUOUS, so decode as one buffer — decoding the halves
    // separately would trim a character split across the join off both sides and lose it silently.
    if (omitted <= 0) return { text: decode(Buffer.concat([this.head, this.tail])), truncated: false };

    // Genuinely truncated: each side has a real cut, so trim each independently.
    return {
      text: `${decode(this.head)}\n… ${omitted} bytes of output omitted …\n${decode(this.tail)}`,
      truncated: true,
    };
  }
}

/** Spawn a child in its own process group so a timeout can kill the whole tree, not just the shell. */
function runChild(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? WORKSPACE,
      env: { ...process.env, HOME: process.env.HOME ?? WORKSPACE },
      detached: true,
    });
    const out = new BoundedOutput();
    const err = new BoundedOutput();
    let timedOut = false;
    let settled = false;

    // A throw in a stream listener is an uncaughtException, not a rejected promise — it would take
    // the whole runtime down. Nothing in here should throw now, but never let it reach the loop.
    const feed = (sink: BoundedOutput) => (d: Buffer) => {
      try {
        sink.add(d);
      } catch {
        /* ignore a chunk we couldn't store; the command's exit code still gets through */
      }
    };
    child.stdout?.on("data", feed(out));
    child.stderr?.on("data", feed(err));

    const kill = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    };

    const finish = (code: number, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(reap);
      const stdout = out.text();
      const stderr = err.text();
      done({
        code,
        stdout: stdout.text,
        stderr: stderr.text + extra,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);

    // `close` waits for every inherited stdio pipe to reach EOF, so a grandchild that escaped the
    // process group (setsid/nohup, or a self-daemonizing program) keeps the promise pending for as
    // long as IT lives — measured at 10s for a 2s timeout, and unbounded in general. That would
    // block this session's turn queue silently. So settle on `exit` (the direct child is gone) and
    // give the pipes only a short grace period to flush.
    let reap: NodeJS.Timeout;
    child.on("exit", (code) => {
      reap = setTimeout(() => finish(code ?? -1, "\n… output stream still open; returning early …"), 250);
      reap.unref();
    });
    child.on("close", (code) => finish(code ?? -1));
    child.on("error", (e) => finish(-1, `\n${e.message}`));
  });
}

// --- tools -----------------------------------------------------------------

const readFile = tool({
  name: "read_file",
  description: `Read a text file from the workspace, with 1-indexed line numbers (cat -n format).

Reads up to 2000 lines from the start by default. Use offset/limit for a window.
For directories use run_bash (ls). For files over 5MB use run_bash (head/tail).`,
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace."),
    offset: z.number().int().positive().optional().describe("1-indexed line to start from."),
    // Positive: a negative limit made `slice(start, start + limit)` count back from the end, quietly
    // returning a partial window the model would trust as complete.
    limit: z.number().int().positive().optional().describe("Number of lines to read."),
  }),
  callback: ({ path, offset, limit }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp)) return { error: `file not found: ${path}`, hint: "use run_bash (ls) to explore" };
      const stat = statSync(fp);
      if (stat.isDirectory()) return { error: `path is a directory: ${path}`, hint: "use run_bash (ls)" };
      if (stat.size > MAX_FILE_SIZE) {
        return { error: `file too large (${Math.round(stat.size / 1024 / 1024)} MB)`, hint: "use run_bash with head/tail" };
      }
      if (isBinary(fp)) return { error: "binary or non-UTF-8 file", hint: "use view_image for images" };

      const lines = readFileSync(fp, "utf8").split("\n");
      const start = offset && offset >= 1 ? offset - 1 : 0;
      const selected = lines.slice(start, start + (limit ?? 2000));
      const width = String(start + selected.length).length;

      // Cap the RESULT, not just the line count. 2000 lines × 2000 chars is a 4 MB ceiling, and this
      // text goes straight into a conversation that never trims (NullConversationManager) — so one
      // read_file on a minified bundle or a long log could permanently overflow the thread's context,
      // which is unrecoverable by design. Stop at the same budget run_bash uses and say so.
      const kept: string[] = [];
      let bytes = 0;
      let cut = false;
      // Long lines are clipped too, and that MUST be reported. A minified bundle or a single-line JSON
      // log is one 400k-char line: clipping it to 2000 silently and reporting "3 of 3 lines" told the
      // agent it had read the whole file, so it would reason confidently about content it never saw.
      // Line-granular paging can't index INTO a line, so point at a tool that can.
      const clipped: number[] = [];
      for (const [i, line] of selected.entries()) {
        const lineNumber = start + i + 1;
        const shown = clip(line, MAX_LINE);
        const numbered = `${String(lineNumber).padStart(width)}\t${shown}`;
        // Measure in BYTES, matching what the cap claims. String.length counts UTF-16 units, so an
        // emoji-heavy file overshot the 64 kB budget by ~2× (and 3-byte CJK by more) — undercutting the
        // protection this cap exists for, since a read that big can't be trimmed back out of the
        // conversation.
        const size = Buffer.byteLength(numbered, "utf8");
        if (bytes + size > MAX_OUTPUT) {
          cut = true;
          break;
        }
        kept.push(numbered);
        bytes += size + 1;
        // Record the clip only AFTER the line survives the cap — otherwise the hint named a line that
        // wasn't in `content` at all, telling the agent to `cut -c` something it had never seen.
        if (shown.length < line.length) clipped.push(lineNumber);
      }

      const hints: string[] = [];
      if (cut) hints.push(`output capped at ${MAX_OUTPUT} bytes; continue with offset=${start + kept.length + 1}`);
      if (clipped.length) {
        hints.push(
          `line${clipped.length > 1 ? "s" : ""} ${clipped.slice(0, 5).join(", ")}${clipped.length > 5 ? "…" : ""} ` +
            `clipped at ${MAX_LINE} characters — use run_bash (e.g. cut -c) to read the rest`,
        );
      }

      return {
        content: kept.join("\n"),
        total_lines: lines.length,
        returned_lines: kept.length,
        start_line: start + 1,
        ...(hints.length ? { truncated: true, hint: hints.join("; ") } : {}),
      };
    } catch (e) {
      return fail(e, "check the path and try again");
    }
  },
});

const writeFile = tool({
  name: "write_file",
  description: `Write a new file, creating parent directories as needed.

FOR NEW FILES ONLY — on an existing file this overwrites everything. Use edit_file to change a file
that already exists. Do not create documentation files unless asked.`,
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace."),
    content: z.string().describe("Complete file content."),
  }),
  callback: ({ path, content }) => {
    try {
      const fp = safePath(path);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
      return { success: true, path, bytes_written: Buffer.byteLength(content, "utf8") };
    } catch (e) {
      return fail(e, "check the path is valid and writable");
    }
  },
});

const editFile = tool({
  name: "edit_file",
  description: `Replace an exact string in a file. Read the file first.

old_text must appear EXACTLY ONCE unless replace_all is set. Indentation must match exactly —
copy old_text verbatim from read_file output (minus the line-number prefix).`,
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace."),
    // Non-empty: "" is a substring of every position, so replace_all would interleave new_text
    // between every character ("hello" → "hXeXlXlXo") and report success.
    old_text: z.string().min(1).describe("Exact text to find. Unique unless replace_all is true."),
    new_text: z.string().describe("Replacement text. Must differ from old_text."),
    replace_all: z.boolean().optional().describe("Replace every occurrence (for renames)."),
  }),
  callback: ({ path, old_text, new_text, replace_all }) => {
    try {
      if (old_text === new_text) return { error: "old_text and new_text are identical", hint: "no-op edit rejected" };
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) {
        return { error: `file not found: ${path}`, hint: "create it with write_file or check the path" };
      }
      if (isBinary(fp)) return { error: "binary or non-UTF-8 file", hint: "edit_file only works on text" };

      const content = readFileSync(fp, "utf8");
      const count = content.split(old_text).length - 1;
      if (count === 0) {
        return {
          error: "old_text not found in file",
          searched_for: clip(old_text, 200),
          hint: "check whitespace; copy the text verbatim from read_file output",
        };
      }
      if (count > 1 && !replace_all) {
        return {
          error: `old_text matches ${count} locations — must be unique`,
          hint: "add surrounding context, or set replace_all",
        };
      }
      writeFileSync(fp, replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, new_text));
      return { success: true, path, replacements: replace_all ? count : 1 };
    } catch (e) {
      return fail(e, "check the path and try again");
    }
  },
});

const multiEdit = tool({
  name: "multi_edit",
  description: `Apply several edits to one file in a single call.

Edits apply SEQUENTIALLY — each sees the result of the previous one. The file is written only if
every edit succeeds, so a failure leaves it untouched. Read the file first.`,
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace."),
    edits: z
      .array(z.object({ old_text: z.string(), new_text: z.string() }))
      .describe('Edits as [{"old_text": "…", "new_text": "…"}].'),
  }),
  callback: ({ path, edits }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) return { error: `file not found: ${path}`, hint: "check the path" };
      if (isBinary(fp)) return { error: "binary or non-UTF-8 file", hint: "multi_edit only works on text" };

      let content = readFileSync(fp, "utf8");
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]!;
        if (edit.old_text === edit.new_text) return { error: `edit ${i}: old_text and new_text are identical` };
        const count = content.split(edit.old_text).length - 1;
        if (count === 0) {
          return { error: `edit ${i}: old_text not found`, hint: "an earlier edit may have changed that text" };
        }
        if (count > 1) return { error: `edit ${i}: matches ${count} locations`, hint: "add more context" };
        content = content.replace(edit.old_text, edit.new_text);
      }
      writeFileSync(fp, content);
      return { success: true, path, edits_applied: edits.length };
    } catch (e) {
      return fail(e, "check the path and try again");
    }
  },
});

const runBash = tool({
  name: "run_bash",
  description: `Run a shell command in the workspace.

Prefer the dedicated tools where they fit (read_file / write_file / edit_file). Use run_bash for
everything else: ls / find / grep / rg, git, gh, curl, npm, builds, tests, chained commands.
Available in the image: git, gh, curl, jq, ripgrep, openssl, node, npm, python3.`,
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute."),
    timeout: z.number().int().optional().describe("Max seconds to wait (default 120, max 900)."),
  }),
  callback: async ({ command, timeout = 120 }) => {
    try {
      const seconds = Math.min(Math.max(timeout, 1), 900);
      const r = await runChild("bash", ["-lc", command], { timeoutMs: seconds * 1000 });
      const result: Record<string, unknown> = {
        stdout: r.stdout,
        stderr: r.stderr,
        exit_code: r.code,
        success: r.code === 0 && !r.timedOut,
        truncated: r.truncated,
      };
      if (r.timedOut) {
        result.error_summary = `timed out after ${seconds}s`;
        // No "background it with nohup" advice here, however tempting: a grandchild that escapes the
        // process group is the exact case runChild's `exit`-not-`close` comment above exists for.
        // Not a constant: at the 900s cap "raise the timeout" is advice the model cannot act on.
        result.hint =
          seconds < 900
            ? `raise \`timeout\` (max 900) — a build or a full test suite often needs it.`
            : `already at the 900s maximum, so split the work: run the slow step alone rather than chaining commands, and narrow it (one package, one suite). Partial stdout above is kept.`;
      }
      else if (r.code !== 0) result.error_summary = clip(r.stderr.trim() || `exit code ${r.code}`, 500);
      return result;
    } catch (e) {
      return { success: false, ...fail(e) };
    }
  },
});

const runPython = tool({
  name: "run_python",
  description: `Run Python for analysis or AWS queries. Pre-installed: boto3, httpx.

Use boto3 for READ-ONLY AWS calls (CloudWatch logs, metrics, ECS, DynamoDB, Cost Explorer). Prefer
this over the aws CLI in run_bash when you need to filter or loop — one call instead of several.
print() whatever you need to see; no state persists between calls.`,
  inputSchema: z.object({
    code: z.string().describe("Complete, self-contained Python."),
    timeout: z.number().int().optional().describe("Max seconds to wait (default 120, max 900)."),
  }),
  callback: async ({ code, timeout = 120 }) => {
    const dir = join(WORKSPACE, ".tmp");
    let script: string | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      script = join(dir, `run_${randomUUID().slice(0, 8)}.py`);
      writeFileSync(script, code);
      const seconds = Math.min(Math.max(timeout, 1), 900);
      const r = await runChild("python3", [script], { timeoutMs: seconds * 1000 });
      // A timeout with no guidance made one agent tell the person "one of my searches hung" and move on.
      if (r.timedOut)
        return {
          success: false,
          error_summary: `python timed out after ${seconds}s`,
          hint: "narrow it rather than just retrying: bound the time range (startTime/endTime), set limit, filter server-side (filterPattern), or page. Raise `timeout` (max 900) only if the work genuinely needs longer.",
        };
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exit_code: r.code,
        success: r.code === 0,
        truncated: r.truncated,
      };
    } catch (e) {
      return { success: false, ...fail(e) };
    } finally {
      if (script) {
        try {
          unlinkSync(script);
        } catch {
          /* ignore */
        }
      }
    }
  },
});

const viewImage = tool({
  name: "view_image",
  description: "Look at an image file and answer a specific question about it (screenshots, diagrams, charts).",
  inputSchema: z.object({
    path: z.string().describe("Path to the image."),
    question: z.string().describe("Precise question about the image."),
  }),
  callback: async ({ path, question }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) return { error: `file not found: ${path}` };
      const format = IMAGE_FORMATS[extname(fp).toLowerCase()];
      if (!format) {
        return { error: `unsupported image type: ${extname(fp)}`, hint: `supported: ${Object.keys(IMAGE_FORMATS).join(", ")}` };
      }
      if (statSync(fp).size > MAX_FILE_SIZE) return { error: "image too large", hint: "max 5MB" };

      const bedrock = new BedrockRuntimeClient({ region: REGION });
      const response = await bedrock.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          messages: [{ role: "user", content: [{ image: { format, source: { bytes: readFileSync(fp) } } }, { text: question }] }],
          // No `temperature` — recent Claude models reject it in the Converse API.
          inferenceConfig: { maxTokens: 2048 },
        }),
      );
      // Text can arrive after a reasoning block, so scan the blocks rather than taking index 0.
      for (const block of response.output?.message?.content ?? []) {
        if ("text" in block && block.text) return { answer: block.text };
      }
      return { error: "no text in vision response", hint: "the model returned an unexpected shape" };
    } catch (e) {
      return fail(e, "check AWS credentials and model access");
    }
  },
});

export const ALL_TOOLS = [readFile, writeFile, editFile, multiEdit, runBash, runPython, viewImage];
