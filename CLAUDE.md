# Working in Slack Dev

A lightweight Slack-triggered engineering agent (Claude Opus 5) running in an **AWS Lambda MicroVM**,
with access to one GitHub repository where it iterates, debugs and opens PRs — plus the CDK that routes a
Slack mention to it. This file is the entry point for any coding agent working here; it carries the
rules, and points at the deeper docs rather than repeating them.

**Read before you change anything:**

| Doc | When |
|---|---|
| [README.md](./README.md) | What this is and how the pieces fit. Start here. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | **Mandatory** before touching `runtime/src/slack-tools.ts` (the concurrency design), a runtime dependency (two lockfiles), or the build loops. |
| [docs/lambda-microvms.md](./docs/lambda-microvms.md) | **Mandatory** before touching `infra/microvm/`, the Dockerfile, or anything calling the microVM API. |
| [setup.md](./setup.md) | The operator's runbook — the sequence a user follows, and the troubleshooting table. |
| [docs/iterating.md](./docs/iterating.md) | The two seams a user edits: `PROMPT.md` and `runtime/skills/`. Read before changing how either is loaded. |

---

## Non-negotiable principles

1. **Simplicity and readability first.** This is a SAMPLE: people clone it to learn from. Every extra
   concept a reader must hold is a cost. Prefer the straightforward solution, and prefer deleting to
   adding. If a mechanism needs a paragraph to justify, ask whether a simpler one would do.
2. **No over-engineering.** Don't add an abstraction with one caller, a config knob nobody asked for, or
   a layer for a problem we don't have. Sample code earns its keep by being obvious.
3. **Comments explain *why*, not *what*.** Most non-obvious lines here mark a bug that was paid for
   once — keep the reason attached to the code so the next person doesn't re-earn it.
4. **Verify by running, not by reasoning.** Claims about AWS APIs, images, or model behaviour get
   checked against the real thing. Several "obvious" assumptions in this repo's history were wrong.
5. **Never claim something works without evidence.** If tests fail, say so with the output. If a step
   was skipped, say that.

## Before opening a PR — every time

**Update the docs in the SAME change.** A stale doc is a bug, and in a sample it's a bug that misleads
every future reader. Ask: *did I change how someone runs, tests, deploys, or reasons about this?* If
yes, which of these did I update?

- **[README.md](./README.md)** — architecture, capabilities, guardrails, the trust boundary.
- **[setup.md](./setup.md)** — anything an operator does, plus the troubleshooting table.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — anything a contributor must know before editing.
- **[docs/](./docs/)** — deep subsystem detail. Verbose explanations belong HERE and are referenced from
  elsewhere, never inlined twice.
- **`runtime/PROMPT.md`** — only the template, if the base prompt's contract changed.
- **`skills/create-slack-dev/`** — the INSTALLER skill, which is how most people will set an agent up.
  **The copy in this repo is the source of truth**; `~/.claude/skills/` is just an install of it, so edit
  the repo and re-run `node skills/install.mjs`. If a command, permission or region changed, it changed
  in the skill and its `references/` too. Users get it with `npx github:niklas-palm/slack-dev`, which runs
  straight from the repo — so there is nothing to publish and no version to bump, and a merge to `main` IS
  the release.

Then, before you call it done:

```bash
npm run check      # typecheck + tests, offline, ~30s. Must be green.
```

**Prompt, tool-contract, or agent changes need a real-model run** — `npm run check` never exercises the
model, so you are the gate:

```bash
cd runtime && WORKSPACE_DIR=/tmp/agent env -u AWS_PROFILE npm run local -- "a request"
cd .. && env -u AWS_PROFILE npm run docker -- "a request"   # ...or the real image, for an image-shaped change
```

**Every bug fixed gets a regression test, verified RED against the old behaviour first.** A fix without
a reproduction is a guess. This repo has several cases where a "verified" fix was wrong because the test
passed either way.

## Commands

```bash
npm run check      # typecheck + tests, offline (~30s)   ← before every commit
npm run docker     # build + run the REAL microVM image locally, probe every hook
npm run image      # register the image in AWS           ← ships runtime/, incl. PROMPT.md
npm run deploy     # the routing around it: table, roles, webhook
npm run setup:oidc # ONE-TIME, BY HAND: the GitHub OIDC deploy role for THIS repo only
npm run invoke     # one turn against a deployed VM
npm run synth      # CDK template, no deploy
npm run secrets    # store/rotate any secret in SSM
node skills/install.mjs   # (re)install the create-slack-dev skill from this repo's copy
```

**`npm run image` and `npm run deploy` are different jobs, and confusing them is the most common
mistake.** The image carries the agent (prompt, skills, tools); the stack only routes to it. So a
`PROMPT.md` edit needs `image`, never `deploy`. The ingress reads the image ARN from SSM at call time.

Every AWS command needs `env -u AWS_PROFILE` so the SDK uses the shell's temporary credentials rather
than a profile.

**CI is keyless.** `.github/workflows/deploy.yml` assumes an IAM role via GitHub OIDC — no AWS keys
anywhere. The role trusts only this repo's `main`, and it can publish the image ARN but **cannot read
any agent's secrets**; don't widen either without saying so. Created by
`scripts/setup-github-oidc.sh`, imperatively and by hand: it's the identity that performs deploys, so a
deploy must not be able to widen its own permissions — and it's core-only, not something a spoke agent
should carry.

`.github/` belongs to THIS repo only. A clone made to run an agent for a different project deletes it —
it would otherwise be a workflow in someone else's repository deploying into this account. The
`create-slack-dev` skill does that removal automatically.

## Architecture in one screen

```
Slack @mention → API Gateway → ingress Lambda        (verify HMAC · channel allowlist · 👀)
                                    │
                                    ├─ DynamoDB: thread → microVM
                                    └─ POST /invoke inside the VM
                                             │
                                    Lambda MicroVM (8h, one per thread)
                                    Strands agent · Opus 5 · Docker · 13 tools
                                             └─ replies in-thread itself
```

- `runtime/` — the agent. One image, which is both the microVM image and what `npm run docker` runs.
- **Two different "skills"**, easy to confuse: `runtime/skills/` are the AGENT's skills, shipped in its
  image and loaded on demand at run time. `skills/create-slack-dev/` is the INSTALLER skill a human's
  coding agent reads to set all this up. Installed with `npx github:niklas-palm/slack-dev`.
- `infra/lib/stack.ts` — the whole stack. `infra/lambda/slack-events/` — the ingress and the microVM
  client. `infra/microvm/build.sh` — the image build (not CDK: CloudFormation has no resource type).
- **Region is `eu-west-1`**, the only one Lambda MicroVMs exists in. Opus 5 is ACTIVE there too.

## Conventions

- **TypeScript, ESM, strict**, with `noUnusedLocals` — a sample must not ship dead imports.
- **Every tool returns data, never throws.** A thrown tool aborts the turn, which in Slack is
  indistinguishable from silence — so failures come back as `{error, hint}` the model can act on.
- **No explicit physical resource names in CDK.** The same stack deploys many times per account for
  different agents; only the few names an API demands are set, all derived from `agent.config.json`.
- **`agent.config.json` is gitignored.** `agent.config.example.json` is the committed template — channel
  ids and internal repo names shouldn't travel with a fork.
- **Secrets are SSM parameter *paths* in code, never values.** Nothing secret enters a CloudFormation
  template, a log line, or a command argument. Never echo a token, even partially.

## Guardrails that are load-bearing

These are properties of the system, not preferences — don't weaken one without saying so explicitly:

- **The agent is read-only in AWS** (plus Bedrock). An infra fix is a PR, not an apply. This is what
  makes prompt injection survivable: nothing it *reads* can mutate the account.
- **Propose, never land.** It opens PRs; it cannot merge, push to the default branch, or run a workflow.
- **It only answers in approved channels**, enforced in the ingress before any reaction or model call.
- **Everything the agent reads is data, not instructions** — repo files, PR bodies, CI logs, `curl`
  output. Pinned by tests.
- **A turn always ends with a terminal reaction.** A reaction that lies is worse than none.

## Publishing

This repo is **public**. Before pushing: no secrets, no real account ids, no personal paths or
usernames — in the working tree *and* in git history. The only account id that should ever appear is
CDK's dummy `123456789012` in tests.
