# Contributing

Contributions are welcome, and so is forking this and taking it your own way — it's MIT-0, and it's a
sample as much as a product.

**Getting started**

```bash
npm install
npm run check      # typecheck + the offline tests. No AWS account needed.
```

`npm run check` works on a fresh clone with no `agent.config.json` and no credentials, so you can make
and verify most changes without touching AWS.

- **Found a bug or want a feature?** Open an issue. A reproduction beats a description.
- **Security issue?** Don't open an issue — see [SECURITY.md](./SECURITY.md).
- **Sending a PR?** One concern per PR, `npm run check` green, and a regression test for any bug fixed.
  Read the two sections below first if you're touching either subsystem they cover.

House rules, the commands, and the docs-update checklist live in [CLAUDE.md](./CLAUDE.md) — the entry
point for humans and coding agents alike; the short version is that a behaviour change updates the docs
in the same PR. The rest of THIS file is the deep end: the two subsystems where a reasonable-looking
change has already gone wrong.

Three things here will cost you real time if you don't read them first: the concurrency design in
`runtime/src/slack-tools.ts`, the two lockfiles, and which of the build loops catches which class of bug.
The first two encode bugs that were expensive to find.

## Before changing the Slack tools

The agent's tools run **concurrently** (the SDK default, and deliberately — see below), so two can touch
the same thread in one batch: reply while asking a question, mark done while a reply is in flight. Two
mechanisms keep that honest, and it takes both.

**1. One per-turn lock (`withTurn`).** Every mutation a tool makes to the turn's Slack state, and the
Slack call it describes, happen inside it; anything derivable is derived rather than stored. This is the
boring part, and it replaced three cleverer mechanisms that each ordered one pair of operations correctly
and mis-ordered another.

**2. A promise gate per declared tool call.** `set_thread_status` must not tell the model "the human has
seen NOTHING" about a reply that is about to land, and `ask_user` must not leave ❓ on a question its own
batch already answered. Awaiting the lock can't answer either question — the lock only shows work that
has **already entered** it, so whichever tool the model happened to list first won. Instead a
`BeforeToolsEvent` hook registers a promise per tool call in the batch, and those two tools await the
*posting* ones before judging what the human saw.

Four properties of the gate are load-bearing:

- **Keyed by tool-use id, not name** — a batch calling one tool twice needs two independent gates.
- **Both ends live in hooks** (`runtime/src/agent.ts`), not in the tool bodies. Releasing from inside a
  body looked equivalent and wasn't: a declared `reply_to_thread` whose text fails schema validation
  never runs its body, so its gate never opened and the turn hung on 🟡 until the microVM was reaped hours
  later. `AfterToolCallEvent` fires however a call ended, so it can't be skipped.
- **Scoped to the batch, not the turn** — an early "Looking into it…" must not be mistaken for an answer
  to a question asked three rounds later, or one progress update disables `ask_user` for the rest of the
  turn.
- **Delivery is read from what Slack accepted**, never from a parallel flag that could disagree.

**3. One retry, then stop (`statusFailed`).** A failed status reaction used to return the hint "try
again", so the model tried again — for ever, when the refusal was permanent (`message_not_found` on a
deleted trigger message). One live turn called `set_thread_status` three times on the same dead message.
The loop was OURS: the model was obeying our hint. So the first failure invites exactly one retry and
every later one says *don't*. `ask_user` invites one too, but insists on the **identical** question —
`postOnce` dedupes on kind+text, so the same wording retries only the reaction while a reworded one posts
twice.

The flag belongs to `set_thread_status` alone. `ask_user` briefly wrote it as well, which bought nothing
(it never read it) and broke the reset: a rate-limited ❓ made the FIRST failure of a later
`set_thread_status` look like the second, so a good answer ended with a spurious ⚠️. If you ever want
per-tool give-up for `ask_user`, give it its own field.

This is the one piece of per-turn state that is **stored rather than derived**, against the rule above,
because "have we already asked for a retry?" isn't recoverable from anything Slack tells us. Two things
about it matter: it is **reset on success** (a transient blip early in a turn must not make the FIRST
failure of the real closing sequence look like the second — otherwise a good answer ends with a spurious
⚠️), and giving up is the right trade because the reply has already landed and the runtime attempts the
reaction again at turn end. If Slack refuses permanently, the honest outcome is a reply with **no colour**.

**Don't switch to `toolExecutor: "sequential"`.** Two reasons. It's slower where it matters: a
three-command fan-out measures ~13.7s concurrent vs ~21.3s sequential end-to-end, because the agent's
fan-out tool is `run_bash` (greps, `gh api`, log queries), not local file reads. And `settleDeclaredPosts`
waits for a *sibling* call while holding its own tool slot, so sequential execution would **deadlock** a
turn that lists `set_thread_status` before its reply. Remove the gate first if you ever want to.

Tests for this live in `runtime/src/concurrency.test.ts`, driving a real `Agent` and real tool executor
with a scripted model. They assert on the **tool result string the model reads**, in both tool orderings
— turn state alone looked correct in three earlier attempts at this fix. If you change the mechanism,
verify each test goes red against the old behaviour, not just green against the new.

## Changing a runtime dependency touches TWO lockfiles

The root lockfile is what `npm run check` tests against. `runtime/package-lock.json` is what the image
actually installs (`npm ci`, and the Docker build context is `runtime/` only, so it cannot see the root
one). A root `npm install` does **not** update it, so it goes stale silently and the image keeps shipping
the old versions — invisible in a diff.

```bash
cd /tmp && mkdir -p lockgen && cd lockgen
cp <repo>/runtime/package.json <repo>/runtime/package-lock.json .
npm install <pkg>@<version> --package-lock-only   # copying the lockfile too keeps transitives pinned
cp package-lock.json <repo>/runtime/
```

Copy the existing lockfile across, not just `package.json` — regenerating from `package.json` alone
re-floats every transitive `^` range and widens the diff beyond the package you changed. Then run root
`npm install` as well, and commit both lockfiles.

**`npm run check` cannot see lockfile drift** — only `npm ci` can, and that's what CI runs first. If you
rename a workspace package, or change any `package.json` name/version, run `npm ci` from a clean tree
before pushing. A rename once passed every local check and failed CI in 15 seconds.

## The three loops

Shortest first — use the shortest one that can catch the class of bug you're chasing.

```bash
npm run check                                    # typecheck + tests, offline, ~30s
cd runtime && WORKSPACE_DIR=/tmp/agent env -u AWS_PROFILE npm run local -- "…"   # one turn, in-process
env -u AWS_PROFILE npm run docker -- "…"         # THE REAL IMAGE (from the repo root)
env -u AWS_PROFILE npm run image                 # register it as a microVM image (a few minutes)
```

`npm run docker` builds exactly the image a microVM boots and probes all five lifecycle hooks. It's the
only local loop that catches image-shaped bugs — a missing binary, the wrong Node major, dockerd failing
to start. Three real ones were found that way, each invisible to `npm run check`.

Two things to know about the image:

- **Everything the agent needs at run time must be installed in the Dockerfile.** A microVM's DNS is a
  loopback forwarder a nested build container can't reach, so `docker build` INSIDE a VM hangs on DNS.
  `docker pull` and `docker run` are fine. See [docs/lambda-microvms.md](./docs/lambda-microvms.md).
- **`PROMPT.md` ships in the image, not the stack.** So a prompt change is `npm run image`, never
  `npm run deploy`. The ingress reads the image ARN from SSM at call time.

## Conventions

Are in [CLAUDE.md](./CLAUDE.md#conventions) — one copy, so the two can't drift.
