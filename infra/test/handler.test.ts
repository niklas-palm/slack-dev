// Offline tests for the Slack ingress. The signature check is the ONLY thing standing between a
// public URL and an agent with repository credentials, so it gets the most attention here.
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

process.env.AWS_REGION = "eu-west-1";
process.env.SESSION_TABLE = "test-sessions";
process.env.MICROVM_IMAGE_ARN_PARAM = "/slack-dev/test/microvm-image-arn";
process.env.MICROVM_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
process.env.SIGNING_SECRET_PARAM = "/slack-dev/test/slack-signing-secret";
process.env.BOT_TOKEN_PARAM = "/slack-dev/test/slack-bot-token";

const { channelAllowed, sessionIdFor, stripMention, verifySignature } =
  await import("../lambda/slack-events/handler.js");

const SECRET = "test-signing-secret";

function sign(body: string, timestampSeconds: number): string {
  return (
    "v0=" +
    createHmac("sha256", SECRET)
      .update(`v0:${timestampSeconds}:${body}`)
      .digest("hex")
  );
}

describe("verifySignature", () => {
  const now = 1_800_000_000_000; // fixed clock
  const nowSeconds = now / 1000;
  const body = '{"type":"event_callback"}';

  it("accepts a correctly signed, fresh request", () => {
    expect(
      verifySignature(
        sign(body, nowSeconds),
        String(nowSeconds),
        body,
        SECRET,
        now,
      ),
    ).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(
      verifySignature(
        sign(body, nowSeconds),
        String(nowSeconds),
        body,
        "other-secret",
        now,
      ),
    ).toBe(false);
  });

  it("rejects a tampered body even with a valid-looking signature", () => {
    const signature = sign(body, nowSeconds);
    expect(
      verifySignature(signature, String(nowSeconds), body + " ", SECRET, now),
    ).toBe(false);
  });

  it("rejects a replay older than five minutes", () => {
    const stale = nowSeconds - 301;
    expect(
      verifySignature(sign(body, stale), String(stale), body, SECRET, now),
    ).toBe(false);
  });

  it("accepts a timestamp just inside the replay window", () => {
    const recent = nowSeconds - 299;
    expect(
      verifySignature(sign(body, recent), String(recent), body, SECRET, now),
    ).toBe(true);
  });

  it("rejects missing or malformed headers", () => {
    expect(
      verifySignature(undefined, String(nowSeconds), body, SECRET, now),
    ).toBe(false);
    expect(
      verifySignature(sign(body, nowSeconds), undefined, body, SECRET, now),
    ).toBe(false);
    expect(
      verifySignature(
        sign(body, nowSeconds),
        "not-a-number",
        body,
        SECRET,
        now,
      ),
    ).toBe(false);
    expect(
      verifySignature("v0=short", String(nowSeconds), body, SECRET, now),
    ).toBe(false);
  });
});

describe("sessionIdFor", () => {
  it("is a safe key — no characters that would need escaping downstream", () => {
    // It's a DynamoDB partition key and the agent's in-VM session id. AgentCore's old 33-char minimum
    // and no-dots rule are gone with it, so a Slack ts can pass through readably.
    const id = sessionIdFor("1719000000.000200");
    expect(id).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(id).toContain("1719000000.000200");
  });

  it("is stable per thread — that's what reuses the warm session", () => {
    expect(sessionIdFor("1719000000.000200")).toBe(
      sessionIdFor("1719000000.000200"),
    );
    expect(sessionIdFor("1719000000.000200")).not.toBe(
      sessionIdFor("1719000000.000300"),
    );
  });
});

describe("stripMention", () => {
  it("removes the bot mention and surrounding whitespace", () => {
    expect(stripMention("<@U123ABC> check the logs")).toBe("check the logs");
  });

  it("removes mentions anywhere in the text", () => {
    expect(stripMention("hey <@U123ABC> ping <@U456DEF> too")).toBe(
      "hey ping too",
    );
  });

  it("leaves plain text alone", () => {
    expect(stripMention("no mention here")).toBe("no mention here");
  });
});

// The channel allowlist. Second only to the signature check in what it guards: without it, anyone in a
// large workspace who can /invite the bot can put an agent with repo credentials to work.
describe("channelAllowed", () => {
  const allowed = ["C0AAAAAAA", "C0BBBBBBB"];

  it("admits an approved channel", () => {
    expect(channelAllowed("C0AAAAAAA", allowed)).toBe(true);
    expect(channelAllowed("C0BBBBBBB", allowed)).toBe(true);
  });

  it("rejects any other channel", () => {
    expect(channelAllowed("C0CCCCCCC", allowed)).toBe(false);
  });

  it("treats an empty list as no restriction", () => {
    // The default for a small workspace. Deliberate, and documented in setup.md — but it must be an
    // explicit empty list, never the accidental result of a missing env var being read as "".
    expect(channelAllowed("C0ANYTHING", [])).toBe(true);
  });

  it("matches exactly — no prefix or case slack", () => {
    // A substring match would let "C0AAAAAAAX" through, and Slack ids are case-sensitive.
    expect(channelAllowed("C0AAAAAAAX", allowed)).toBe(false);
    expect(channelAllowed("c0aaaaaaa", allowed)).toBe(false);
    expect(channelAllowed("", allowed)).toBe(false);
  });
});
