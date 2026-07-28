// Tests for the Slack tools. Slack itself is stubbed via fetch — the point here is the CONTRACT the
// runtime depends on: which channel a tool can reach, whether `replied` gets tracked, and that a
// failure comes back as data rather than a throw.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.WORKSPACE_DIR = realpathSync(
  mkdtempSync(join(tmpdir(), "slack-tools-test-")),
);
// A non-secret placeholder: the tools only check that a token EXISTS, and fetch is stubbed below.
// Deliberately not shaped like a real "xoxb-…" token so secret scanners don't flag it.
process.env.SLACK_BOT_TOKEN = "not-a-real-token";

type ToolResult = Record<string, unknown>;
type Invokable = {
  name: string;
  invoke: (input: unknown, ctx?: unknown) => Promise<unknown>;
};

// Imported AFTER the env vars above, since config.ts reads them at module load. The real types come
// with them: an earlier version hand-mirrored `SlackTurn` as a local interface, which then had to be
// edited every time an internal field changed — including fields no test here reads.
const { SLACK_TOOLS, newSlackTurn, isWaiting } =
  await import("./slack-tools.js");
const { alsoReactTo, asSlackTarget, setThreadStatus, STATUS_EMOJI } = await import("./slack.js");
type SlackTurn = ReturnType<typeof newSlackTurn>;

const byName = new Map(
  (SLACK_TOOLS as unknown as Invokable[]).map((t) => [t.name, t]),
);

/** Every Slack call this test run saw: [method, parsed body]. */
let calls: Array<[string, Record<string, unknown>]>;
/** Queue of canned responses; anything unqueued gets a generic ok. */
let responses: Array<Record<string, unknown>>;

function stubSlack(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const method = new URL(url).pathname.replace("/api/", "");
      const body = init?.body
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
      // A GET tool (conversations.replies, files.info) carries its args in the query string.
      const params = Object.fromEntries(new URL(url).searchParams);
      calls.push([method, { ...params, ...body }]);
      const canned = responses.shift() ?? { ok: true, ts: "9999.0001" };
      return {
        ok: true,
        status: 200,
        json: async () => canned,
      } as unknown as Response;
    }),
  );
}

async function call(
  name: string,
  input: unknown,
  turn?: SlackTurn,
): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool)
    throw new Error(
      `no such tool: ${name} (have: ${[...byName.keys()].join(", ")})`,
    );
  return (await tool.invoke(input, {
    invocationState: turn ? { slackTurn: turn } : {},
  })) as ToolResult;
}

beforeEach(() => {
  calls = [];
  responses = [];
  stubSlack();
});

afterEach(() => vi.unstubAllGlobals());

const target = {
  channel_id: "C_REAL",
  thread_ts: "1785160000.000100",
  trigger_message_ts: "1785160000.000200",
};
const turn = (): SlackTurn => newSlackTurn(target);

describe("the Slack toolset", () => {
  it("exposes exactly the tools the prompt promises", () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        "ask_user",
        "download_file",
        "read_thread",
        "reply_to_thread",
        "set_thread_status",
        "upload_file",
      ].sort(),
    );
  });

  it("gives the model NO parameter that could redirect a message to another channel", () => {
    // The security property of tools-over-shell: the channel comes from the invocation, so it is not
    // something the model can name. If a `channel` input ever appears here, that's gone.
    for (const name of ["reply_to_thread", "ask_user", "upload_file"]) {
      const spec = (
        byName.get(name) as unknown as { toolSpec: { inputSchema: unknown } }
      ).toolSpec;
      const json = JSON.stringify(spec);
      expect(json, `${name} must not accept a channel`).not.toMatch(/channel/i);
      expect(json, `${name} must not accept a thread`).not.toMatch(
        /thread_ts/i,
      );
    }
  });
});

describe("reply_to_thread", () => {
  it("posts to the bound channel and thread, not anywhere the model chose", async () => {
    const t = turn();
    const result = await call("reply_to_thread", { text: "the answer" }, t);

    expect(result.success).toBe(true);
    const [method, body] = calls[0]!;
    expect(method).toBe("chat.postMessage");
    expect(body.channel).toBe("C_REAL");
    expect(body.thread_ts).toBe("1785160000.000100");
    expect(body.text).toBe("the answer");
    expect(body.unfurl_links).toBe(false);
  });

  it("marks the turn replied — the flag the runtime's fallback depends on", async () => {
    const t = turn();
    expect(t.replied).toBe(false);
    await call("reply_to_thread", { text: "hi" }, t);
    expect(t.replied).toBe(true);
  });

  it("passes text through verbatim, however it is quoted", async () => {
    // The reason these are tools and not a curl recipe: this text would have needed careful escaping.
    const nasty =
      "Backticks `x`, \"double\" and 'single' quotes, a $VAR, a \\backslash,\nand a newline.";
    await call("reply_to_thread", { text: nasty }, turn());
    expect(calls[0]![1].text).toBe(nasty);
  });

  it("does not post the same message twice in one turn", async () => {
    const t = turn();
    const first = await call("reply_to_thread", { text: "same" }, t);
    const second = await call("reply_to_thread", { text: "same" }, t);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(calls.filter(([m]) => m === "chat.postMessage")).toHaveLength(1);
  });

  it("returns a Slack error as data, with a hint, instead of throwing", async () => {
    responses = [{ ok: false, error: "missing_scope" }];
    const t = turn();
    const result = await call("reply_to_thread", { text: "hi" }, t);

    expect(result.error).toBe("missing_scope");
    expect(String(result.hint)).toMatch(/scope/);
    expect(t.replied).toBe(false); // a failed post must not count as a reply
  });

  it("explains itself when the turn did not come from Slack", async () => {
    const result = await call("reply_to_thread", { text: "hi" });
    expect(String(result.error)).toMatch(/did not come from Slack/);
    expect(calls).toHaveLength(0);
  });
});

describe("set_thread_status", () => {
  it("clears the other three status reactions before adding the new one", async () => {
    const t = turn();
    t.replied = true;
    await call("set_thread_status", { status: "done" }, t);

    const removed = calls
      .filter(([m]) => m === "reactions.remove")
      .map(([, b]) => b.name);
    const added = calls
      .filter(([m]) => m === "reactions.add")
      .map(([, b]) => b.name);

    // Mutual exclusion: a thread must never show 🟡 and 🟢 at once.
    expect(removed).toContain(STATUS_EMOJI.working);
    expect(removed).toContain(STATUS_EMOJI.waiting);
    expect(removed).toContain(STATUS_EMOJI.failed);
    expect(removed).not.toContain(STATUS_EMOJI.done);
    expect(added).toEqual([STATUS_EMOJI.done, STATUS_EMOJI.done]); // parent + trigger message
  });

  // Mentions that arrive mid-turn are folded into it, and each already carries a 👀 from the ingress. The
  // terminal reaction has to reach them too, or the person who corrected the agent watches a bare 👀
  // while the turn they joined goes 🟢 on someone else's message.
  it("reacts to messages injected into the turn as well", async () => {
    const target = asSlackTarget({ channel_id: "C1", thread_ts: "100.0", trigger_message_ts: "101.0" })!;
    alsoReactTo(target, "102.0");
    calls = [];

    expect(await setThreadStatus(target, "done")).toBe(true);
    const reacted = calls.filter(([m]) => m === "reactions.add").map(([, b]) => b.timestamp);
    expect(reacted).toEqual(["100.0", "101.0", "102.0"]);
  });

  // A courtesy reaction on an injected message is not the turn's outcome. Reporting false made the
  // runtime warn "I may not have finished everything" under a turn that succeeded, and whose own
  // messages were marked correctly.
  it("still reports success when only an injected message's reaction fails", async () => {
    const target = asSlackTarget({ channel_id: "C1", thread_ts: "100.0", trigger_message_ts: "101.0" })!;
    alsoReactTo(target, "102.0");
    calls = [];
    // 4 calls per timestamp (3 removes + 1 add); fail only the third timestamp's add.
    responses = [...Array(11).fill({ ok: true }), { ok: false, error: "ratelimited" }];

    expect(await setThreadStatus(target, "done")).toBe(true);
  });

  it("reports failure when the turn's OWN message can't be marked", async () => {
    const target = asSlackTarget({ channel_id: "C1", thread_ts: "100.0", trigger_message_ts: "101.0" })!;
    calls = [];
    responses = [...Array(3).fill({ ok: true }), { ok: false, error: "ratelimited" }];

    expect(await setThreadStatus(target, "done")).toBe(false);
  });

  // Observed live: three set_thread_status calls in ONE turn, each answered "try again", against a
  // message_not_found that could never succeed. The hint was ours, so the loop was ours.
  it("stops telling the model to retry a refusal that won't clear", async () => {
    const t = turn();
    t.replied = true;
    const hints: string[] = [];
    for (let i = 0; i < 3; i++) {
      responses = [{ ok: true }, { ok: true }, { ok: true }, { ok: false, error: "message_not_found" }];
      const r = (await call("set_thread_status", { status: "done" }, t)) as Record<string, string>;
      expect(r.success).toBe(false);
      hints.push(r.hint!);
    }
    // The invariant: the first failure invites one retry, and from the second on the hint tells the model
    // to stop. Asserted on the instruction, not on the word "again" — the give-up text legitimately
    // contains "again" ("the runtime attempts the reaction again when the turn ends").
    expect(hints[0]).toMatch(/try set_thread_status again/);
    expect(hints[1]).toMatch(/do NOT retry/);
    expect(hints[2]).toMatch(/do NOT retry/);
  });

  // Cross-tool version of the same trap: ask_user's failed ❓ used to set the shared flag, so the FIRST
  // failure of a later set_thread_status was treated as the second and told not to retry — ending a good
  // answer with a spurious "I may not have finished everything". ask_user never read that flag anyway.
  it("a rate-limited ask_user does not disarm set_thread_status's first retry", async () => {
    const t = turn();
    responses = [{ ok: true, ts: "5.0" }, { ok: true }, { ok: true }, { ok: true }, { ok: false, error: "ratelimited" }];
    await call("ask_user", { question: "Which env?" }, t);

    responses = [];
    await call("reply_to_thread", { text: "It's staging." }, t);

    responses = [{ ok: true }, { ok: true }, { ok: true }, { ok: false, error: "ratelimited" }];
    const st = (await call("set_thread_status", { status: "done" }, t)) as Record<string, string>;
    expect(st.hint, "attempt #1 for THIS tool must still invite a retry").toMatch(/try set_thread_status again/);
  });

  // A transient blip early in a turn must not disarm the retry the CLOSING status is entitled to. The
  // set-before-reply path makes this reachable: it tells the model to set the status again, so a single
  // `ratelimited` used to leave the counter armed and the real close got "do NOT retry" on attempt #1 —
  // ending the turn with status null and a spurious "I may not have finished everything".
  it("forgives an earlier failure once a status has landed", async () => {
    const t = turn();
    t.replied = true;
    responses = [{ ok: true }, { ok: true }, { ok: true }, { ok: false, error: "ratelimited" }];
    expect(((await call("set_thread_status", { status: "done" }, t)) as Record<string, unknown>).success).toBe(false);

    responses = []; // everything succeeds
    expect(((await call("set_thread_status", { status: "done" }, t)) as Record<string, unknown>).success).toBe(true);

    responses = [{ ok: true }, { ok: true }, { ok: true }, { ok: false, error: "ratelimited" }];
    const again = (await call("set_thread_status", { status: "done" }, t)) as Record<string, string>;
    expect(again.hint, "a fresh failure after a success is attempt #1, not #2").toMatch(/try set_thread_status again/);
  });

  it("never touches the 👀 acknowledgement", async () => {
    const t = turn();
    t.replied = true;
    await call("set_thread_status", { status: "done" }, t);
    expect(calls.every(([, b]) => b.name !== "eyes")).toBe(true);
  });

  it("applies the status to both the thread parent and the triggering message", async () => {
    const t = turn();
    t.replied = true;
    await call("set_thread_status", { status: "failed" }, t);
    const timestamps = new Set(
      calls.filter(([m]) => m === "reactions.add").map(([, b]) => b.timestamp),
    );
    expect(timestamps).toEqual(
      new Set([target.thread_ts, target.trigger_message_ts]),
    );
  });

  it("warns loudly when marking done without ever having replied", async () => {
    const t = turn();
    const result = await call("set_thread_status", { status: "done" }, t);
    expect(String(result.warning)).toMatch(/seen NOTHING/);
    expect(String(result.hint)).toMatch(/reply_to_thread/);
    // The endTurn hook must NOT fire here, or this recovery hint is unreachable and the turn ends having
    // lost the answer. The hook's condition is `replied && terminal`, so assert the state it reads.
    expect(
      t.replied,
      "the hook keys on replied — a false here is what keeps the loop alive",
    ).toBe(false);
  });

  it("records the status on the turn so the runtime knows not to override it", async () => {
    const t = turn();
    t.replied = true;
    await call("set_thread_status", { status: "failed" }, t);
    expect(t.status).toBe("failed");
  });

  // Regression: the status was recorded even when Slack REJECTED the reaction. The runtime then believed
  // the turn was closed while the thread sat on 🟡 — "a reaction that lies", which is the failure this
  // whole protocol exists to prevent. Worse once the endTurn hook shipped: it halted the loop on that
  // recorded status, so the model couldn't retry either.
  it("does not record a status Slack rejected", async () => {
    // Three removes succeed, then the add fails.
    responses = [
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: false, error: "ratelimited" },
    ];
    const t = turn();
    t.replied = true;

    const result = await call("set_thread_status", { status: "done" }, t);
    expect(result.success).toBe(false);
    expect(
      t.status,
      "recording it would tell the runtime the thread is closed when it shows 🟡",
    ).toBeNull();
    expect(String(result.hint), "the model must know to retry").toMatch(/try set_thread_status again/);
  });

  it("only accepts the two terminal statuses", async () => {
    // working is the runtime's to set; waiting belongs to ask_user.
    await expect(
      call("set_thread_status", { status: "working" }, turn()),
    ).rejects.toThrow();
  });
});

describe("ask_user", () => {
  it("posts the question, sets waiting, and flags the turn as waiting", async () => {
    const t = turn();
    const result = await call(
      "ask_user",
      { question: "Which environment?" },
      t,
    );

    expect(result.success).toBe(true);
    expect(result.waiting).toBe(true);
    expect(isWaiting(t)).toBe(true);
    expect(t.status).toBe("waiting");
    // A question is NOT an answer. Counting it as `replied` let a question-only turn end 🟢 with
    // set_thread_status's "you have posted nothing" warning suppressed, and told the runtime the turn
    // was a silent success.
    expect(t.replied).toBe(false);
    expect(
      calls.filter(([m]) => m === "reactions.add").map(([, b]) => b.name),
    ).toEqual([STATUS_EMOJI.waiting, STATUS_EMOJI.waiting]);
  });
});

describe("ask_user then answering anyway", () => {
  // Regression: clearing `waiting` on a reply (so the thread can't strand on ❓) left `status` stale at
  // "waiting". The turn was then neither waiting nor closed, so the runtime posted a failure warning
  // and 🔴 underneath a perfectly good answer. "Replied, no verdict yet" is status=null.
  it("clears the stale waiting STATUS, not just the flag", async () => {
    const t = turn();
    await call("ask_user", { question: "Which environment?" }, t);
    expect(t.status).toBe("waiting");

    await call("reply_to_thread", { text: "Worked it out: staging." }, t);
    expect(isWaiting(t)).toBe(false);
    expect(
      t.status,
      "a stale 'waiting' status makes the runtime report a failure",
    ).toBeNull();
  });

  // Regression: the clear lived AFTER the dedupe early-return, so a reply repeating earlier text (a
  // progress line, a short verdict) never cleared `waiting` — stranding the thread on ❓ silently, the
  // exact hang the clear was written to eliminate.
  it("clears waiting even when the reply duplicates earlier text", async () => {
    const t = turn();
    await call("reply_to_thread", { text: "On it." }, t);
    await call("ask_user", { question: "Which environment?" }, t);
    const again = await call("reply_to_thread", { text: "On it." }, t);

    expect(again.duplicate).toBe(true);
    expect(isWaiting(t), "a duplicate reply is still a reply").toBe(false);
    expect(t.status).toBeNull();
  });

  it("dedupes even when Slack omits the ts", async () => {
    // ts was stored as "" and read back with a truthy check, so the dedupe silently stopped working.
    responses = [{ ok: true }, { ok: true }, { ok: true }];
    const t = turn();
    for (let i = 0; i < 3; i++)
      await call("reply_to_thread", { text: "same" }, t);
    expect(calls.filter(([m]) => m === "chat.postMessage")).toHaveLength(1);
  });
});

describe("a rejected Slack reaction", () => {
  // Regression: ask_user set waiting/status BEFORE the call and ignored the result. Worse than the same
  // bug in set_thread_status, because server.ts early-returns on `waiting` and skips the terminal-status
  // guarantee — so a rejected reaction left the thread on bare 👀 (the remove-sweep had already cleared
  // 🟡) with no way for the model to retry.
  it("does not let ask_user claim it is waiting", async () => {
    responses = [
      { ok: true, ts: "1.0" },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: false, error: "ratelimited" },
    ];
    const t = turn();

    const result = await call(
      "ask_user",
      { question: "Which environment?" },
      t,
    );
    expect(result.success).toBe(false);
    expect(
      isWaiting(t),
      "claiming waiting would skip the terminal-status guarantee",
    ).toBe(false);
    expect(t.status).toBeNull();
    // NOT a bare /again/: "do NOT call ask_user again" matches that too, so the assertion would have
    // passed while asserting the opposite. Pin what the hint actually has to say — retry, same wording.
    expect(String(result.hint)).toMatch(/IDENTICAL/);
  });
});

describe("an unreadable Slack response", () => {
  // Regression: a non-JSON body (proxy error page, 5xx) parsed to {}, so tools returned
  // `{error: undefined}` — neither an error nor a success, the ambiguous shape the whole file forbids.
  it("still yields a usable error string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 502,
            json: async () => {
              throw new Error("not json");
            },
          }) as unknown as Response,
      ),
    );
    const result = await call("read_thread", {}, turn());
    expect(typeof result.error).toBe("string");
    expect(String(result.error).length).toBeGreaterThan(0);
    expect(String(result.error)).toMatch(/502/);
  });
});

describe("read_thread", () => {
  it("summarizes messages and surfaces attached file ids", async () => {
    responses = [
      {
        ok: true,
        messages: [
          { user: "U1", text: "hello", ts: "1.1" },
          {
            user: "U2",
            text: "see this",
            ts: "1.2",
            files: [
              { id: "F1", name: "log.txt", mimetype: "text/plain", size: 12 },
            ],
          },
        ],
      },
    ];
    const result = await call("read_thread", {}, turn());
    expect(result.count).toBe(2);
    const messages = result.messages as Array<Record<string, unknown>>;
    expect((messages[1]!.files as Array<{ id: string }>)[0]!.id).toBe("F1");
  });

  it("reads the bound thread and caps the limit at Slack's maximum", async () => {
    await call("read_thread", { limit: 5000 }, turn());
    const [, params] = calls[0]!;
    expect(params.channel).toBe("C_REAL");
    expect(params.ts).toBe(target.thread_ts);
    expect(params.limit).toBe("100");
  });
});

describe("download_file", () => {
  it("refuses a file that is not attached to this thread", async () => {
    // Being summoned to one thread shouldn't grant reach over every file the bot can see.
    responses = [
      { ok: true, messages: [{ user: "U1", text: "hi", ts: "1.1" }] },
    ];
    const result = await call(
      "download_file",
      { file_id: "F_ELSEWHERE" },
      turn(),
    );
    expect(String(result.error)).toMatch(/not attached to this thread/);
  });
});

describe("asSlackTarget", () => {
  it("accepts a well-formed payload", () => {
    expect(asSlackTarget({ channel_id: "C1", thread_ts: "1.1" })).toMatchObject(
      { channel_id: "C1", thread_ts: "1.1" },
    );
  });

  it("rejects anything missing the ids, so a malformed payload can't half-work", () => {
    for (const bad of [
      undefined,
      null,
      {},
      "string",
      { channel_id: "C1" },
      { thread_ts: "1.1" },
      { channel_id: 1, thread_ts: "1.1" },
    ]) {
      expect(asSlackTarget(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
