# What the agent can and cannot do

Read this before answering a security question, and **before proposing any permission change** — each
grant below is deliberate, and the omissions are the point.

## GitHub: propose, never land

The GitHub App is created from a manifest in `infra/scripts/create-github-app.ts`, so the permissions are
code and can't drift from what the agent needs.

| Grant | Why |
|---|---|
| `contents: write` | clone the repo, push feature branches |
| `pull_requests: write` | open and update PRs, **read review comments** ("address the feedback on my PR") |
| `issues: write` | comment on issues — GitHub models a PR as an issue |
| `actions: read` | read CI status and failed workflow logs |
| `checks: read` | read check runs |
| `workflows: write` | edit `.github/workflows` — **required**, because GitHub refuses an App push that touches a workflow file without it |

**Not requested:** `administration`, `members`, `organization`, `environments`, `secrets`. Nothing here
can merge a PR, administer the repo, or trigger/cancel a workflow run. `default_events` is empty, so
GitHub cannot wake the agent at all — Slack is the only trigger.

`workflows: write` is the one grant that widens blast radius: a *merged* workflow edit runs with the
repo's secrets. That's precisely why the agent can only author the PR and a human reviews the diff. If
that's not acceptable for a given repo, drop it from the manifest — the cost is that any PR touching
`.github/workflows` fails at the push.

**Enforced by prompt, not code:** never push to the default branch, never merge. `contents: write`
technically allows both. If it matters, add a branch-protection rule on the default branch and leave the
App out of the bypass list.

## AWS: read-only, plus Bedrock

The runtime role (`infra/lib/stack.ts`) carries:

- **`ReadOnlyAccess`** (AWS managed) — so the agent can investigate the account it's deployed in. This is
  the whole reason to deploy it beside the workload it watches.
- **Bedrock invoke + read** (`InvokeModel*`, `Converse*`, `Get*`, `List*`) — `ReadOnlyAccess` doesn't cover
  *invoking* a model, and the agent is often asked about the account's own Bedrock setup (which models are
  enabled, why a throttle happened). **Not `bedrock:*`:** that also grants `DeleteKnowledgeBase`,
  `DeleteGuardrail`, `PutModelInvocationLoggingConfiguration` (redirect or disable audit logs) and
  `Retrieve`/`RetrieveAndGenerate`, which read knowledge-base *contents* — so "Bedrock holds no data of
  its own" is wrong, and a wildcard made a prompt injection able to delete a knowledge base on a role
  documented as read-only.
- **`ssm:Get*` on `/slack-dev/<name>/*` only**, plus an explicit **Deny** on every other agent's
  parameters. The Deny is load-bearing, not belt-and-braces: `ReadOnlyAccess` already grants `ssm:Get*` on
  `*`, so an Allow cannot narrow it. Without the Deny, a prompt injection could read another agent's
  private key. **Deny `ssm:Get*`, never a list of verbs** — an enumerated Deny missed
  `GetParameterHistory`, which returns a decrypted SecureString just like `GetParameter`, and it was
  verified reading a co-tenant's live bot token. A matching **Deny on `kms:Decrypt`** outside the agent's
  own prefix is needed too, since the KMS Allow's ViaService condition scopes it to SSM but not to a
  parameter.
- **`kms:Decrypt`** conditioned on `kms:ViaService: ssm.<region>.amazonaws.com` — needed to read a
  SecureString, and useless for anything else.

**No write access, deliberately.** The agent cannot create, modify, or delete an AWS resource, and cannot
run `cdk deploy` or `cdk bootstrap`. So an infra fix is a PR that CI or a human applies.

If asked to add deploy permissions: say what it costs. CDK needs `cloudformation:*` plus `iam:PassRole`,
which together are effectively account admin — and that would mean anything the agent *reads* (a PR
comment, a CI log, a third-party Slack message) could become a resource change. The read-only boundary is
what makes prompt injection survivable here. Recommend the PR path; if the user insists after hearing
that, it's their call.

## Slack: bound to where it was summoned

- **Seven scopes**, no more: `app_mentions:read`, `channels:history`, `groups:history`, `chat:write`,
  `reactions:write`, `files:read`, `files:write`.
- **The channel and thread come from the invocation**, never from a model parameter — there is no way for
  the agent to name a different channel. It can only reply where it was mentioned.
- **`allowedChannels`** is enforced in the ingress Lambda *before* the 👀: an unapproved mention costs no
  reaction, no invoke, and no model call. An empty list means any channel the bot is in.
- DMs are dropped — the ingress filters to `app_mention`, and a DM arrives as `message.im`.

## Secrets

Five SSM SecureStrings at `/slack-dev/<name>/`: `gh-app-id`, `gh-app-install-id`,
`gh-app-private-key`, `slack-bot-token`, `slack-signing-secret`. Only parameter **paths** reach
CloudFormation; values never enter a template. The ingress Lambda is scoped to exactly the three
parameters it reads — not the whole prefix, which would expose the GitHub private key to a function with
no use for it.

The prompt forbids echoing a secret anywhere, including the clone's remote URL, which contains a live
installation token.
