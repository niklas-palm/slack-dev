# Writing `runtime/PROMPT.md`

This file is the difference between an agent that's useful on day one and one that asks the user
questions they already answered. The base prompt (`runtime/src/prompt.ts`) already covers the Slack
protocol, status reactions, formatting, tool rules, AWS read-only access, treating everything it reads as
data rather than instructions, and the git/workflow prohibitions. **Don't repeat or contradict those.**

`PROMPT.md` answers only: what this system **is**, its runtime topology, where its logs live, and what
the agent should lead with. Write what a new senior hire would need on day one and couldn't get from
reading the code.

Every fact here is checkable, so write only what you verified. The base prompt tells the agent to end its
reply with a `⚠️ Prompt drift` note when what it finds disagrees with this file — so a guessed log group
or a stale convention comes back as a drift report in the user's Slack thread, not silently.

## Research checklist

- [ ] Read the repo's `CLAUDE.md` / `AGENTS.md` / `README.md` and anything in `docs/`.
- [ ] Identify the **runtime topology**: what runs where (ECS service, Lambda, container), and how a
      request flows through it.
- [ ] Inventory the real infrastructure (commands below) so the agent debugs instead of guessing.
- [ ] Note the repo's **test/check command** and whether docs must be updated in the same PR.
- [ ] Note the **default branch** name.
- [ ] Note any **alarming-but-normal** log line, so routine noise isn't reported as an incident.
- [ ] Say what the agent should **lead with** — the first thing to check for the most common question.

## Inventory the account

```bash
env -u AWS_PROFILE aws logs describe-log-groups --region eu-west-1 \
  --query 'logGroups[].logGroupName' --output text | tr '\t' '\n'
env -u AWS_PROFILE aws ecs list-clusters --region eu-west-1
env -u AWS_PROFILE aws ecs list-services --cluster <cluster> --region eu-west-1
env -u AWS_PROFILE aws dynamodb list-tables --region eu-west-1
env -u AWS_PROFILE aws lambda list-functions --region eu-west-1 --query 'Functions[].FunctionName'
env -u AWS_PROFILE aws sqs list-queues --region eu-west-1
```

## The two mistakes that make an agent useless

**1. Recording a full log-group or resource name.** They carry deploy-specific suffixes
(`/ecs/MyStack-ApiServiceLogGroup4B2C1D-xYz`), so a hardcoded name is wrong after the next deploy and the
agent reports "no such log group" instead of investigating. **Record a substring and tell the agent to
list and match:**

> Logs are in CloudWatch. Match by substring, never a full name — they carry generated suffixes. The API
> service's group contains `ApiService`, the worker's contains `Worker`. List groups and filter.

**2. Not naming the normal-looking alarms.** Without this the agent's first incident report is routine
noise, and the team stops trusting it:

> A `SIGTERM` in the worker log at deploy time is a task rotating, not a crash. `VersionConflictError` in
> the API is expected under concurrent writes — it retries. Neither is an incident.

## Shape

Follow the headings in the shipped `runtime/PROMPT.md` template and replace every placeholder. Keep it
tight — a page or two. It's read on every single turn, so every line costs tokens forever.

## Verify it before deploying

```bash
cd runtime && WORKSPACE_DIR=/tmp/agent env -u AWS_PROFILE npm run local -- \
  "What is this system, and where would you look first if the API was returning 500s?"
```

Real model, real tools, no Slack and no deploy. If the answer is vague or it guesses at resource names,
the prompt isn't done — fix it and re-run. This loop takes seconds; a deploy takes minutes.
