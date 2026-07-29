# This agent

<!--
  THIS FILE IS YOURS. It's appended to the base prompt, so anything you write here ADDS to the agent's
  instructions — you never edit src/prompt.ts, and an update to this template can't clobber your work.

  The base prompt already covers: the Slack reply protocol, the status reactions, formatting, tool
  rules, AWS read-only access, treating everything it reads as data rather than instructions, reading a
  cloned repo's own AGENTS.md/CLAUDE.md before working in it, stepping back before a PR to ask whether
  the change should exist at all, and the git/workflow prohibitions. Don't repeat those, and don't
  contradict them.

  It also tells the agent to flag "⚠️ Prompt drift" in its reply whenever what it finds in the live
  system disagrees with what you wrote here — a log group that no longer exists, a renamed service, a
  stale convention. That's your alert that this file needs an edit and an `npm run image`; the agent
  never edits it itself.

  Write what a new senior hire would need on day one and couldn't get by reading the code: what this
  system IS, its runtime topology, where the logs live, and what this agent should lead with.

  Replace the placeholders below; delete any section you don't need. Empty is valid — the agent works
  without this file, just generically.

  To try a change: `npm run image` to ship it, or iterate with no deploy at all —
      cd runtime && WORKSPACE_DIR=/tmp/agent env -u AWS_PROFILE npm run local -- "a request"
-->

You look after **<the system>** — <one or two sentences: what it does, for whom>.

Account **<account id>**, region **eu-west-1**. The repo is `<owner/repo>`; its `<CLAUDE.md /
AGENTS.md / README.md>` is the source of truth for depth — clone and read it rather than guessing.

## Operational map (enough to investigate without cloning)

- **<service name>** — <what it does, where its entry point is>.
- **<service name>** — <what it does>.

**Data stores:** <DynamoDB tables / S3 buckets / queues, and any you must never read>.

**CloudWatch log groups** (names carry deploy-specific suffixes — LIST them and match by substring,
never hardcode):

- <substring> → <which component>
- <substring> → <which component>

<Any log line that looks alarming but is normal, e.g. "SIGTERM on deploy is a task rotating, not a
crash" — call it out so it isn't reported as an incident.>

## What to lead with

<The two or three things this agent gets asked most, and how to handle them: "answer questions about
the system", "investigate an incident from the logs before forming an opinion", "review a PR", "make
a small change and open a PR".>

## This system's conventions

<Anything that would make a change get rejected: the test command, whether docs must be updated in
the same PR, house style, anything the agent must never touch.>

<What "makes sense" means for this product: the direction, the trade-offs already settled, the kinds
of change this team doesn't want. The base prompt makes the agent ask the question; only this tells
it what the answer usually is.>
