// Offline unit tests for the tool contract. These assert the two invariants the whole design leans
// on: a tool never throws, and no path escapes the workspace.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

// config.ts reads WORKSPACE_DIR on import, so point it at a temp dir before importing the tools.
// realpath because macOS resolves /var to /private/var, which a subprocess's `pwd` would report.
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "slack-dev-test-")));
process.env.WORKSPACE_DIR = workspace;

type ToolResult = Record<string, unknown>;
/** A Strands ZodTool. `invoke` validates the input against the tool's schema, then runs it — so
 *  calling through it exercises the same path the model does, not just the raw callback. */
type Invokable = { name: string; invoke: (input: unknown) => Promise<unknown> };

let byName: Map<string, Invokable>;

async function call(name: string, input: unknown): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) throw new Error(`no such tool: ${name} (have: ${[...byName.keys()].join(", ")})`);
  return (await tool.invoke(input)) as ToolResult;
}

beforeAll(async () => {
  const { ALL_TOOLS } = await import("./tools.js");
  byName = new Map((ALL_TOOLS as unknown as Invokable[]).map((t) => [t.name, t]));
});

describe("the toolset", () => {
  it("exposes exactly the tools the prompt promises", () => {
    expect([...byName.keys()].sort()).toEqual(
      ["edit_file", "multi_edit", "read_file", "run_bash", "run_python", "view_image", "write_file"].sort(),
    );
  });
});

describe("workspace sandboxing", () => {
  it("refuses to read outside the workspace", async () => {
    const result = await call("read_file", { path: "../../../etc/passwd" });
    expect(result.error).toMatch(/traversal/);
    expect(result.content).toBeUndefined();
  });

  it("refuses to write outside the workspace", async () => {
    const result = await call("write_file", { path: "/tmp/escaped.txt", content: "nope" });
    expect(result.error).toMatch(/traversal/);
    expect(result.success).toBeUndefined();
  });
});

describe("read_file", () => {
  it("returns 1-indexed numbered lines and honours offset/limit", async () => {
    writeFileSync(join(workspace, "lines.txt"), "alpha\nbeta\ngamma\ndelta\n");

    const all = await call("read_file", { path: "lines.txt" });
    expect(all.content).toContain("1\talpha");
    expect(all.total_lines).toBe(5); // trailing newline yields a final empty line

    const window = await call("read_file", { path: "lines.txt", offset: 2, limit: 2 });
    expect(window.content).toBe("2\tbeta\n3\tgamma");
    expect(window.start_line).toBe(2);
  });

  it("returns an error, not a throw, for a missing file", async () => {
    const result = await call("read_file", { path: "absent.txt" });
    expect(result.error).toMatch(/not found/);
    expect(result.hint).toBeTruthy();
  });

  // Regression: only the LINE count was capped (2000 lines × 2000 chars = a 4 MB ceiling, measured
  // at 4,011,999 bytes). That text goes into a conversation that never trims, so one read of a
  // minified bundle could permanently overflow the thread's context — unrecoverable by design.
  it("caps the returned bytes, not just the line count", async () => {
    writeFileSync(join(workspace, "wide.txt"), (`${"x".repeat(2000)}\n`).repeat(2000));
    const result = await call("read_file", { path: "wide.txt" });

    expect(String(result.content).length).toBeLessThan(200_000);
    expect(result.truncated).toBe(true);
    // Must say how to get the rest, or the agent can't finish reading the file.
    expect(String(result.hint)).toMatch(/offset=/);
    expect(Number(result.returned_lines)).toBeLessThan(2000);
  });

  // Regression: a long line was clipped to 2000 chars SILENTLY — a 400k-char minified bundle came back
  // as 2002 chars reported as "3 of 3 lines read", so the agent reasoned about content it never saw.
  // Line-granular paging can't index into a line, so the hint has to point elsewhere.
  it("reports a clipped long line instead of pretending it read the whole file", async () => {
    writeFileSync(join(workspace, "bundle.js"), `${"A".repeat(400_000)}\nconst v = "1.2.3";\n`);
    const result = await call("read_file", { path: "bundle.js" });

    expect(result.truncated, "a clipped line must set truncated").toBe(true);
    expect(String(result.hint)).toMatch(/clipped at 2000 characters/);
    expect(String(result.hint)).toMatch(/run_bash/); // how to actually get the rest
    expect(String(result.hint)).toMatch(/line 1\b/); // which line was clipped
  });

  // Regression, CRITICAL: clipping cut at a UTF-16 index, so it could split a surrogate pair and leave
  // a lone half. That string isn't well-formed, JSON.stringify emits "\ud83d", Bedrock rejects the body,
  // and the SDK THROWS — killing the whole turn instead of returning a tool error, and a retry hits the
  // same wall. Verified against real Bedrock. Note the offset must be ODD relative to the pair boundary.
  it("never returns a lone surrogate from a clipped line", async () => {
    writeFileSync(join(workspace, "emoji.txt"), `a${"😀".repeat(1500)}`);
    const result = await call("read_file", { path: "emoji.txt" });
    expect(String(result.content).isWellFormed()).toBe(true);
  });

  it("counts the output cap in BYTES, not UTF-16 units", async () => {
    // String.length let an emoji-heavy file overshoot the 64kB budget ~2x, undercutting the protection
    // this cap exists for — a read that big can't be trimmed back out of the conversation.
    writeFileSync(join(workspace, "emo.txt"), `${"😀".repeat(1000)}\n`.repeat(100));
    const result = await call("read_file", { path: "emo.txt" });
    expect(Buffer.byteLength(String(result.content), "utf8")).toBeLessThanOrEqual(64_000);
  });

  it("does not name a clipped line it never returned", async () => {
    // `clipped` was recorded before the byte cap could break, so the hint told the agent to `cut -c` a
    // line that wasn't in `content` — and contradicted the offset= half of the same hint.
    writeFileSync(join(workspace, "mix.txt"), `${`${"s".repeat(1900)}\n`.repeat(33)}${"L".repeat(9000)}\ntail\n`);
    const result = await call("read_file", { path: "mix.txt" });
    const returned = Number(result.returned_lines);
    const named = [...String(result.hint ?? "").matchAll(/line[s]? ([\d, ]+)/g)].flatMap((m) =>
      m[1]!.split(",").map((n) => Number(n.trim())),
    );
    for (const line of named) expect(line, `hint names line ${line} but only ${returned} were returned`).toBeLessThanOrEqual(returned);
  });

  it("does not claim truncation for a file whose lines all fit", async () => {
    writeFileSync(join(workspace, "normal.txt"), "short\nlines\nonly\n");
    const result = await call("read_file", { path: "normal.txt" });
    expect(result.truncated).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it("rejects a non-positive limit rather than returning a misleading window", async () => {
    writeFileSync(join(workspace, "twenty.txt"), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"));
    // `slice(start, start + -5)` counted back from the END, quietly returning lines 1-15 as if complete.
    await expect(call("read_file", { path: "twenty.txt", limit: -5 })).rejects.toThrow();
    await expect(call("read_file", { path: "twenty.txt", limit: 0 })).rejects.toThrow();
  });
});

// The agent works in /workspace/repo (every run_bash starts `cd` there) but these tools resolve against
// /workspace, so the same path means two files. A real session burned a call on exactly this. The error
// now names the file it can see.
describe("repo-relative path confusion", () => {
  it("suggests the repo/ path when that's the file that exists", async () => {
    mkdirSync(join(workspace, "repo", "runtime", "src"), { recursive: true });
    writeFileSync(join(workspace, "repo", "runtime", "src", "prompt.ts"), "export const x = 1;\n");

    const result = await call("read_file", { path: "runtime/src/prompt.ts" });
    expect(result.error).toMatch(/not found/);
    expect(String(result.hint)).toContain("repo/runtime/src/prompt.ts");
  });

  it("keeps the generic hint when no repo/ twin exists", async () => {
    const result = await call("read_file", { path: "nope/nothing-here.ts" });
    expect(String(result.hint)).toMatch(/run_bash/);
  });
});

describe("edit_file", () => {
  it("rejects an ambiguous match instead of guessing", async () => {
    writeFileSync(join(workspace, "dup.txt"), "target\ntarget\n");
    const result = await call("edit_file", { path: "dup.txt", old_text: "target", new_text: "fixed" });
    expect(result.error).toMatch(/2 locations/);
    expect(readFileSync(join(workspace, "dup.txt"), "utf8")).toBe("target\ntarget\n"); // untouched
  });

  it("replaces every occurrence when asked", async () => {
    writeFileSync(join(workspace, "all.txt"), "a\na\n");
    const result = await call("edit_file", { path: "all.txt", old_text: "a", new_text: "b", replace_all: true });
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, "all.txt"), "utf8")).toBe("b\nb\n");
  });

  it("rejects a no-op edit", async () => {
    writeFileSync(join(workspace, "noop.txt"), "same");
    const result = await call("edit_file", { path: "noop.txt", old_text: "same", new_text: "same" });
    expect(result.error).toMatch(/identical/);
  });

  // Regression: isBinary only looked for a NUL byte, so a NUL-free binary counted as text, was read
  // with `utf8` (mangling every byte ≥0x80 into U+FFFD) and written back — reporting success while
  // destroying the file. Measured: 4013 bytes in, 12023 bytes of garbage out.
  it("refuses to edit a binary file that happens to contain no NUL byte", async () => {
    const binary = Buffer.alloc(4013);
    for (let i = 0; i < binary.length; i++) binary[i] = 0x80 + (i % 0x7f);
    binary.write("NEEDLE", 100);
    writeFileSync(join(workspace, "nonul.bin"), binary);

    const result = await call("edit_file", { path: "nonul.bin", old_text: "NEEDLE", new_text: "OK" });
    expect(result.error).toMatch(/binary/);
    expect(result.success).toBeUndefined();
    // The file must be byte-identical afterwards.
    expect(readFileSync(join(workspace, "nonul.bin")).equals(binary)).toBe(true);
  });

  it("still edits UTF-8 text containing multi-byte characters", async () => {
    // The binary guard must not reject legitimate non-ASCII text — that would be a worse bug.
    writeFileSync(join(workspace, "utf8.txt"), "héllo wörld — αβγ 🎉 TARGET\n");
    const result = await call("edit_file", { path: "utf8.txt", old_text: "TARGET", new_text: "DONE" });
    expect(result.success).toBe(true);
    expect(readFileSync(join(workspace, "utf8.txt"), "utf8")).toBe("héllo wörld — αβγ 🎉 DONE\n");
  });

  it("never returns a lone surrogate in searched_for", async () => {
    writeFileSync(join(workspace, "plain.txt"), "nothing here");
    const result = await call("edit_file", { path: "plain.txt", old_text: `a${"😀".repeat(150)}`, new_text: "x" });
    expect(String(result.searched_for ?? "").isWellFormed()).toBe(true);
  });

  it("rejects an empty old_text instead of interleaving into every position", async () => {
    writeFileSync(join(workspace, "empty.txt"), "hello");
    // "" is a substring at every position: replace_all turned "hello" into "hXeXlXlXo", success:true.
    await expect(call("edit_file", { path: "empty.txt", old_text: "", new_text: "X", replace_all: true })).rejects.toThrow();
    expect(readFileSync(join(workspace, "empty.txt"), "utf8")).toBe("hello");
  });
});

describe("multi_edit", () => {
  it("writes nothing when any edit in the batch fails", async () => {
    writeFileSync(join(workspace, "batch.txt"), "one two\n");
    const result = await call("multi_edit", {
      path: "batch.txt",
      edits: [
        { old_text: "one", new_text: "1" },
        { old_text: "absent", new_text: "x" },
      ],
    });
    expect(result.error).toMatch(/edit 1/);
    expect(readFileSync(join(workspace, "batch.txt"), "utf8")).toBe("one two\n"); // first edit rolled back
  });
});

describe("run_bash", () => {
  it("runs in the workspace and reports success", async () => {
    const result = await call("run_bash", { command: "pwd" });
    expect(result.success).toBe(true);
    expect(String(result.stdout).trim()).toBe(workspace);
  });

  it("reports a non-zero exit with a summary rather than throwing", async () => {
    const result = await call("run_bash", { command: "exit 3" });
    expect(result.success).toBe(false);
    expect(result.exit_code).toBe(3);
    expect(result.error_summary).toBeTruthy();
  });

  // Same lone-surrogate hazard as read_file: error_summary is clipped to 500, and a split emoji there
  // produced invalid JSON that killed the turn instead of surfacing the command's failure.
  it("never returns a lone surrogate in error_summary", async () => {
    const result = await call("run_bash", {
      command: `printf 'a%s' "$(for i in $(seq 1 400); do printf '\\xf0\\x9f\\x98\\x80'; done)" >&2; exit 1`,
    });
    expect(String(result.error_summary ?? "").isWellFormed()).toBe(true);
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await call("run_bash", { command: "sleep 5", timeout: 1 });
    expect(result.success).toBe(false);
    expect(String(result.error_summary)).toMatch(/timed out/);
  });

  // Regression: stdin defaulted to a pipe nobody would ever write to or close, so any command that
  // reads stdin when it isn't a TTY blocked until the timeout killed it. This is the real command from
  // a real session — `ls && rg -n "…" -l` (no path arg) burned the full 120s default and returned
  // exit_code -1. Also hit a bare grep/cat/sort and ANY pipeline whose last stage reads stdin, which is
  // a very common agent pattern. A 2s timeout here is ~15x the fixed cost and fails loudly if it regresses.
  it("does not hang on a command that reads stdin", async () => {
    writeFileSync(join(workspace, "haystack.txt"), "needle\n");
    const result = await call("run_bash", { command: 'rg -n "needle" -l', timeout: 2 });
    expect(result.success, `stdin left open: ${result.error_summary ?? ""}`).toBe(true);
    expect(String(result.stdout)).toContain("haystack.txt");
  });

  it("does not hang on a pipeline whose last stage reads stdin", async () => {
    const result = await call("run_bash", { command: "echo hello | cat", timeout: 2 });
    expect(result.success).toBe(true);
    expect(String(result.stdout)).toContain("hello");
  });

  // Regression: output was accumulated with `out += chunk` and only truncated after exit, so memory
  // grew with what the command PRINTED, not what we return — 250 MB of stdout drove RSS to 828 MB,
  // and ~600 MB threw RangeError from inside a stream listener, killing the runtime (an
  // uncaughtException, so the turn's error handling never ran and the thread stranded on 🟡).
  it("bounds memory on huge output instead of buffering all of it", async () => {
    const before = process.memoryUsage().heapUsed;
    const result = await call("run_bash", { command: "yes ABCDEFGHIJ | head -c 120000000", timeout: 120 });
    const grewMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    // The result is capped, and — the actual bug — the heap never held the full 120 MB.
    expect(String(result.stdout).length).toBeLessThan(200_000);
    expect(grewMb).toBeLessThan(50);
  }, 180_000);

  // Regression: head/tail cuts land on arbitrary byte offsets, so a multi-byte character could be
  // split and rendered as U+FFFD. Found by forcing a 3-byte-char stream past the cap at three
  // different alignments — two of the three produced a mangled character.
  it("does not corrupt multi-byte characters at a truncation boundary", async () => {
    for (const pad of [0, 1, 2]) {
      const result = await call("run_bash", {
        command: `printf '%${pad}s' ''; for i in $(seq 1 30000); do printf '世'; done`,
      });
      expect(result.truncated).toBe(true);
      expect(String(result.stdout), `alignment pad=${pad}`).not.toContain("�");
    }
  }, 120_000);

  it("round-trips multi-byte output that fits under the cap", async () => {
    const result = await call("run_bash", { command: `printf '%s' 'héllo 🎉 世界'` });
    expect(String(result.stdout)).toBe("héllo 🎉 世界");
  });

  // Regression: output between the head budget (32000) and the cap (64000) is NOT truncated — head and
  // tail are contiguous — but decoding the two halves separately trimmed the character straddling the
  // join off both sides, silently losing it while reporting truncated:false. A seam is not a cut.
  it("loses nothing when output spans the head/tail seam without being truncated", async () => {
    for (const count of [10667, 20000]) {
      const result = await call("run_bash", { command: `for i in $(seq 1 ${count}); do printf '世'; done` });
      expect(result.truncated, `${count} chars should fit under the cap`).toBe(false);
      expect([...String(result.stdout)].filter((c) => c === "世").length, `${count} chars`).toBe(count);
    }
  }, 120_000);

  // Regression: the tail evicted whole chunks, so the retained tail was whatever the last stream chunk
  // happened to be — measured anywhere from 48 to 51312 bytes for the same command. How much trailing
  // context the model saw was a lottery.
  it("retains a consistent amount of tail context regardless of output size", async () => {
    const sizes = await Promise.all(
      [1, 4].map(async (mb) => {
        const result = await call("run_bash", {
          command: `echo FIRST_MARKER; yes padding | head -c ${mb * 1000000}; echo LAST_MARKER`,
          timeout: 120,
        });
        expect(result.truncated).toBe(true);
        expect(String(result.stdout)).toContain("FIRST_MARKER");
        expect(String(result.stdout)).toContain("LAST_MARKER");
        return String(result.stdout).length;
      }),
    );
    // Both runs return essentially the same amount, not an arbitrary fraction of it.
    expect(Math.abs(sizes[0]! - sizes[1]!)).toBeLessThan(100);
  }, 180_000);

  it("keeps the start AND end of truncated output, marking what it dropped", async () => {
    const result = await call("run_bash", {
      command: "echo FIRST_MARKER; yes padding | head -c 300000; echo LAST_MARKER",
    });
    expect(result.truncated).toBe(true);
    expect(String(result.stdout)).toContain("FIRST_MARKER");
    expect(String(result.stdout)).toContain("LAST_MARKER");
    expect(String(result.stdout)).toMatch(/bytes of output omitted/);
  }, 60_000);
});

describe("run_python", () => {
  it("captures stdout", async () => {
    const result = await call("run_python", { code: "print(6 * 7)" });
    expect(result.success).toBe(true);
    expect(String(result.stdout).trim()).toBe("42");
  });

  it("reports a Python error as a result, not a throw", async () => {
    const result = await call("run_python", { code: "raise ValueError('boom')" });
    expect(result.success).toBe(false);
    expect(String(result.stderr)).toMatch(/boom/);
  });
});
