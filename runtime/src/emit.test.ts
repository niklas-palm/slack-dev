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
  delete process.env.SLACK_SIGNING_SECRET;
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
    // Hex, deliberately: a signing secret matches no pattern, so only the literal-value scrub can catch
    // it. An earlier version of this test used an `xoxb-…` shape, which the pattern loop redacted — so
    // the env-var scrub was never exercised and deleting it kept every test green.
    process.env.SLACK_SIGNING_SECRET = "8f3a1c9e2b7d4056a1f8e3c7b2d9046f";

    emit("tool_result", { result: `signed with ${process.env.SLACK_SIGNING_SECRET} ok` });

    expect(lines[0]).not.toContain("8f3a1c9e");
    expect(lines[0]).toContain("[redacted]");
  });

  it("redacts a secret nested anywhere in the payload", () => {
    emit("tool_input", { input: { deep: { list: ["ghp_ZzZzZzZzZzZzZzZzZzZzZz"] } } });

    expect(lines[0]).not.toContain("ghp_ZzZzZzZzZzZzZzZzZzZzZz");
  });

  // agent.ts slices tool_result at 4000 chars, so a PEM whose END marker falls past the cut used to be
  // emitted in the clear — reachable from a plain `env` or `head -5 key.pem`, no attack needed. The private
  // key is the ROOT credential (it mints the ghs_ tokens the other patterns catch), so this leaked more
  // than the bug redaction was added to fix.
  it("redacts a private key whose END marker was truncated away", () => {
    emit("tool_result", {
      result: "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqSECRETMATERIAL",
    });

    expect(lines[0]).not.toContain("SECRETMATERIAL");
    expect(lines[0]).toContain("[redacted]");
  });

  it("leaves ordinary output alone", () => {
    emit("tool_result", { result: "3 files changed, 12 insertions(+)" });

    expect(lines[0]).toContain("3 files changed, 12 insertions(+)");
    expect(lines[0]).not.toContain("[redacted]");
  });
});
