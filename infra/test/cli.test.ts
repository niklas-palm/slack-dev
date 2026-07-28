// Why the guard exists: see rejectUnknownFlags in ../scripts/cli.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { REPO_ROOT } from "../lib/config.js";
import { rejectUnknownFlags } from "../scripts/cli.js";

const REAL_ARGV = process.argv;

/** Run the guard with a given command line, reporting whether it exited. */
function run(known: string[], ...args: string[]): { exited: boolean; output: string } {
  process.argv = ["node", "script.ts", ...args];
  let output = "";
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    output += a.join(" ") + "\n";
  });
  // process.exit is typed as never-returning, so throwing is the only way to model it faithfully: code
  // after the guard must not run.
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
  let exited = false;
  try {
    rejectUnknownFlags(known);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
    exited = true;
  } finally {
    err.mockRestore();
    exit.mockRestore();
  }
  return { exited, output };
}

afterEach(() => {
  process.argv = REAL_ARGV;
});

describe("rejectUnknownFlags", () => {
  const KNOWN = ["refresh-token", "app-name"];

  it("allows a known flag, and anything that isn't a flag", () => {
    expect(run(KNOWN, "--app-name", "my-agent").exited).toBe(false);
    expect(run(KNOWN).exited).toBe(false);
    expect(run(KNOWN, "owner/repo").exited).toBe(false);
  });

  it("exits on the flag that caused the duplicate-app incident", () => {
    const { exited, output } = run(KNOWN, "--store-token-only");
    expect(exited).toBe(true);
    expect(output).toContain("--store-token-only");
  });

  it("lists what IS supported, so the fix doesn't need the source", () => {
    expect(run(KNOWN, "--nope").output).toContain("--refresh-token");
  });

  // `--app-name=x` parses as undefined via arg() (it reads the NEXT argv entry), which would silently
  // fall back to the config's name. Catch it, and say what to do.
  it("rejects the --flag=value form and explains why", () => {
    const { exited, output } = run(KNOWN, "--app-name=my-agent");
    expect(exited).toBe(true);
    expect(output).toContain("=");
  });

  // A prompt is free text a human typed at an agent, so it can start with anything. Filtering argv for
  // "--" treated the VALUE as a flag and rejected the command.
  it("accepts a flag value that itself starts with --", () => {
    expect(run(["prompt"], "--prompt", "--dry-run is failing, why?").exited).toBe(false);
  });

  it("reports every unknown flag at once, not just the first", () => {
    const { output } = run(KNOWN, "--one", "--two");
    expect(output).toContain("--one");
    expect(output).toContain("--two");
  });
});

// The guard's failure mode is INVERTED: it can reject a flag that really works. That happened the day it
// was added — `--keep` is documented in invoke.ts's header and read straight off process.argv, so it was
// missing from the known list and `npm run invoke -- --keep` died. Pin every flag the docs promise.
describe("the flags the scripts actually accept", () => {
  const DOCUMENTED: Record<string, string[]> = {
    "invoke.ts": ["--prompt", "--keep"],
    "create-github-app.ts": ["--org", "--app-name"],
    "create-slack-app.ts": ["--refresh-token", "--app-name"],
  };

  for (const [file, flags] of Object.entries(DOCUMENTED)) {
    it(`${file} accepts ${flags.join(" ")}`, () => {
      const src = readFileSync(join(REPO_ROOT, "infra/scripts", file), "utf8");
      const known = /rejectUnknownFlags\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "";
      // Assert against the guard's REAL behaviour, not the source text: a list that merely mentions the
      // flag in a comment would pass a grep.
      const allowed = [...known.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      for (const flag of flags) {
        expect(run(allowed, flag, "value").exited, `${file} rejects ${flag}`).toBe(false);
      }
    });
  }
});
