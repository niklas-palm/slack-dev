// Redaction is the only thing between a live credential and CloudWatch. The github skill puts a minted
// installation token in the clone's remote URL, so ordinary commands (`git remote -v`, a failing push
// that echoes the remote) used to persist a working `ghs_…` token into the log stream — with no model
// cooperation needed, so the prompt's "never paste credentials" rule could not prevent it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emit } from "./emit.js";

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SLACK_BOT_TOKEN;
});

describe("emit", () => {
  it("redacts a GitHub token embedded in a clone URL", () => {
    emit("tool_result", {
      result: "origin https://x-access-token:ghs_AbCdEf0123456789AbCdEf@github.com/o/r.git (fetch)",
    });

    expect(lines[0]).not.toContain("ghs_AbCdEf0123456789AbCdEf");
    expect(lines[0]).toContain("[redacted]");
  });

  it("redacts a secret it only knows from the environment", () => {
    // A signing secret is just hex — no pattern can catch it, so the literal value must be scrubbed.
    process.env.SLACK_BOT_TOKEN = "xoxb-0000-not-a-real-token-value";

    emit("tool_result", { result: `token is ${process.env.SLACK_BOT_TOKEN} ok` });

    expect(lines[0]).not.toContain("not-a-real-token");
  });

  it("redacts a secret nested anywhere in the payload", () => {
    emit("tool_input", { input: { deep: { list: ["ghp_ZzZzZzZzZzZzZzZzZzZzZz"] } } });

    expect(lines[0]).not.toContain("ghp_ZzZzZzZzZzZzZzZzZzZzZz");
  });

  it("leaves ordinary output alone", () => {
    emit("tool_result", { result: "3 files changed, 12 insertions(+)" });

    expect(lines[0]).toContain("3 files changed, 12 insertions(+)");
    expect(lines[0]).not.toContain("[redacted]");
  });
});
