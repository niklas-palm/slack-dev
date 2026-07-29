// The in-VM /invoke endpoint is unauthenticated and takes channel_id from its request body, so the
// ingress allowlist alone was bypassable from inside: a prompt-injected agent running
// `curl localhost:9000/invoke -d '{"slack":{"channel_id":"C_ELSEWHERE",…}}'` could post anywhere the bot
// is a member — defeating the one control that bounds where the agent can speak. So the runtime
// re-validates rather than trusting the invocation.
//
// Own file because slack.ts reads ALLOWED_CHANNELS at import time; setting it here keeps the other
// suites on the unrestricted default.
process.env.ALLOWED_CHANNELS = "C_ALLOWED C_ALSO";

import { describe, expect, it } from "vitest";

const { asSlackTarget, channelAllowedHere } = await import("./slack.js");

describe("the runtime's own channel allowlist", () => {
  it("accepts a channel the config named", () => {
    expect(channelAllowedHere("C_ALLOWED")).toBe(true);
    expect(asSlackTarget({ channel_id: "C_ALSO", thread_ts: "1.0" })).toBeDefined();
  });

  it("refuses a channel the invocation invented", () => {
    expect(channelAllowedHere("C_ATTACKER")).toBe(false);
    // asSlackTarget returning undefined is what stops the turn: no target, no Slack calls at all.
    expect(asSlackTarget({ channel_id: "C_ATTACKER", thread_ts: "1.0" })).toBeUndefined();
  });

  it("splits on either separator", () => {
    // The image bakes it space-separated (the microVM CLI's --environment-variables is comma-delimited,
    // so commas there would parse as separate variables); the ingress uses commas.
    expect(channelAllowedHere("C_ALSO"), "space-separated list must parse").toBe(true);
  });
});
