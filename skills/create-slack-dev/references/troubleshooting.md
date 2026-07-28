# Troubleshooting the setup

Failures **during setup** are here. Failures **after handoff** (no 👀, stuck on 🟡, `missing_scope`, and
so on) are in the clone's `setup.md` troubleshooting table — read that rather than duplicating it, and
point the user there.

## Config and prerequisites

| Symptom | Cause and fix |
|---|---|
| `No agent.config.json yet` | `cp agent.config.example.json agent.config.json`, then fill it in. The real file is gitignored on purpose. |
| `still has the placeholder name "demo"` | `name` was never set. Step 1 — ask the user; don't invent one. |
| `"allowedChannels" takes channel IDs, not names` | Someone wrote `#ops`. Slack's event payload carries only the id; get it via right-click channel → View channel details. |
| `"name" must match /^[a-z]...` | The slug feeds a stack name, an SSM path, and a microVM image name. Lowercase letters, digits, hyphens only. |
| `list-inference-profiles` returns nothing / not `ACTIVE` | Opus 5 isn't enabled in Bedrock in eu-west-1. **The user must enable it in the console** — model access is a console-only consent step. |
| `npm run image` fails | The build runs in AWS, not locally, so it's rarely the machine. It prints the command that names the failing Dockerfile step — read that. Everything the agent needs at run time must be installed in the Dockerfile: a nested `docker build` inside a VM can't resolve DNS. |
| `Need to perform AWS CDK bootstrap` | Bootstrap once, **before** deploying: `(cd infra && env -u AWS_PROFILE npx cdk bootstrap "aws://<account>/eu-west-1")`. |
| Any AWS call returns `ExpiredToken` | The shell's temporary credentials lapsed. The user must refresh them; every command uses `env -u AWS_PROFILE` so it reads the shell, not a profile. |

## GitHub App

| Symptom | Cause and fix |
|---|---|
| `name is already taken` | App names are unique across all of GitHub, so generic ones usually are. Check candidates before asking the user to click anything: `curl -sLo /dev/null -w '%{http_code}' https://github.com/apps/<slug>` → only `404` is available, anything else is taken (an existing App may answer 301, so `-L` matters and looking for `2xx` misses it). **Ask the user** which free name they want — it's the bot's identity on PRs — then re-run with `-- --app-name <choice>`. |
| `gh-app-id already exists` | An App is already registered for this agent. Re-running is blocked so you can't orphan one. Delete that SSM parameter only if the user confirms they want a new App. |
| `"url" wasn't supplied` | A malformed manifest — GitHub reads `hook_attributes` as a webhook declaration whose `url` is required. The shipped manifest omits it entirely; don't add it back. |
| The script exits after creating the App but before storing something | **Don't re-run** — it would create a second App. The script prints the exact `aws ssm put-parameter` command; follow that, or use `npm run secrets`. |
| A push fails with `refusing to allow a GitHub App to ... workflow` | The App lacks `workflows: write`. It's in the manifest now; an App created before that needs the permission added in its settings, then the install re-approved. |

## Slack app

| Symptom | Cause and fix |
|---|---|
| `No Slack app-configuration token stored yet` | The one-time, workspace-wide setup. See the assisted-vs-manual choice in `handoff.md` — **ask the user which they prefer before proceeding.** |
| `invalid_refresh_token` | Config tokens rotate; the stored one is stale. The user generates a new one at api.slack.com/apps and re-runs with `SLACK_CONFIG_REFRESH_TOKEN=…`. |
| `That doesn't look like a refresh token` | They copied the **access** token (`xoxa-`/`xoxp-`). It's the **refresh** token that's needed — the xoxe-prefixed one. |
| `No TTY, so the token can't be typed` | You ran the script non-interactively and it reached the bot-token prompt. **The Slack app now exists.** Re-running is safe ONLY with the token in the environment: `export SLACK_BOT_TOKEN=xoxb-… && npm run slack-app` stores it and creates nothing. Without the var the script refuses — creating a second app would overwrite the first's signing secret, and a secret + token from different apps fails every HMAC check. |
| A documented `-- --flag` recovery does nothing | npm DROPS flags across a `-w <workspace>` boundary (it parses them as npm's own config). Root scripts must invoke `tsx` directly — `github-app`, `slack-app` and `invoke` all do. If someone "tidies" one back to `npm run x -w infra`, every `--app-name`/`--prompt` recovery silently breaks with no error. |
| `slack-bot-token already exists` | Slack is already configured for this agent. Nothing to do unless rotating, which is `npm run secrets`. |
| Slack rejects the Request URL | The stack isn't deployed, or was deployed after the app was created. Slack **must** come after the deploy. |

## Deploy

| Symptom | Cause and fix |
|---|---|
| The agent never answers, and the Lambda logs show no `[route]` line | The image ARN isn't in SSM — run `npm run image`. The stack routes to an image it doesn't build. |
| `already exists` on a named resource | Another agent used the same `name` in this account, or a previous stack wasn't cleaned up. Pick a different `name`. |
| `npm run invoke` says no image ARN | `npm run image` hasn't run for this agent, or it failed. It publishes the ARN both scripts read. |
| `refuses to deploy outside eu-west-1` | Intentional — the template is pinned there; don't override the guard from the CLI. To actually run elsewhere, confirm MicroVMs and the model are available in that region, then change the pinned constants (SKILL.md "Region: check before you move"), `MODEL_ID` included. |
| Deploy succeeds but `npm run invoke` gets nothing | Check the microVM log group for a boot failure. `grep ALERT` catches a missing `SLACK_BOT_TOKEN`, which the agent cannot report itself. A VM that terminates within a second of launch usually means its execution role was just created — IAM propagation, so retry. |

## After handoff, from the first live run

| Symptom | Cause and fix |
|---|---|
| `message_not_found` on every `reactions.add` | The thread's VM is serving a session id whose Slack message doesn't exist — almost always because someone tested the webhook with a hand-crafted payload, whose fake `ts` claimed a session row that a later real mention then reused. Terminate that VM, delete its row from the session table, and start a NEW thread. **Never hand-craft a `ts` against a live agent** — test with a real Slack message. |
| A reply lands but the follow-up shows only 👀 | A mention arriving mid-turn is INJECTED into the running turn rather than starting a new one (`grep message_injected`), so there's no second reply — that part is correct. But it SHOULD still get the turn's terminal 🟢/🔴. If it's stuck on a bare 👀, check `grep also_react_capped`: only the few most recent injected messages get a reaction (the sweep costs Slack calls on every status change), so the 5th+ interruption in one turn keeps its 👀 by design. |
| The first VM of a fresh deploy can't reach Slack | It booted before the bot token was stored. Secrets load per-VM in the `/run` hook, so any VM started earlier has none. Terminate it; the next mention starts a VM that reads the token. |

## When you're unsure

Read the actual output rather than guessing, and check the two log groups:

```bash
# the agent, inside its microVM (one group per image, shared by that agent's VMs)
env -u AWS_PROFILE aws logs tail /aws/lambda-microvms/slack-dev-<name> \
  --region eu-west-1 --since 15m

# the Slack ingress Lambda — routing decisions are the `[route]` lines
env -u AWS_PROFILE aws logs tail /aws/lambda/<function> --region eu-west-1 --since 15m
```

Every log line is structured JSON, so `grep` on an event name works: `session_start`, `tool_input`,
`tool_result`, `incomplete_turn`, `slack_status_warning`, `channel not allowed`, `ALERT`, `[route]`.
