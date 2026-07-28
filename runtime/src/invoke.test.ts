// The /invoke decisions: whether to run the turn at all, and where its terminal reaction lands.
// Both refusals were live bugs. Why they can't be 200s: see invoke-gate.ts.
import { describe, expect, it } from "vitest";

import { invokeGate } from "./invoke-gate.js";
import { alsoReactTo, type SlackTarget } from "./slack.js";

describe("invokeGate", () => {
  it("admits a normal turn", () => {
    expect(invokeGate("what is broken?", true)).toEqual({ ok: true });
  });

  // The exact statuses matter: the ingress retries a 5xx (a slow SSM read may succeed a second later)
  // and breaks on a 4xx, because an empty prompt is empty however many times you send it.
  it("rejects an empty prompt with a 4xx, not a 200", () => {
    const gate = invokeGate("", true);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(400);
  });

  it("rejects with a 5xx when the bot token is missing", () => {
    const gate = invokeGate("what is broken?", false);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(503);
  });

  // A missing token wins over a present prompt, but an empty prompt is checked first — there is nothing
  // to run either way, and 400 tells the truth about why.
  it("reports the empty prompt when both are wrong", () => {
    const gate = invokeGate("", false);
    expect(gate.ok === false && gate.status).toBe(400);
  });
});

// Injecting a mention into a running turn has to reach the terminal reaction, or the person who corrected
// the agent watches a bare 👀 while the turn they joined goes 🟢 on someone else's message.
describe("alsoReactTo", () => {
  const target = (): SlackTarget => ({ channel_id: "C1", thread_ts: "1.0" });

  it("collects each injected message", () => {
    const t = target();
    alsoReactTo(t, "2.0");
    alsoReactTo(t, "3.0");
    expect(t.alsoReactTo).toEqual(["2.0", "3.0"]);
  });

  // Not cosmetic: setThreadStatus reacts to every ts on EVERY status change, so a duplicate is a wasted
  // Slack call per transition — and Slack rate-limits reactions.
  it("never records the same message twice", () => {
    const t = target();
    alsoReactTo(t, "2.0");
    alsoReactTo(t, "2.0");
    expect(t.alsoReactTo).toEqual(["2.0"]);
  });

  // Unbounded, this multiplies EVERY status change by 4 Slack calls per timestamp — and /terminate has a
  // 60s ceiling that cannot be raised. Keep the newest, since that's the correction someone's waiting on.
  it("caps the list, keeping the most recent", () => {
    const t = target();
    for (let i = 0; i < 20; i++) alsoReactTo(t, `${i}.0`);
    expect(t.alsoReactTo).toHaveLength(4);
    expect(t.alsoReactTo?.at(-1)).toBe("19.0");
  });
});
