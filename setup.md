# Setup — from zero to a working agent

Eight steps, about 10 minutes. Most of it is scripted; you click three times (create the GitHub App,
install it, install the Slack app) and copy one value — plus one extra click the very first time, to
generate the shared Slack config token. The order matters in one place: **Slack comes after the
deploy**, because the app's Request URL has to exist before it can be set.

> **Deploy into the account the agent looks after.** Its role carries `ReadOnlyAccess`, which is what
> lets it read that workload's CloudWatch logs, metrics, and tables. An agent deployed elsewhere can
> talk about the system but can't investigate it.

## What you'll be connecting

Three identities, and it's worth knowing which is which before you start clicking:

- **A Slack app** — the bot people @-mention. Gives you two values: a **signing secret** (the Lambda
  verifies every incoming request with it) and a **bot token** (the agent posts with it).
- **A GitHub App** — the agent's own identity on commits and PRs, so its work shows as `name[bot]`
  rather than as a human. Gives you three values: an **App ID**, an **Installation ID**, and a
  **private key**. Optional: skip it for a Slack-and-AWS-only agent.
- **The AWS account** — no identity to create. The agent uses its own execution role, which is why the
  stack belongs in the account you want it to be able to investigate.

All five values end up as SSM SecureStrings under `/slack-dev/<name>/`. Nothing is ever committed or
put in a CloudFormation template.

| Value | How you get it |
|---|---|
| GitHub App ID | **automatic** — `npm run github-app` (step 3) |
| GitHub private key | **automatic** — same |
| GitHub Installation ID | **automatic** — same |
| Slack signing secret | **automatic** — `npm run slack-app` (step 5) |
| Slack bot token (`xoxb-…`) | you paste it once, after clicking Install |

Only the bot token is hand-copied, and only because it doesn't exist until a workspace installs the
app — no API can consent on the workspace's behalf.

---

## 1. Prerequisites

- Node.js 22+ and npm
- Docker (only for `npm run docker`, the local loop — the microVM image is built by AWS, not locally)
- AWS CLI v2, plus **temporary credentials in your shell** (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) for the target account. Setup CREATES things — an S3
  bucket, IAM roles, SSM SecureStrings, a CloudFormation stack — so read-only credentials won't do.

Install the dependencies first — every `npm run` below needs them:

```bash
npm install
```

Claude Opus 5 must be enabled in Bedrock in `eu-west-1`, the region this template is pinned to. (Lambda
MicroVMs is not available in every region; running elsewhere means changing the pinned
constants — see [docs/lambda-microvms.md](./docs/lambda-microvms.md).) Check:

```bash
env -u AWS_PROFILE aws bedrock list-inference-profiles --region eu-west-1 \
  --query "inferenceProfileSummaries[?inferenceProfileId=='eu.anthropic.claude-opus-5'].status" --output text
# → ACTIVE
```

Bootstrap CDK in the account once, if it isn't already:

```bash
cd infra
ACCOUNT_ID="$(env -u AWS_PROFILE aws sts get-caller-identity --query Account --output text)"
env -u AWS_PROFILE npx cdk bootstrap "aws://${ACCOUNT_ID}/eu-west-1"
```

## 2. Name your agent, and pick its channels

`agent.config.json` is **gitignored** — it holds your channel ids and internal repo name, which
shouldn't travel with a fork. Copy the template and edit your copy:

```bash
cp agent.config.example.json agent.config.json
```

```json
{
  "name": "platform-ops",
  "displayName": "platform-ops",
  "description": "Slack agent for the platform team: answers questions, debugs incidents, opens PRs.",
  "githubRepo": "my-org/platform",
  "allowedChannels": ["C0123ABCD"]
}
```

- **`name`** — lowercase letters, digits, hyphens. Everything else derives from it: the stack
  (`SlackDev-PlatformOps`), the SSM prefix (`/slack-dev/platform-ops`), the runtime name. This is
  what makes several agents coexist in one account.
- **`displayName`** — what the agent calls itself in Slack and in commits.
- **`githubRepo`** — `owner/repo` the GitHub App is installed on. Leave `""` for a Slack+AWS-only agent.
- **`allowedChannels`** — the channel ids the agent will answer in. **Set this in a large workspace.**
  Without it (an empty list) the agent answers in any channel it's a member of, so anyone who can
  `/invite` it can put an agent holding repo credentials to work. A mention from anywhere else is
  dropped by the ingress Lambda *before* the 👀 — no reaction, no reply, no model call; just a
  `channel not allowed` log line. Nothing to redeploy when someone invites the bot elsewhere: it's
  simply inert there.

  **Ids, not names** (`C0123ABCD`, not `#platform-ops`) — Slack's event payload carries only the id, so
  a name would mean an extra API call inside the 3-second ack budget, and a channel rename would
  silently change who can trigger the agent. Get an id from Slack: right-click the channel → **View
  channel details** → it's at the bottom of the dialog. Adding a channel later is a config edit plus
  `npm run deploy`.

Then write `runtime/PROMPT.md`: what this system is, its runtime topology, where its logs live, what
the agent should lead with. **This file is what makes the agent good** — the base prompt already
handles the Slack protocol and the safety rules, so spend your effort here. The committed file is a
template with prompts for each section.

## 3. Create the GitHub App

Skip this if `githubRepo` is empty. The App gives the agent its own bot identity for commits and PRs,
and mints the short-lived (~1h) tokens it authenticates with. **No webhook is needed** — Slack is the
only trigger, and the App is purely how the agent acts *on* GitHub.

**One command, two clicks:**

```bash
env -u AWS_PROFILE npm run github-app        # add -- --org MY-ORG for an organization
```

It registers the App through GitHub's [App Manifest
flow](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), so the
permissions come from code and the credentials are never copied by hand. What happens:

1. Your browser opens on a local page that immediately forwards you to GitHub, with the name and every
   permission prefilled. **Click "Create GitHub App".**
2. GitHub hands the App ID and a freshly generated private key straight back to the script, which writes
   both to SSM.
3. The install page opens. **Choose "Only select repositories", pick your repo, and Install.**
4. The script polls GitHub until the installation appears and stores the **Installation ID** itself.

All three GitHub values (`gh-app-id`, `gh-app-private-key`, `gh-app-install-id`) are now in
`/slack-dev/<name>/`. There's no `.pem` to keep track of and no ID to read out of a URL.

Those two clicks are consent gates GitHub gives no API for: naming the App, and choosing what it can
access. Everything else is automated.

<details>
<summary>Notes, and doing it by hand instead</summary>

- **The App name is globally unique across GitHub**, so the script checks it first and *stops* if it's
  taken rather than picking a variant for you — it's the identity on every PR the agent opens, so it
  should be your choice. Re-run with the name you want: `npm run github-app -- --app-name <name>`. It's
  display-only and needn't match `agent.config.json`; it shows on PRs as `name[bot]`. To test a name
  without running anything: `curl -sLo /dev/null -w '%{http_code}\n' https://github.com/apps/<slug>` —
  only `404` is free; anything else is taken (some existing Apps answer 301, hence `-L`).
- **Re-running is blocked** while `gh-app-id` exists, so you can't silently orphan an App. Delete that
  parameter first if you really want a new one.
- **The permissions it requests**, and why each: `contents: write` (clone, push branches),
  `pull_requests: write` (open/update, and read review comments — "address the feedback on my PR" is
  the common ask), `issues: write` (comment — GitHub treats a PR as an issue), `actions: read` +
  `checks: read` (inspect CI and failed logs), `workflows: write` (edit `.github/workflows` — GitHub
  *refuses* an App push that touches a workflow file without it, so "fix the CI workflow" would fail at
  the push).

  The boundary is **propose, never land**: nothing here can merge a PR, push to a protected branch,
  administer the repo, or trigger/cancel a workflow run. `workflows: write` is the one grant that
  widens blast radius — a merged workflow edit runs with the repo's secrets — which is exactly why the
  agent can only open a PR for it and a human reviews the diff.
- **By hand:** create it at [github.com/settings/apps](https://github.com/settings/apps) → New GitHub
  App, set exactly those six permissions (Contents, Pull requests, Issues, Workflows = Read and write;
  Actions, Checks = Read-only), **uncheck Webhook → Active**, create it, note the App ID, generate
  a private key, install it on the one repo, and take the Installation ID from the trailing number of
  the install URL. Then supply all three to `npm run secrets`, which prompts for every value and stores
  whichever ones you fill in.

</details>

## 4. Build the agent's image, then deploy

Two commands, and it's worth knowing which does what — you'll use the first far more often.

```bash
npm run check                       # typecheck + tests, offline
env -u AWS_PROFILE npm run image    # build + register the microVM image (a few minutes the first time)
env -u AWS_PROFILE npm run deploy   # the routing around it: table, roles, webhook
```

**`npm run image`** packages `runtime/` (the agent, its prompt, its skills), registers it as a Lambda
MicroVM image, and publishes the ARN to SSM. It creates the shared artifacts bucket and build role on
first run. **Anything under `runtime/` — above all `PROMPT.md` — needs this, not a deploy.**

**`npm run deploy`** creates the DynamoDB routing table, the microVM execution role, and the API Gateway
+ Lambda that turns a mention into a VM. It prints a **`SlackEventsUrl`** output — the next step reads it
from the stack automatically, so there's nothing to copy.

They're independent on purpose: the ingress reads the image ARN from SSM at call time, so a rebuilt
image is picked up with no stack change.

Slack comes after the deploy on purpose: the app's Request URL has to exist before we can set it.

## 5. Create the Slack app

**One-time, shared by every agent you ever create.** Slack has no API to issue this token, so it comes
from the UI once:

1. Open **[api.slack.com/apps](https://api.slack.com/apps)** and scroll *below* the app list to
   **Your App Configuration Tokens**.
2. **Generate Token** → pick your workspace → copy the **refresh** token — the one
   prefixed `xoxe`, not the access token.
3. Store it — via the environment, so it stays out of your shell history:
   ```bash
   export SLACK_CONFIG_REFRESH_TOKEN='<paste the xoxe- refresh token>'
   env -u AWS_PROFILE npm run slack-app          # stores it, then exits
   ```
   (`--refresh-token <token>` also works, but an inline argument is recorded in history — and in the
   transcript, if you have an AI agent running your setup.)

**Then, per agent:**

```bash
env -u AWS_PROFILE npm run slack-app
```

It reads the deployed Request URL from your stack, creates the app with the seven scopes **and
`app_mention` already subscribed to that URL**, stores the signing secret straight from the API, and
opens the install page. Then:

1. **Install to Workspace → Allow**
2. Copy the **Bot User OAuth Token** (`xoxb-…`) and paste it at the prompt — or set
   `SLACK_BOT_TOKEN` to it beforehand and it won't ask.

> **Having an AI agent run your setup?** Both tokens are read from the environment
> (`SLACK_CONFIG_REFRESH_TOKEN`, `SLACK_BOT_TOKEN`), so you can run just this step yourself and keep the
> secrets in your own shell. Run non-interactively without one and the script says so and exits rather
> than hanging on a prompt nobody can see.
>
> **The app exists at that point**, so what a re-run does depends on one thing:
>
> - **with `SLACK_BOT_TOKEN` exported** → it stores the token and creates nothing. This is the recovery.
> - **without it** → it refuses and tells you why. Creating a second app would overwrite the first's
>   signing secret, leaving a secret and a token from *different* apps — which fails every HMAC check
>   while Slack shows only a red events-URL error that names nothing.

That's the only value you copy by hand, and only because a bot token doesn't exist until a workspace
installs the app — no API can consent for it. Everything else, including the Event Subscriptions step
that used to involve pasting a URL and waiting for a green check, is done.

<details>
<summary>Notes, and doing it by hand instead</summary>

- The config token is **workspace-scoped, not app-scoped**, so one covers every agent. Access tokens
  expire after 12 hours, so the script stores only the *refresh* token and mints a fresh access token on
  each run — writing back the new refresh token that rotation returns. If it ever reports
  `invalid_refresh_token`, generate a new one and re-run with `--refresh-token`.
- **By hand:** [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From an app
  manifest**, paste `slack-app-manifest.yaml` (change the two `name` fields), Create, **Install to
  Workspace**, then copy the Bot User OAuth Token and the Signing Secret (Basic Information → App
  Credentials) into `npm run secrets`. Then **Event Subscriptions** → On → paste the `SlackEventsUrl` →
  wait for the green check → **Subscribe to bot events** → add `app_mention` → Save. The committed yaml
  omits `event_subscriptions` because Slack rejects a manifest declaring `app_mention` without a URL,
  which doesn't exist until you've deployed — that's exactly the step the script skips.
- DMs need more than a scope: the ingress Lambda filters to `app_mention`, so a plain DM (which
  arrives as `message.im`) is dropped. Supporting them means adding the `im:history` scope, the
  `message.im` bot event, and a branch in `infra/lambda/slack-events/handler.ts`.

</details>

## 6. Check the secrets are all in place

```bash
env -u AWS_PROFILE aws ssm get-parameters-by-path --path /slack-dev/<name> \
  --region eu-west-1 --query 'Parameters[].Name' --output text | tr '\t' '\n'
```

Expect the five secrets you provisioned — `gh-app-id`, `gh-app-install-id`, `gh-app-private-key`,
`slack-bot-token`, `slack-signing-secret` — plus two the tooling publishes for itself:
`microvm-image-arn` (from `npm run image`) and `microvm-role-arn` (from `npm run deploy`).

Anything missing? `npm run secrets` prompts for each value and skips the ones you leave empty — which is
also how you rotate a single credential later. CDK only ever references parameter *paths*, never values,
so no secret reaches the CloudFormation template.

## 7. Try it

The bot only receives mentions in channels it's a member of, so invite it first:

```
/invite @your-agent
@your-agent what ECS services are running in this account?
```

Watch the reactions on your message — they're the progress bar:

**👀** within a couple of seconds (the Lambda got it) → **🟡** (the runtime picked it up) → a reply
in-thread → **🟢** (done). **❓** means it asked you something and is waiting for another mention.
Follow-ups in the **same thread** keep full context for 8 hours.

**A reply alone isn't 🟢.** The agent must also mark the thread done, so a turn that answers well but
forgets that last step gets a ⚠️ note and **🔴** — the answer above it is usually fine. That's deliberate:
auto-closing an unconfirmed turn as green would paint unfinished work as finished. So 🔴 means *either*
a real failure (the agent says what went wrong) *or* an unconfirmed finish (the runtime's ⚠️ note says so).

If you ever see a thread stuck on 🟡, that's a bug — the runtime closes out with a terminal 🟢/🔴 even if
the agent crashes. (It *attempts* that; if Slack refuses the reaction outright the honest result is a
reply with no colour at all, never a colour we didn't manage to set.) Check the runtime logs. A reply or question with *no* colour at all is different:
Slack refused the reaction (`grep slack_status_warning`).

Then try a change:

```
@your-agent open a PR that fixes the typo in the README
```

It clones, branches, edits, runs the repo's checks, and opens a PR as the bot. It never pushes to the
default branch and never merges.

**Iterating on `PROMPT.md`** — the file that decides how good this agent is. Fastest first:

```bash
# 1. in-process: no container, no deploy. Real model, real tools, no Slack.
cd runtime && WORKSPACE_DIR=/tmp/agent env -u AWS_PROFILE npm run local -- "your request"

# 2. the real image, locally — catches anything image-shaped that (1) can't
cd .. && env -u AWS_PROFILE npm run docker -- "your request"

# 3. ship it, then check the deployed VM
env -u AWS_PROFILE npm run image
env -u AWS_PROFILE npm run invoke -- --prompt "Summarize what you know about this system"
```

Only step 3 touches AWS, and it's `npm run image` — **not** `npm run deploy`. The image carries the
prompt; the stack only routes to it.

**Teaching it more:** a skill is a folder — `runtime/skills/<name>/SKILL.md` — picked up with no
registration and no code change. [docs/iterating.md](./docs/iterating.md) covers both seams: what belongs
in the prompt versus a skill, and how to confirm the agent actually loaded yours.

That hits the real deployed runtime and model; the answer lands in the logs (the command prints the
`aws logs tail` line to follow).

## 8. Where to look when something's wrong

Both log groups expire: the ingress after 30 days, the agent's own after **14** (the stack sets it — the
microVM service creates that group implicitly, and an implicitly created group would otherwise keep every
`tool_result`, file contents included, for ever). So debug from the recent past, and copy out anything you
want to keep.

```bash
# The agent's own logs — every tool call and its result
env -u AWS_PROFILE aws logs tail /aws/lambda-microvms/slack-dev-<name> \
  --region eu-west-1 --since 15m --follow

# The Slack ingress Lambda. Its name is CloudFormation-generated, so look it up first:
FN=$(env -u AWS_PROFILE aws cloudformation describe-stack-resources --region eu-west-1 \
  --stack-name SlackDev-<Name> --logical-resource-id SlackEventsFn \
  --query 'StackResources[0].PhysicalResourceId' --output text)
env -u AWS_PROFILE aws logs tail "/aws/lambda/$FN" --region eu-west-1 --since 15m
```

| Symptom | Where to look |
|---|---|
| Slack says the URL didn't return the challenge | The signing secret isn't in SSM — run `npm run secrets`, then **redeploy** (the Lambda caches SSM values per warm container, so a retry alone may hit the stale one) |
| GitHub says the App name is taken | App names are globally unique; pick another. It's only cosmetic and needn't match `agent.config.json` |
| No 👀 at all | **First: is the channel in `allowedChannels`?** An unapproved channel is dropped silently by design — `grep "channel not allowed"` in the Lambda logs, which prints the id to add. Otherwise: the bot isn't in the channel, or the bot token / `reactions:write` scope is wrong |
| `missing_scope` in a tool result | You changed the manifest's scopes — reinstall the app (**OAuth & Permissions → Reinstall**) and re-copy the bot token |
| 👀 but no 🟡 | The Lambda logs say whether it reached the VM at all (`grep '\[route\]'`). If it did, the agent failed to start — check the microVM log group |
| Stuck on 🟡 | Shouldn't happen — the runtime always tries to close out, even if the agent crashes. Two cases it can't fully cover: the VM reclaimed at its 8h ceiling mid-turn (`/terminate` posts a notice and sets 🔴 but has a hard 60s budget — `grep terminate_notice_incomplete`), and Slack refusing the reaction permanently (see the next row). Otherwise check the runtime logs |
| ⚠️ "I may not have finished everything" with NO colour at all | Slack permanently refused the status reaction, so neither the agent nor the runtime could set one — the answer above it is usually fine. `grep slack_status_warning` for the reason; `message_not_found` means the trigger message is gone (see that row). The tools deliberately stop retrying after one attempt rather than burning the turn on a colour |
| A reply or question in-thread but NO 🟢/🔴/❓ | Slack refused the reaction. `grep slack_status_warning` in the runtime logs for the reason; the message itself did land. `message_not_found` means the thread's VM is serving a session id for a message that doesn't exist — see the next row |
| `message_not_found` on every `reactions.add` | The thread's microVM was started for a DIFFERENT (or synthetic) message ts. Happens if you tested the webhook with a hand-crafted payload: that fake thread id claims a session row, and a later real mention can land on it. Fix: terminate that VM and delete its row from the session table, then start a NEW Slack thread. Don't hand-craft `ts` values against a live agent |
| The agent replies but a follow-up gets only 👀 | Expected if the earlier turn is still running: the follow-up is INJECTED into it as a course-correction rather than starting a new turn (`grep message_injected`), so there's no separate reply. It should still pick up the turn's terminal 🟢/🔴; if it doesn't, `grep also_react_capped` — only the most recent few injected messages get a reaction, since the sweep costs Slack calls on every status change. One other case drops it deliberately: if the VM was reclaimed mid-turn (`grep terminated_mid_turn`) the injected messages get no colour, because that path has a hard 60s budget and spends it on the message instead |
| "I hit my work limit for one turn" | The turn used all 200 model round-trips. `grep limitTurns` to confirm; mention it again to continue, and narrow the request |
| 🔴 with the agent's own error message | It explains what failed; the runtime logs have the stack |
| 🔴 with a ⚠️ note under a good-looking answer | The agent replied but never marked the thread done — the answer is probably fine. `grep incomplete_turn` in the runtime logs confirms it |
| ⚠️ note about not finishing, no error anywhere | The turn may have hit the 200-round-trip cap. `grep incomplete_turn` and check whether the work was actually done |
| Deployed fine but the agent never says anything | `grep ALERT` in the runtime logs — a missing `SLACK_BOT_TOKEN` is reported there at boot, and it's the one failure the agent cannot report itself |
| `not_authed` in a tool result | The bot token in SSM is missing or stale. Both readers cache it — start a new thread for the runtime's copy, and redeploy for the Lambda's |
| Git clone returns 401/403 | The App install, the selected repository, or the Contents permission |
| PR creation returns 403 | The Pull requests permission |
| Follow-up lost context | A different thread, or the 8h session expired — both start fresh by design |
| `context-window-overflow` in the logs | One thread got too long; start a new one |

An unsigned request to the endpoint should return **401** — that's the signature check doing its job:

```bash
curl -i -X POST "<SlackEventsUrl>" -d '{}'
```

## Deploying from GitHub Actions (optional)

Only useful if this clone lives in **its own repo** that you push.

**Cloned this to run an agent for a different repo? Delete `.github/` first.** The shipped workflow
deploys *this template's* repo into *its author's* account from *its* `main` — none of which is true in
your clone, and a stray workflow file in someone else's repository is worse than clutter. How you deploy
is your call: from a laptop with `npm run image` + `npm run deploy`, or your own pipeline. What follows
is the keyless setup if you want the latter.

Auth is **keyless** — GitHub OIDC exchanged for a short-lived role, so there are no AWS keys in the
repo or in GitHub secrets. One-time setup:

```bash
env -u AWS_PROFILE npm run setup:oidc    # creates/reuses the OIDC provider + the deploy role
```

It's a script, not a stack, on purpose: you need it only if THIS clone deploys itself from Actions. An
agent you stood up for another repository deploys from a laptop and wants none of it. The script is
idempotent and reuses an account's existing GitHub OIDC provider — there can be only one per issuer, so
an account that already uses GitHub Actions anywhere has one.

Then in the repo: **Settings → Secrets and variables → Actions → Variables → New variable**, named
`AWS_DEPLOY_ROLE_ARN`, set to the printed ARN. It's a *variable*, not a secret — a role ARN isn't
sensitive, and nothing can assume it without a signed OIDC token from this repo's `main`.

**Replace `agent.config.ci.json` — it is NOT yours.** `agent.config.json` is gitignored (so a fork can't
inherit someone's channel ids), which leaves CI with no config; this committed file fills that gap, and the
workflow copies it into place. The version in this repo is a complete, valid config for **the template's
own** agent — its repo, its Slack channel — so nothing about it looks wrong and no placeholder guard
fires. Left as-is, your pipeline deploys an agent pointed at someone else's channel. Overwrite all four
fields with yours, commit it, and keep in mind it's public: a channel id isn't a credential, but it is a
real identifier anyone reading your repo can see.

After that, a push to `main` runs `npm run check`, then `npm run image`, then `npm run deploy` — in that
order, because the image is the agent and the stack only routes to it. Pull requests run the checks
only; the role trusts `refs/heads/main` of this exact repo, so a PR (including from a fork) cannot
deploy even if the workflow tried.

**Protect `main`.** With this workflow, push access to main is deploy access.

Two things worth knowing:

- The role is created **by hand** and is not part of `npm run deploy` — it's the identity that performs
  deploys, so a deploy must not be able to widen its own permissions.
- The role can publish the image ARN but **cannot read any agent's secrets** (no `ssm:GetParameter`, no
  `kms:Decrypt`). A compromised workflow can redeploy the agent; it can't exfiltrate a Slack token or a
  GitHub private key.

## Adding a second agent

Clone this repo again, give it a different `name` in `agent.config.json`, create its own Slack and
GitHub apps, and deploy. Nothing collides: the stack sets no fixed resource names, and the three
identifiers that must be named (stack, runtime, API) all derive from `name`.

## Removing one

```bash
env -u AWS_PROFILE npm run destroy
env -u AWS_PROFILE aws ssm delete-parameters --region eu-west-1 \
  --names /slack-dev/<name>/slack-bot-token /slack-dev/<name>/slack-signing-secret \
          /slack-dev/<name>/gh-app-id /slack-dev/<name>/gh-app-install-id \
          /slack-dev/<name>/gh-app-private-key
```

Secrets are deliberately not deleted by `destroy` — they're operator-owned, and losing them to a
mistyped command would be worse than leaving them. Delete the Slack and GitHub apps by hand.
