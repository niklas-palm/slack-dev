// Concurrency and injection tests driven through a REAL Agent — real tool executor, real hooks — with a
// scripted model. Note: this does NOT reproduce the executor's inter-tool microtask gap, so it wouldn't
// catch a timing-based mechanism; the code deliberately no longer depends on timing.

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
} from "@strands-agents/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.WORKSPACE_DIR = realpathSync(
  mkdtempSync(join(tmpdir(), "slack-conc-test-")),
);
process.env.SLACK_BOT_TOKEN = "not-a-real-token";

const { buildAgent, restoreInFlight, runAgent } = await import("./agent.js");
const { newSlackTurn, isWaiting } = await import("./slack-tools.js");
const { deliver, drain } = await import("./agent.js");
const { SLACK_TOOLS } = await import("./slack-tools.js");

const byName = (n: string) =>
  (
    SLACK_TOOLS as unknown as Array<{
      name: string;
      invoke: (i: unknown, c?: unknown) => Promise<unknown>;
    }>
  ).find((t) => t.name === n)!;
const postCount = (): number =>
  calls.filter((c) => c.method === "chat.postMessage").length;

/** Slack calls this run saw, in order. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;
/** Per-method delay, so a test can make posts slower than reactions or vice versa. */
let delays: Record<string, number>;
/** Methods that should fail, e.g. a rejected reaction — or the exact `text` of one post to reject. */
let failing: Set<string>;

function stubSlack(): void {
  calls = [];
  delays = {};
  failing = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const method = new URL(url).pathname.replace("/api/", "");
      const body = init?.body
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
      calls.push({ method, body });
      const wait = delays[method] ?? 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const ok =
        !failing.has(method) &&
        !(typeof body.text === "string" && failing.has(body.text));
      return {
        ok: true,
        status: 200,
        json: async () =>
          ok ? { ok: true, ts: "1.0" } : { ok: false, error: "ratelimited" },
      } as unknown as Response;
    }),
  );
}

/**
 * Replace the agent's model with one that emits a scripted batch of tool calls, then finishes.
 *
 * Patching `agent.model.stream` keeps everything else real — the executor, the hooks, the tools.
 */
function scriptModel(
  agent: { model: { stream: unknown } },
  batch: Array<{ name: string; input: unknown }>,
): { rounds: () => number } {
  let turn = 0;
  const rounds = (): number => turn;
  (agent.model as { stream: unknown }).stream =
    async function* (): AsyncGenerator<unknown> {
      turn++;
      if (turn === 1) {
        yield new ModelMessageStartEvent({
          type: "modelMessageStartEvent",
          role: "assistant",
        });
        for (const [i, t] of batch.entries()) {
          yield new ModelContentBlockStartEvent({
            type: "modelContentBlockStartEvent",
            start: { type: "toolUseStart", name: t.name, toolUseId: `t${i}` },
          });
          yield new ModelContentBlockDeltaEvent({
            type: "modelContentBlockDeltaEvent",
            delta: {
              type: "toolUseInputDelta",
              input: JSON.stringify(t.input),
            },
          });
          yield new ModelContentBlockStopEvent({
            type: "modelContentBlockStopEvent",
          });
        }
        yield new ModelMessageStopEvent({
          type: "modelMessageStopEvent",
          stopReason: "toolUse",
        });
        return;
      }
      yield new ModelMessageStartEvent({
        type: "modelMessageStartEvent",
        role: "assistant",
      });
      yield new ModelContentBlockStartEvent({
        type: "modelContentBlockStartEvent",
      });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "finished" },
      });
      yield new ModelContentBlockStopEvent({
        type: "modelContentBlockStopEvent",
      });
      yield new ModelMessageStopEvent({
        type: "modelMessageStopEvent",
        stopReason: "endTurn",
      });
    };
  return { rounds };
}

beforeEach(stubSlack);
afterEach(() => vi.unstubAllGlobals());

const target = {
  channel_id: "C_REAL",
  thread_ts: "1.1",
  trigger_message_ts: "1.2",
};

/** Run one scripted batch through the real agent loop and return the resulting turn state. */
async function runBatch(
  batch: Array<{ name: string; input: unknown }>,
  setup?: () => void,
): Promise<{
  turn: ReturnType<typeof newSlackTurn>;
  reactions: Set<string>;
  results: string;
  outcome: string;
  /** How many times the model was called — i.e. did it get a round to fix a failure? */
  rounds: number;
}> {
  const agent = buildAgent("concurrency-test");
  const scripted = scriptModel(
    agent as unknown as { model: { stream: unknown } },
    batch,
  );
  setup?.();

  const turn = newSlackTurn(target);
  // Capture what each tool returned INTO the conversation. A false warning is invisible in turn state —
  // it only exists in the string the model reads, which is how two "verified" fixes shipped broken.
  const results: string[] = [];
  const drive = (async () => {
    const stream = agent.stream("go" as never, {
      invocationState: { slackTurn: turn },
    });
    for await (const event of stream) {
      const e = event as { type?: string; result?: { content?: unknown } };
      if (e.type === "toolResultEvent")
        results.push(JSON.stringify(e.result?.content ?? ""));
    }
    return "returned";
  })();
  // A gate that never opens HANGS the turn rather than failing it, so bound the wait and report that as
  // an outcome. Vitest's own timeout would only say "slow test" — which is how a hung turn shipped once.
  const outcome = await Promise.race([
    drive,
    new Promise<string>((r) => setTimeout(() => r("HUNG"), 2000)),
  ]);

  // What the message actually shows: adds minus removes, in call order — counting only calls Slack
  // ACCEPTED, since a rejected add leaves no reaction behind.
  const reactions = new Set<string>();
  for (const c of calls) {
    if (
      failing.has(c.method) ||
      (typeof c.body.text === "string" && failing.has(c.body.text))
    )
      continue;
    if (c.method === "reactions.add") reactions.add(String(c.body.name));
    if (c.method === "reactions.remove") reactions.delete(String(c.body.name));
  }
  return {
    turn,
    reactions,
    results: results.join(" "),
    outcome,
    rounds: scripted.rounds(),
  };
}

describe("the real tool executor", () => {
  it("registers batch intent before any tool body runs", async () => {
    // The premise the whole design rests on: one settle-promise per declared tool, created before any
    // body runs. Without it set_thread_status is back to guessing whether a reply is coming.
    const { turn } = await runBatch([
      { name: "set_thread_status", input: { status: "done" } },
      { name: "reply_to_thread", input: { text: "THE ANSWER" } },
    ]);
    expect([...turn.pending.values()].map((p) => p.name).sort()).toEqual([
      "reply_to_thread",
      "set_thread_status",
    ]);
  });
});

describe("a reply batched with a status change", () => {
  // Rounds 4-6 each shipped a false warning here, because they only checked turn state. Whether the
  // model is misled lives in the tool RESULT — so assert on that, in BOTH orderings: awaiting the turn
  // lock only observes work that already entered it, so status-listed-first had nothing to wait for.
  for (const statusFirst of [true, false]) {
    it(`does not warn about a missing reply (status ${statusFirst ? "first" : "second"})`, async () => {
      const reply = { name: "reply_to_thread", input: { text: "THE ANSWER" } };
      const status = { name: "set_thread_status", input: { status: "done" } };
      const { turn, results } = await runBatch(
        statusFirst ? [status, reply] : [reply, status],
        () => {
          delays["chat.postMessage"] = 30; // the post is the slow one, which is realistic
        },
      );

      expect(turn.replied, "the reply must have landed").toBe(true);
      expect(turn.status).toBe("done");
      expect(
        results,
        "the reply DID land, so the warning would be a lie",
      ).not.toContain("seen NOTHING");
    });
  }
});

describe("a question batched with an answer", () => {
  // The strand: ask_user claims the thread is waiting while a reply in the same batch answers it.
  // Reactions slower than the post is the timing that used to strand the thread.
  it("leaves the thread answered, not waiting", async () => {
    const { turn, reactions } = await runBatch(
      [
        { name: "ask_user", input: { question: "Which environment?" } },
        { name: "reply_to_thread", input: { text: "Worked it out: staging." } },
      ],
      () => {
        delays["reactions.add"] = 15;
        delays["reactions.remove"] = 15;
      },
    );

    expect(turn.replied).toBe(true);
    expect(
      isWaiting(turn),
      "an answered question must not leave the thread waiting",
    ).toBe(false);
    // The state must agree with what Slack actually shows — the bug where they diverged.
    expect(
      reactions.has("question"),
      "the ❓ reaction must not survive an answer",
    ).toBe(false);
  });
});

describe("a question batched with a reply Slack rejected", () => {
  // ask_user steps aside for a reply in the same batch — but only a reply that DELIVERED. Deferring to a
  // failed one left a question with no ❓ and no terminal reaction: the thread just stops.
  it("still leaves the thread waiting", async () => {
    const { turn } = await runBatch(
      [
        { name: "ask_user", input: { question: "Which environment?" } },
        { name: "reply_to_thread", input: { text: "staging" } },
      ],
      () => failing.add("staging"), // only the REPLY is rejected; the question posts fine
    );

    expect(
      [...turn.posted.keys()].some((k) => k.startsWith("reply ")),
      "the reply never reached Slack",
    ).toBe(false);
    expect(isWaiting(turn), "the question must still own the turn").toBe(true);
  });
});

describe("a question asked after an earlier progress update", () => {
  // `posted` accumulates across the WHOLE turn, so using it to answer "did the model also reply in THIS
  // batch?" meant one progress update — which prompt.ts tells the agent to post on slow work — disabled
  // ask_user for the rest of the turn: the question posted with no ❓, the turn didn't end waiting, and
  // the runtime then marked the thread 🔴 under an open question.
  it("still parks the thread on the question", async () => {
    const agent = buildAgent("two-round");
    const turn = newSlackTurn(target);
    let round = 0;
    (agent.model as unknown as { stream: unknown }).stream =
      async function* (): AsyncGenerator<unknown> {
        round++;
        const batch =
          round === 1
            ? [
                {
                  name: "reply_to_thread",
                  input: { text: "Looking into the deploy failure…" },
                },
              ]
            : round === 2
              ? [{ name: "ask_user", input: { question: "Staging or prod?" } }]
              : [];
        yield new ModelMessageStartEvent({
          type: "modelMessageStartEvent",
          role: "assistant",
        });
        if (!batch.length) {
          yield new ModelContentBlockStartEvent({
            type: "modelContentBlockStartEvent",
          });
          yield new ModelContentBlockDeltaEvent({
            type: "modelContentBlockDeltaEvent",
            delta: { type: "textDelta", text: "done" },
          });
          yield new ModelContentBlockStopEvent({
            type: "modelContentBlockStopEvent",
          });
          yield new ModelMessageStopEvent({
            type: "modelMessageStopEvent",
            stopReason: "endTurn",
          });
          return;
        }
        for (const [i, t] of batch.entries()) {
          yield new ModelContentBlockStartEvent({
            type: "modelContentBlockStartEvent",
            start: {
              type: "toolUseStart",
              name: t.name,
              toolUseId: `r${round}-${i}`,
            },
          });
          yield new ModelContentBlockDeltaEvent({
            type: "modelContentBlockDeltaEvent",
            delta: {
              type: "toolUseInputDelta",
              input: JSON.stringify(t.input),
            },
          });
          yield new ModelContentBlockStopEvent({
            type: "modelContentBlockStopEvent",
          });
        }
        yield new ModelMessageStopEvent({
          type: "modelMessageStopEvent",
          stopReason: "toolUse",
        });
      };

    await runAgent(agent, "why did the deploy fail?", "two-round", turn);

    expect(
      isWaiting(turn),
      "the question owns the turn — nothing answered it",
    ).toBe(true);
  });
});

describe("a question-only turn", () => {
  // `replied` means "an ANSWER reached the human". Counting ask_user's own question as a reply
  // suppressed set_thread_status's "you have posted nothing" warning and told the runtime the turn was a
  // silent success — so a turn that only ever asked something closed 🟢.
  it("is not reported as a delivered answer", async () => {
    const { turn, results } = await runBatch([
      { name: "ask_user", input: { question: "Which environment?" } },
      { name: "set_thread_status", input: { status: "done" } },
    ]);

    expect(turn.replied, "a question is not an answer").toBe(false);
    expect(results, "the model must be told nothing was answered").toContain(
      "seen NOTHING",
    );
  });
});

describe("a reply Slack rejected alongside one it accepted", () => {
  // The model sees the error in its tool result, but endTurn denied it the round needed to act on it:
  // the surviving sibling set `replied`, the status went terminal, and the lost message was reported as
  // a success. A failed post must keep the turn open.
  it("does not end the turn", async () => {
    const { turn, rounds } = await runBatch(
      [
        { name: "reply_to_thread", input: { text: "PART 1" } },
        { name: "reply_to_thread", input: { text: "PART 2" } },
        { name: "set_thread_status", input: { status: "done" } },
      ],
      () => failing.add("PART 2"),
    );

    expect(turn.failedPosts, "one post was refused").toBeGreaterThan(0);
    // The point: the model gets ANOTHER round to retry the lost message. Ending the turn here would
    // report the rejected reply as a success and the human would never see it.
    expect(rounds, "a failed post must not end the turn").toBeGreaterThan(1);
  });
});

describe("a declared reply the executor rejects before its body runs", () => {
  // The gate is opened by a hook, not by the tools, and this is why. `reply_to_thread` is
  // z.string().min(1), so an empty text fails schema validation and the BODY NEVER RUNS — a release
  // written into the tool never fires, set_thread_status waits forever, and the turn hangs on 🟡 until
  // the microVM is reaped 8h later (with `running` never cleared, so every later mention in the thread
  // is swallowed as an injection and answered by nobody). AfterToolCallEvent fires on every path.
  it("does not hang the turn", async () => {
    const { outcome, turn } = await runBatch([
      { name: "set_thread_status", input: { status: "done" } },
      { name: "reply_to_thread", input: { text: "" } },
    ]);

    expect(outcome, "a gate that never opens hangs the whole turn").toBe(
      "returned",
    );
    // Nothing was posted, so the runtime must be able to see that and fall back.
    expect(turn.replied).toBe(false);
  });
});

describe("a declared reply the executor rejects, alongside one that posted", () => {
  // The OTHER half of postFailedThisBatch. The test above covers a schema-rejected reply on its own, so
  // nothing posted and `replied` stayed false — the runtime's fallback catches that. This is the case
  // that hides: a sibling reply DID post, so `replied` is true and the status went terminal, and the
  // rejected one is silently dropped. `failedPosts` can't see it (the body never ran, so nothing counted
  // it), which is exactly why postFailedThisBatch also reads `p.ok === false` from the hook. Verified
  // red: reducing that function to `return turn.failedPosts > 0` ends this turn at one round.
  it("still gets another round, so the lost message can be retried", async () => {
    const { turn, rounds } = await runBatch([
      { name: "reply_to_thread", input: { text: "PART 1" } },
      { name: "reply_to_thread", input: { text: "" } },
      { name: "set_thread_status", input: { status: "done" } },
    ]);

    expect(turn.replied, "the surviving reply posted").toBe(true);
    expect(rounds, "a reply that never ran must not end the turn").toBeGreaterThan(1);
  });
});

// upload_file counted a failure only on the LAST step (completeUploadExternal). An upload that died
// earlier — getUploadURLExternal refused, no upload_url, the PUT non-2xx — returned a plain {error},
// which the SDK reports as a SUCCESSFUL call, so postFailedThisBatch stayed false and the turn went 🟢
// with the file silently lost. The person was told "report attached" and got no attachment.
describe("an upload that fails before the final step", () => {
  it("keeps the turn open like any other failed post", async () => {
    writeFileSync(join(process.env.WORKSPACE_DIR!, "report.txt"), "the report\n");
    const { turn, rounds } = await runBatch(
      [
        { name: "reply_to_thread", input: { text: "Report attached." } },
        { name: "upload_file", input: { path: "report.txt" } },
        { name: "set_thread_status", input: { status: "done" } },
      ],
      () => failing.add("files.getUploadURLExternal"),
    );

    expect(turn.failedPosts, "an upload that never reached Slack is a failed post").toBeGreaterThan(0);
    expect(rounds, "the model needs a round to retry the lost file").toBeGreaterThan(1);
  });
});

describe("turn state versus what Slack shows", () => {
  it("never records a status whose reaction Slack rejected", async () => {
    const { turn, reactions } = await runBatch(
      [
        { name: "reply_to_thread", input: { text: "THE ANSWER" } },
        { name: "set_thread_status", input: { status: "done" } },
      ],
      () => failing.add("reactions.add"),
    );

    expect(turn.replied).toBe(true);
    // The reaction never landed, so the state must not claim it did — otherwise the runtime skips its
    // fallback and the thread ends with no colour at all.
    expect(turn.status).not.toBe("done");
    expect(reactions.size).toBe(0);
  });
});

// Delivery and crash-recovery used to destroy each other. BeforeModelCallEvent splices the inbox EMPTY
// and pushes the correction into agent.messages, so that push is the ONLY copy — and runTurn's catch
// truncates agent.messages back to historyLength, taking it with it. drain() then found nothing, no
// follow-up turn was queued, and the person was told "mention me again" — where a retry re-runs the
// original request their correction was cancelling. agent.ts's header calls that the worst outcome.
describe("a correction delivered to a model call that then throws", () => {
  it("survives the crash so the runtime can requeue it", async () => {
    const agent = buildAgent("crash-recovery");
    deliver("crash-recovery", "stop, wrong repo");

    // One round-trip: the real BeforeModelCallEvent hook fires, empties the inbox, and records the
    // in-flight copy. That hook is the mechanism under test.
    (agent.model as unknown as { stream: unknown }).stream =
      async function* (): AsyncGenerator<unknown> {
        yield new ModelMessageStartEvent({ type: "modelMessageStartEvent", role: "assistant" });
        yield new ModelMessageStopEvent({ type: "modelMessageStopEvent", stopReason: "endTurn" });
      };
    await runAgent(agent, "do the thing", "crash-recovery");

    // The crash path's recovery. Without it the correction is gone from the inbox (spliced) AND from
    // agent.messages (truncated), so the drain in runTurn's `finally` requeues nothing.
    restoreInFlight("crash-recovery");
    expect(drain("crash-recovery"), "the correction must be recoverable").toEqual(["stop, wrong repo"]);
  });
});

// Mid-turn message injection. The thing worth testing: a message sent while the agent is working must
// reach the model on its NEXT round-trip, exactly once — not after the turn, and not repeatedly.
describe("injecting a message into a running turn", () => {
  it("delivers it to the model's next call, exactly once", async () => {
    const agent = buildAgent("inject-test");
    const seen: string[][] = [];
    let round = 0;

    // A model that runs two round-trips: call a tool, then finish. Record what it can see each time.
    (agent.model as unknown as { stream: unknown }).stream =
      async function* (): AsyncGenerator<unknown> {
        round++;
        seen.push(agent.messages.map((m) => JSON.stringify(m.content)));
        if (round === 1) {
          // Injected between round 1 and 2, i.e. while the agent is mid-task.
          deliver("inject-test", "stop, wrong repo");
          yield new ModelMessageStartEvent({
            type: "modelMessageStartEvent",
            role: "assistant",
          });
          yield new ModelContentBlockStartEvent({
            type: "modelContentBlockStartEvent",
            start: {
              type: "toolUseStart",
              name: "reply_to_thread",
              toolUseId: "t0",
            },
          });
          yield new ModelContentBlockDeltaEvent({
            type: "modelContentBlockDeltaEvent",
            delta: {
              type: "toolUseInputDelta",
              input: JSON.stringify({ text: "working on it" }),
            },
          });
          yield new ModelContentBlockStopEvent({
            type: "modelContentBlockStopEvent",
          });
          yield new ModelMessageStopEvent({
            type: "modelMessageStopEvent",
            stopReason: "toolUse",
          });
          return;
        }
        yield new ModelMessageStartEvent({
          type: "modelMessageStartEvent",
          role: "assistant",
        });
        yield new ModelContentBlockStartEvent({
          type: "modelContentBlockStartEvent",
        });
        yield new ModelContentBlockDeltaEvent({
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "ok" },
        });
        yield new ModelContentBlockStopEvent({
          type: "modelContentBlockStopEvent",
        });
        yield new ModelMessageStopEvent({
          type: "modelMessageStopEvent",
          stopReason: "endTurn",
        });
      };

    await runAgent(agent, "open a PR", "inject-test", newSlackTurn(target));

    expect(round, "the model should have run twice").toBe(2);
    expect(seen[0]!.join(" "), "not visible before it was sent").not.toContain(
      "wrong repo",
    );
    expect(seen[1]!.join(" "), "must reach the model's next call").toContain(
      "wrong repo",
    );
    // Labelled as newer than the original request, or the model can't tell it's a correction.
    expect(seen[1]!.join(" ")).toContain("while you were working");

    // Drained, not replayed: a third call must not see it again.
    const after = agent.messages.filter((m) =>
      JSON.stringify(m.content).includes("wrong repo"),
    );
    expect(after).toHaveLength(1);
  });

  it("keeps each session's messages to itself", async () => {
    deliver("session-a", "for A");
    const agent = buildAgent("session-b");
    let round = 0;
    let sawForeign = false;
    (agent.model as unknown as { stream: unknown }).stream =
      async function* (): AsyncGenerator<unknown> {
        round++;
        if (
          agent.messages.some((m) =>
            JSON.stringify(m.content).includes("for A"),
          )
        )
          sawForeign = true;
        yield new ModelMessageStartEvent({
          type: "modelMessageStartEvent",
          role: "assistant",
        });
        yield new ModelContentBlockStartEvent({
          type: "modelContentBlockStartEvent",
        });
        yield new ModelContentBlockDeltaEvent({
          type: "modelContentBlockDeltaEvent",
          delta: { type: "textDelta", text: "ok" },
        });
        yield new ModelContentBlockStopEvent({
          type: "modelContentBlockStopEvent",
        });
        yield new ModelMessageStopEvent({
          type: "modelMessageStopEvent",
          stopReason: "endTurn",
        });
      };

    await runAgent(agent, "hello", "session-b", newSlackTurn(target));
    expect(round).toBe(1);
    expect(
      sawForeign,
      "one thread's interruption must not leak into another",
    ).toBe(false);
  });
});

// A message can arrive after a turn's last model call, when the injection hook will never fire again.
// It must NOT be silently swallowed — an unanswered correction is the one outcome this feature must
// never produce. server.ts drains at the end of every turn and re-queues whatever is left.
describe("a message that arrives too late to inject", () => {
  it("is still retrievable so the runtime can answer it", () => {
    deliver("late-session", "STOP, wrong repo");
    expect(drain("late-session"), "must be recoverable, not lost").toEqual([
      "STOP, wrong repo",
    ]);
    // Drained once, so a later turn can't replay a stale correction.
    expect(drain("late-session")).toEqual([]);
  });

  it("gets answered even when its reply repeats the previous turn's text", async () => {
    // `posted` dedupes per turn, so re-queueing on the FINISHED turn silently dropped a reply that
    // reused earlier text — and the carried-over `status: done` meant the runtime warned nobody.
    // A re-queued turn must therefore be a fresh one on the same thread.
    const line = "On it — checking the deploy.";
    const first = newSlackTurn(target);
    await byName("reply_to_thread").invoke(
      { text: line },
      { invocationState: { slackTurn: first } },
    );
    const posted = postCount();

    const requeued = newSlackTurn(first.target);
    await byName("reply_to_thread").invoke(
      { text: line },
      { invocationState: { slackTurn: requeued } },
    );

    expect(
      postCount(),
      "the correction's reply must reach Slack",
    ).toBeGreaterThan(posted);
    expect(requeued.replied).toBe(true);
    expect(
      requeued.status,
      "a fresh turn must not inherit the old verdict",
    ).toBeNull();
  });
});
