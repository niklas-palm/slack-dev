---
name: create-slack-dev
description: |
  Set up, fix, or extend a Slack-triggered engineering agent (Claude Opus 5 in an AWS Lambda MicroVM)
  from the public slack-dev template — an agent people @-mention in Slack that investigates the AWS
  account it runs in, reads PR comments and CI logs, and opens PRs.

  Use when the user wants to CREATE one: "create/set up/deploy a slack agent", "make a slack bot for
  this repo", "give this project an agent I can @-mention", "install slack-dev". Clones the template
  beside the current project, configures it, writes its system prompt, registers the GitHub App,
  deploys the CDK stack, and walks the user through the few steps that have no API (two GitHub clicks,
  the Slack install).

  ALSO use when one already EXISTS and the user wants to change or debug it: "my slack agent isn't
  responding / is stuck on the yellow circle / won't answer in this channel", "change what my slack
  agent knows", "add a skill to my slack agent", "my agent's deploy failed". references/troubleshooting.md
  maps symptom to cause; the clone's docs/iterating.md covers PROMPT.md and runtime/skills/.
---

# Create a Slack agent

Stand up an agent people @-mention in Slack. It investigates the AWS account it's deployed in, clones
and reasons about a repo, reads PR comments and CI logs, and opens PRs — replying in the thread.

```
TEMPLATE: https://github.com/niklas-palm/slack-dev
REGION:   eu-west-1         (default; us-east-1 is the only other option — see below)
MODEL:    eu.anthropic.claude-opus-5
```

**Template source.** Clone the public repo above. If it's unreachable, fall back to a local checkout and
say which source you used. Each agent is a **separate clone** with its own `agent.config.json` — never
deploy from the template checkout itself.

## Region: only two are possible

**Lambda MicroVMs exists in exactly two regions today: `eu-west-1` (the EU one) and `us-east-1` (the US
one).** Nowhere else — every other region fails with `AccessDeniedException` on
`ListManagedMicrovmImages`, and it fails *minutes into the image build*, after the S3 bucket and IAM
build role already exist. So never "helpfully" deploy into the user's usual region.

The template ships pinned to `eu-west-1`, and the stack throws if you try to deploy it elsewhere — that
guard is deliberate, not a bug to route around. **If the user's workload and team are in the US, ask
whether they want `us-east-1`, and switch the pins properly before step 6:**

| Change | To |
|---|---|
| `infra/lib/config.ts` → `REGION` | `us-east-1` |
| `runtime/src/config.ts` → `REGION` | `us-east-1` |
| `runtime/src/config.ts` → `MODEL_ID` | `us.anthropic.claude-opus-5` |
| `infra/microvm/build.sh` → `REGION` | `us-east-1` |
| `scripts/put-secrets.sh`, `scripts/setup-github-oidc.sh` → `REGION` | `us-east-1` |
| `infra/test/stack.test.ts` — the guard test pins the region by name | `us-east-1` (and its counter-example to a non-MicroVM region) |
| every `--region eu-west-1` in commands you run, and in `setup.md` | `us-east-1` |

**The model id prefix is regional, and this is the easy one to miss:** `eu.anthropic.claude-opus-5` does
not resolve in `us-east-1` — it's `us.anthropic.claude-opus-5` there (verified: both inference profiles
exist, each only in its own region). A region switch that forgets `MODEL_ID` deploys fine and then every
turn fails at the first model call.

Then confirm the model is enabled in the new region (the step-2 Bedrock command with the region swapped)
and re-run `npm run check`. **Don't half-migrate** — a stack in one region with an image built in the
other fails late and confusingly. If you're not switching, say nothing and stay in `eu-west-1`.

## Already have one? Start here instead

The nine steps below are for standing up a NEW agent. If the user already has one deployed, don't run
them — the setup scripts are guarded, but re-running them is how duplicate GitHub/Slack apps get created.
Work in their EXISTING clone (a sibling directory, or ask where it is) and go straight to:

| They say | Do |
|---|---|
| "not responding", "stuck on 🟡", "no 👀", "won't answer in this channel" | Their clone's **`setup.md` troubleshooting table** covers live-agent symptoms; `references/troubleshooting.md` covers SETUP failures and the lessons from the first live run. Then the two log groups (`/aws/lambda-microvms/slack-dev-<name>` and the ingress Lambda's) — the commands are at the end of `references/troubleshooting.md`. |
| "change what it knows / how it behaves" | Edit `runtime/PROMPT.md`, then `npm run image` — **not** `npm run deploy`. Their clone's `docs/iterating.md` has what belongs in a prompt vs. a skill. |
| "teach it a procedure", "add a skill" | Add `runtime/skills/<name>/SKILL.md`, then `npm run image`. The folder is picked up with no code change; the `description` is the trigger. |
| "add another channel" | Add the id to `allowedChannels` in `agent.config.json`, then `npm run deploy` (the allowlist lives in the ingress Lambda's env). |
| "deploy failed" | Read the failing step's output rather than re-running blindly. `references/troubleshooting.md` covers the common ones. |
| "rotate a credential" | `npm run secrets`. Note its warning: a running thread keeps the OLD value for up to 8h, and the ingress caches per warm container. |

**A prompt or skill change needs `npm run image`, not a deploy** — the image *is* the agent; the stack
only routes to it. And existing Slack threads keep their old VM for up to 8h, so test in a **NEW** thread
or you'll conclude the change didn't work.

## Run the whole thing, then hand off cleanly

Nine steps. Do steps 1–8 yourself; the user acts only where an API doesn't exist.

1. Gather the four inputs you must not guess
2. Check prerequisites
3. Clone and configure
4. Write `runtime/PROMPT.md` — the step that decides if the agent is any good
5. Register the GitHub App *(user: 2 clicks)*
6. Deploy the CDK stack
7. Create the Slack app — **ask first** whether you or they should run it (it involves a token)
8. Verify without Slack
9. Hand off

**Tone throughout: friendly, specific, and never vague about who does what.** Before any step that needs
the user, say what will happen, what they'll see, and exactly what to click. Never leave them guessing
whether it's their turn. **Read `references/handoff.md` before step 5** — it has the wording rule for
every user-facing step, the assisted-vs-manual choice for Slack, and the closing message.

**Never put a secret in the conversation or in a command argument.** Both Slack tokens can be read from
the environment, so the user can keep them in their own shell. Step 7 makes this an explicit choice.

## Step 1 — Gather the four inputs you must not guess

**Ask for anything unclear. Never invent these.** Propose a value where you can infer one, but confirm.

1. **`githubRepo`** — the `owner/repo` the agent works on. It gets push access, so a wrong value is both
   broken and a permissions mistake. If in a git repo: `git remote get-url origin`, then **confirm**.
2. **`name`** — the agent's slug (lowercase, digits, hyphens). Derives the stack name, SSM prefix, and
   microVM image name, so several agents can share an account. Also the @handle people type.

   **Check the name is available on GitHub before you settle on it.** The GitHub App is named after
   `displayName`, and App names are unique across *all* of GitHub — so an obvious name like `dev-agent`
   or `platform-bot` is usually taken. Discovering that at step 5 costs a re-run and two more clicks
   each time, so check the candidates *here*, while you're still choosing:

   ```bash
   for n in <candidate> <candidate-2> <candidate-3>; do
     slug="$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]\+/-/g; s/^-*//; s/-*$//')"
     printf '%-28s %s\n' "$n" \
       "$(curl -so /dev/null -w '%{http_code}' "https://github.com/apps/${slug}" \
          | sed 's/^404$/AVAILABLE/; s/^2[0-9][0-9]$/TAKEN/')"
   done
   ```

   `404` means no App owns that slug → available. Anything `2xx` means taken. Offer the user the
   available candidates and let them choose — the name is the bot's identity on every PR, so **never
   pick or silently mangle it for them.** Distinctive names (product or team prefix, e.g.
   `acme-checkout-agent`) are far likelier to be free than generic ones.
3. **`allowedChannels`** — the Slack channel **ids** (`C0123ABCD`) it may answer in. **Always ask.**
   Empty means it answers in *any* channel it's invited to — in a large workspace, anyone who can
   `/invite` it could direct an agent holding repo push credentials. Tell them how to find an id: in
   Slack, right-click the channel → **View channel details** → id at the bottom. Ids, not `#names` (the
   event payload carries only the id). If they want to start unrestricted in a small workspace, that's
   fine — say plainly that it *is* unrestricted, and that adding a channel later is a config edit plus
   `npm run deploy`.
4. **The AWS account** — confirm the shell credentials point at the account the agent should
   investigate:
   ```bash
   env -u AWS_PROFILE aws sts get-caller-identity
   ```
   > **The agent belongs in the account it looks after.** Its role carries `ReadOnlyAccess` + Bedrock;
   > deployed elsewhere it can discuss the system but not investigate it. If the creds point somewhere
   > else, **stop and ask** rather than deploying to the wrong account.

## Step 2 — Check prerequisites

Check all of these before cloning; each failure is opaque later. Report anything missing and stop.

```bash
docker version --format '{{.Server.Version}}'     # only needed for `npm run docker` (the local loop)
node -v                                           # 22+
aws lambda-microvms help >/dev/null && echo "aws cli new enough"
# ^ the microVM commands are recent. An older-but-valid v2 fails with `Invalid choice: 'lambda-microvms'`
#   minutes into step 6, AFTER the S3 bucket and IAM build role have been created.
env -u AWS_PROFILE aws bedrock list-inference-profiles --region eu-west-1 \
  --query "inferenceProfileSummaries[?inferenceProfileId=='eu.anthropic.claude-opus-5'].status" --output text
# → ACTIVE. Anything else: the user must enable Opus 5 in the Bedrock console for eu-west-1.
# Deploying in us-east-1 instead? Swap BOTH the region and the prefix: 'us.anthropic.claude-opus-5'.
env -u AWS_PROFILE aws cloudformation describe-stacks --stack-name CDKToolkit \
  --region eu-west-1 --query 'Stacks[0].StackStatus' --output text
# Not found → bootstrap once, BEFORE deploying:
#   ACCOUNT_ID="$(env -u AWS_PROFILE aws sts get-caller-identity --query Account --output text)"
#   (cd infra && env -u AWS_PROFILE npx cdk bootstrap "aws://${ACCOUNT_ID}/eu-west-1")
```

## Step 3 — Clone and configure

Clone **beside** the project being worked on — a sibling directory, never inside it. It's the DEFAULT and
it's what you should do unless the user asks otherwise; the location is ultimately their call, so if they
want it elsewhere, put it there.

Why a sibling: the agent is its own deployable thing with its own git history, dependencies and AWS
resources. Nested inside the target repo it would show up in their diffs, their lockfile, their CI and
their PRs — and the agent clones that repo at run time anyway, so it gains nothing from being in it.

```bash
git clone <TEMPLATE> ../<name>-agent && cd ../<name>-agent && npm install
cp agent.config.example.json agent.config.json

# Strip what belongs to the TEMPLATE, not to this agent:
#   .github/               — CI that deploys the template repo into the template author's account
#   agent.config.ci.json   — a COMPLETE, VALID config for the template's own agent (its repo, its Slack
#                            channel). No placeholder guard fires on it, so left in place it's the most
#                            tempting file to copy — and doing so points your agent at someone else's
#                            channel.
#   origin                 — otherwise the clone tracks (and could push to) the template repo.
rm -rf .github agent.config.ci.json
git remote remove origin
```

Then write `agent.config.json` (it's gitignored, which is why the example exists):

```json
{
  "name": "<name>",
  "displayName": "<name>",
  "description": "<one line: what this agent looks after>",
  "githubRepo": "<owner/repo>",
  "allowedChannels": ["<C0123ABCD>"]
}
```

Validate before going further:

```bash
npm run check && env -u AWS_PROFILE npm run synth >/dev/null && echo "config OK"
```

It's `synth` that reads the config and rejects a bad name or a `#channel-name` — `check` is deliberately
config-free (its tests build their own fixtures) so a fresh clone can run it with no config and no AWS
credentials. Both together is the real gate.

## Step 4 — Write `runtime/PROMPT.md`

**This is where you add value over the user doing it themselves.** The base prompt already covers the
Slack protocol, formatting, tool rules, AWS read-only access, prompt-injection resistance, and the
git/workflow prohibitions — **don't repeat or contradict those.** `PROMPT.md` is only: what this system
is, its runtime topology, where its logs live, and what the agent should lead with.

Research it properly: read `references/prompt-research.md` for the checklist, the commands that inventory
real infrastructure, and the two mistakes that make an agent useless in practice.

Get the facts right rather than guessing at them: when the agent later finds that a log group, resource
or convention you wrote here doesn't match the live system, it flags `⚠️ Prompt drift` in its Slack reply
so the user knows to fix this file and re-run `npm run image`.

## Step 5 — Register the GitHub App *(user clicks twice)*

```bash
env -u AWS_PROFILE npm run github-app        # add `-- --org MY-ORG` for an organization
```

Tell the user what to expect *before* running it — it opens their browser and then waits:

1. A tab opens and forwards to GitHub with the name and permissions prefilled → **Create GitHub App**.
2. The install page opens → **Only select repositories** → pick the repo → **Install**.
3. The script stores the App ID, private key, and Installation ID in SSM itself.

**If `npm run image` later says "Set a real name in agent.config.json" about a config that looks fine**,
check `node -v` — the build reads the config with node, so a broken node install surfaces as a config
error. (It used to read it with python3, which macOS no longer bundles, producing exactly that confusion.)

**If it exits with "name is already taken":** you skipped the availability check in step 1 — run it now
for a couple of candidates, ask what they'd like instead (it's display-only and appears on PRs as
`name[bot]`), then re-run with `-- --app-name <their choice>`. **Don't pick one for them**; it's the bot's
identity on every PR.

The App is scoped to **propose, never land**. If asked, `references/permissions.md` explains each grant.

## Step 6 — Build the image, then deploy

```bash
env -u AWS_PROFILE npm run image     # the agent itself: a Lambda MicroVM image
env -u AWS_PROFILE npm run deploy    # the routing around it
```

**`npm run image`** packages `runtime/` (agent + prompt + skills), registers it as a microVM image, and
publishes the ARN to SSM. Several minutes on the first run — say so rather than going quiet. **This is
what a `PROMPT.md` change needs later, not a deploy.**

**`npm run deploy`** creates the thread→VM routing table, the microVM execution role, and the API Gateway
+ Lambda. Nothing to copy from the output — step 7 reads `SlackEventsUrl` from the stack.

If the image build fails, it prints the command that names the failing Dockerfile step. Read that rather
than re-running blindly.

## Step 7 — Create the Slack app *(ask first: assisted or manual)*

**This is the only step involving a secret the user must fetch, so ASK before you start.** Offer both
options and let them choose — the exact wording is in `references/handoff.md`:

- **Assisted** — they paste a Slack config *refresh* token so you can run it. Faster, but **that token
  lands in the conversation**; say so plainly and note it's revocable.
- **Manual** — they run two commands in their own terminal with the tokens in their own shell. You supply
  the exact commands and stay out of it.

Never assume assisted. Never echo a token, even partially.

**Assisted path:**

```bash
env -u AWS_PROFILE npm run slack-app
```

Reads the Request URL from the deployed stack, creates the app with the scopes **and `app_mention`
already subscribed to that URL**, stores the signing secret from the API response, and opens the install
page. The user then clicks **Install to Workspace → Allow** and pastes the **Bot User OAuth Token**
(`xoxb-…`). That's the only value copied by hand — a bot token doesn't exist until a workspace installs
the app, and no API can consent for it.

Both tokens can come from the environment (`SLACK_CONFIG_REFRESH_TOKEN`, `SLACK_BOT_TOKEN`) instead of a
prompt or a CLI flag — prefer that, since a flag lands in shell history and in this transcript. **If you
run the script non-interactively it cannot answer the bot-token prompt**; it detects that, exits with
instructions, and the app already exists — so don't re-run it, or you'll create a second one.

**If it exits with "No Slack app-configuration token stored yet"**, that's the one-time setup shared by
every agent the user will ever create. `references/handoff.md` has the exact instructions to give them.

Slack must come **after** the deploy: the Request URL has to exist before it can be set.

## Step 8 — Verify without Slack

Prove the deployment works before involving Slack, so a failure has one cause instead of two:

```bash
env -u AWS_PROFILE npm run invoke -- --prompt "What AWS services are running in this account?"
```

Tail the runtime log group it prints, confirm the agent ran and used tools, and **report what you saw**
— not just "it worked".

## Step 9 — Hand off, and teach them the two seams

**Don't end at "it works".** The agent is only useful once it knows about THEIR system, so the handoff
must leave them able to iterate without you. Cover both seams explicitly, in this order:

1. **`runtime/PROMPT.md`** — appended to the base prompt, so they never touch the built-in rules. This is
   where facts about their system go.
2. **`runtime/skills/<name>/SKILL.md`** — a folder is all it takes; no registration, no code change.
   Verified: dropping in a new skill produced a `skills` tool call and an answer from its contents. This
   is where PROCEDURES go — the steps they'd give a competent new colleague.
3. **`npm run image` ships both** (never `npm run deploy`), and **a new Slack thread** is needed to see a
   change, since an existing thread keeps its VM for up to 8h.
4. **`npm run local`** is the fast loop — same model, same skills, no container and no Slack.

Point them at `docs/iterating.md` in their clone for the depth: what belongs in a prompt versus a skill,
why a skill's `description` is the trigger and the only part always in context, and how to confirm the
agent actually loaded theirs (`grep '"name":"skills"'`).



Confirm what's in place — **with `--region eu-west-1`**, or it silently reports zero on a perfectly good
install (everything here lives in that one region, but the AWS CLI defaults to the shell's):

```bash
env -u AWS_PROFILE aws ssm get-parameters-by-path --path /slack-dev/<name> --region eu-west-1 \
  --query 'Parameters[].Name' --output text | tr '\t' '\n'
```

Expect the five secrets plus `microvm-image-arn` and `microvm-role-arn`. Then give the user the closing message from
`references/handoff.md`: how to invite the bot, what the reactions mean, three things to try, and how to
iterate on the prompt with no deploy.

## Reference files

- `references/handoff.md` — how to write every user-facing step and the closing message. Read before
  step 5.
- `references/prompt-research.md` — the `PROMPT.md` checklist and infrastructure-inventory commands.
  Read at step 4.
- `references/permissions.md` — what the agent can and cannot do in GitHub and AWS, and why. Read when
  the user asks about security, or before proposing any permission change.
- `references/troubleshooting.md` — symptom → cause for every failure mode. Read when a step fails or
  the agent misbehaves after handoff.

## Notes

- **Deploying is the user's call.** The clone deploys from a laptop with `npm run image` +
  `npm run deploy`. If they later want CI, `setup.md` has a keyless GitHub-OIDC setup they can adopt
  in their own repo — but don't set it up unasked, and never leave the template's `.github/` in a clone.
- **Multiple agents per account are fine.** No fixed physical resource names; the three that must be
  named (stack, microVM image, REST API) all derive from `name`.
- **Secrets** live in SSM SecureStrings at `/slack-dev/<name>/`; only parameter *paths* reach
  CloudFormation. Never print a secret value, and never commit a `.pem`.
- **Re-running `npm run github-app`** is blocked while `gh-app-id` exists, so you can't orphan an App.
- **If either setup script fails part-way**, it prints the exact `aws ssm put-parameter` command to
  finish by hand — follow that rather than re-running, which would create a second App.
  `npm run secrets` is the general repair-and-rotate path.
- The clone's `setup.md` is the full runbook; point the user there for anything this skill skips.
