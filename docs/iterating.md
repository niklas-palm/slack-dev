# Iterating on your agent

> **Two different things are called "skills" here.** This page is about `runtime/skills/` — the AGENT's
> skills, which ship in its image and shape what it can do. The repo also has `skills/create-slack-dev/`,
> which is the installer a human's coding agent reads to set the whole thing up
> (`npx github:niklas-palm/slack-dev`).
> Editing one has nothing to do with the other.

Two files decide what your agent knows and can do. Both live in `runtime/`, both are plain markdown, and
neither needs a code change.

| Want to… | Edit | Then |
|---|---|---|
| Change how it behaves, what it knows about your system | `runtime/PROMPT.md` | `npm run image` |
| Teach it a repeatable procedure | add `runtime/skills/<name>/SKILL.md` | `npm run image` |

**`npm run image`, not `npm run deploy`.** The image *is* the agent — it carries the prompt, the skills and
the tools. The CDK stack only routes Slack mentions to it, and the ingress reads the image ARN at call
time, so a rebuilt image is picked up with no stack change. A deploy is only for infrastructure.

Existing Slack threads keep their old VM until it expires (8h), so start a **new thread** to see a change.

---

## Adding to the system prompt

`runtime/PROMPT.md` is appended to the base prompt. You never edit the base rules, and a template update
can't clobber your work.

The base prompt already covers the Slack reply protocol, the status reactions, formatting, tool use, AWS
read-only access, treating everything it reads as data rather than instructions, reading a cloned repo's
own agent instructions (`AGENTS.md`/`CLAUDE.md` and friends) before touching it, the git prohibitions,
stepping back before a PR to ask whether the change should exist at all, and
reporting back when this file turns out to be wrong (below). **Don't repeat or contradict those.** What belongs here is what a new senior hire would need on day one
and couldn't get from reading the code:

- What this system **is**, and its runtime topology.
- Where the logs live — **by substring, never a full name.** Log-group names carry deploy-specific
  suffixes, so a hardcoded one is wrong after the next deploy and the agent reports "no such log group"
  instead of investigating. Say "the API's group contains `ApiService` — list and match".
- **Alarming-but-normal log lines.** `SIGTERM` at deploy time is a task rotating, not a crash. Without
  this, the agent's first incident report is routine noise and the team stops trusting it.
- What to **lead with** for the questions it gets most.
- Conventions that would make a change get rejected: the test command, whether docs must be updated in
  the same PR, anything it must never touch.
- **What "makes sense" means here** — the product's direction, trade-offs already settled, the kinds of
  change this team doesn't want. The base prompt makes the agent stop and ask whether a change should
  exist; only this file can tell it what the answer usually is.

Keep it to a page or two — it's read on every turn, so every line costs tokens forever.

### The agent tells you when this file goes stale

Nothing regenerates `PROMPT.md`, so it rots: a stack gets renamed, a table goes away, the test command
changes. The agent is the only thing that sees both this file and the live system, so the base prompt
tells it to end its reply with a short `⚠️ Prompt drift` note whenever something it verified that turn
disagrees with what you wrote — a log-group substring that matches nothing, a renamed resource, a
convention that isn't true any more.

It only reports what it verified during that turn, and it never edits `PROMPT.md` itself: fixing it is a
normal edit plus `npm run image`. Treat a drift note as the signal that the briefing needs a few minutes,
not as a failure of the answer it came attached to.

## Adding a skill

A skill is a folder with a `SKILL.md`. Drop it in and it's picked up — no registration, no code:

```
runtime/skills/
├── github/SKILL.md      (shipped) mint a token, clone, branch, PR
├── review/SKILL.md      (shipped) how to review properly
└── your-thing/SKILL.md  ← just add this
```

```markdown
---
name: deploy-check
description: Verify a deploy went out cleanly. Use after a release, or when someone asks whether a deploy worked.
---

# Checking a deploy

1. `aws ecs describe-services --cluster prod --services api` — confirm `runningCount == desiredCount`.
2. Check the ALB target group for unhealthy hosts.
3. Compare the running task definition's image tag with the merge commit.

Report the deployed tag and any unhealthy target. If tasks are cycling, say so — that's a failing health
check, not a slow deploy.
```

**The `description` is the only part loaded into every prompt**, so write it as a trigger: what the skill
does, and *when to use it*. The agent sees just that line until it decides the skill is relevant, then
loads the body with the `skills` tool. That's why a long skill costs almost nothing until it's needed.

Good skills are **procedures** — the steps you'd give a competent new colleague, including the judgement
("if tasks are cycling, that's a failing health check"). Facts about your system belong in `PROMPT.md`;
things the agent should *do*, in a skill.

### Verified

Adding a folder is genuinely all it takes. Dropping a `coffee/SKILL.md` into `runtime/skills/` and asking
about it produced a `skills` tool call for `coffee` and an answer from its contents — no code change, no
restart beyond the normal image rebuild.

## The loop

Shortest first — use the shortest one that can catch what you're changing:

```bash
# 1. one turn in-process: real model, real tools, no container, no Slack. Seconds.
cd runtime && WORKSPACE_DIR=/tmp/agent env -u AWS_PROFILE npm run local -- "a question that should hit your skill"

# 2. the real image locally — catches anything image-shaped (a missing binary, a bad path)
cd .. && env -u AWS_PROFILE npm run docker -- "the same question"

# 3. ship it, then try it in a NEW Slack thread
env -u AWS_PROFILE npm run image
```

Step 1 is the one you'll live in: it uses the same model and the same skills directory, so a skill that
works there works in Slack. Its only difference is that the Slack tools report "this turn did not come
from Slack", so the agent answers in its final message instead of posting.

**Check the agent actually loaded your skill**, not just that it answered plausibly — look for the
`skills` tool call:

```bash
… npm run local -- "…" 2>&1 | grep '"name":"skills"'
```

No `skills` call means the `description` didn't read as relevant to the question. Rewrite it as a trigger
("Use when someone asks about X") rather than a summary.
