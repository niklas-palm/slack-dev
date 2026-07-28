# Handoff: how to talk to the user

The setup succeeds or fails on communication as much as on commands. The user is watching an agent run
things in their AWS account and their Slack workspace. Never leave them unsure whether it's their turn.

## The rule for every user-facing step

State four things, in this order:

1. **What you're about to run**, and what it will change.
2. **What they'll see** — a browser tab opening, a wait of several minutes, a prompt.
3. **Exactly what to click**, in their words, in order.
4. **What happens next**, so they know when they're done.

Bad: "Running the GitHub App script — let me know when you've clicked through."
Good: "I'll run `npm run github-app` now. Your browser will open on GitHub with the name and permissions
already filled in. Click **Create GitHub App** — then GitHub redirects you to an install page, where you
pick **Only select repositories**, choose `acme/platform`, and click **Install**. I'll store the App ID,
private key, and installation ID automatically; you won't need to copy anything."

## Ask before the Slack step: assisted or manual

**The Slack step is the only one involving a secret the user must obtain.** Ask which way they want it
before starting — do not assume:

> The Slack setup needs two tokens. Two ways to do this:
>
> **A — I run it (faster).** I'd need you to paste a Slack config *refresh* token so my script can
> create the app, wire the Request URL, and store the signing secret. **That token would appear in this
> conversation.** It's workspace-scoped and can create/modify Slack apps, so if that's not something you
> want in a transcript, choose B. You can revoke it afterwards at api.slack.com/apps.
>
> **B — You run it (nothing sensitive shared).** You run two commands in your own terminal with the
> tokens in your own shell; I give you the exact commands and stay out of the way. Takes a few minutes
> longer.

If they pick **A**, use it — it's their call. If they pick **B**, give them this, filled in:

```bash
cd <path-to-agent-clone>

# One-time per workspace: https://api.slack.com/apps → below the app list →
# "Your App Configuration Tokens" → Generate Token → copy the REFRESH token (the one whose prefix is xoxe, not the access token)
export SLACK_CONFIG_REFRESH_TOKEN='<paste the xoxe- refresh token>'
env -u AWS_PROFILE npm run slack-app        # stores it, then exits

# Creates the app, wires app_mention to the deployed URL, stores the signing secret,
# and opens the install page. Click "Install to Workspace" → Allow, then paste the
# Bot User OAuth Token (xoxb-…) at the prompt.
env -u AWS_PROFILE npm run slack-app
```

Tell them: **use `export`, not an inline `--refresh-token` flag**, so the token stays out of shell
history; and both `SLACK_CONFIG_REFRESH_TOKEN` and `SLACK_BOT_TOKEN` are read from the environment, so
nothing has to be typed where it can be seen. Then ask them to tell you when it's done, and continue
from step 8 yourself.

The same choice applies to a GitHub App created by hand — `setup.md` step 3 has that fallback, and
`npm run secrets` prompts for every value with the input hidden.

## Never do these

- **Never echo a token**, even partially, even to confirm it looks right. The scripts validate prefixes
  themselves.
- **Never run a command with a token as an inline argument** if an env var will do — it lands in history
  and in this transcript.
- **Never pick a GitHub App name for the user** when one is taken. It's the bot's identity on every PR.
- **Never deploy without confirming the AWS account.** Read-only or not, it's their infrastructure.
- **Never claim a step worked without checking.** Read the output; report what it actually said.

## The closing message

Once `npm run invoke` has proven the runtime works, close with something like this — adapted, not
copy-pasted:

> **`<name>` is live.** Invite it and try it:
>
> ```
> /invite @<name>
> @<name> what ECS services are running in this account?
> ```
>
> **Watch the reactions on your message** — they're the progress bar:
> 👀 received → 🟡 working → a reply in-thread → 🟢 done. **❓** means it asked you something and is
> waiting; mention it again to continue. Follow-ups in the **same thread** keep full context for 8 hours.
>
> **Three things worth trying:**
> - `@<name> why did the last deploy fail?` — it reads this account's logs directly.
> - `@<name> look at the review comments on PR #42 and address them` — it clones, reads the feedback,
>   pushes to the branch, and replies with what it changed.
> - `@<name> open a PR that <small fix>` — it never pushes to `<default-branch>` and never merges.
>
> **Two files make it yours**, both in `<clone-path>/runtime`, both plain markdown, neither needing code:
>
> - **`PROMPT.md`** — what it knows about your system: the topology, where the logs live, what to lead
>   with. It's APPENDED to the built-in rules, so you never edit those and can't break them.
> - **`skills/<name>/SKILL.md`** — a procedure it should follow. Drop the folder in and it's picked up:
>   no registration, no code. The agent only loads a skill when its one-line `description` matches the
>   question, so a long skill costs nothing until it's needed.
>
> Try a change with no AWS at all, then ship it:
> ```bash
> cd runtime && WORKSPACE_DIR=/tmp/agent env -u AWS_PROFILE npm run local -- "a request"
> cd .. && env -u AWS_PROFILE npm run image      # image, NOT deploy — the image carries both files
> ```
> Start a NEW Slack thread to see the change; an existing thread keeps its VM for up to 8h.
> `docs/iterating.md` in the clone has the full guide, including what belongs in the prompt versus a
> skill, and how to confirm the agent actually loaded yours.
>
> A couple of things to know: **a reply followed by 🔴 usually isn't a failure** — the agent must also
> mark the thread done, so a turn that answers well but skips that gets a ⚠️ note and 🔴; the answer above
> it is normally fine. And it only answers in `<the approved channels>`; a mention anywhere else is
> silently ignored by design.
>
> `setup.md` in the clone is the full runbook, including a troubleshooting table.

Adjust the suggestions to what this agent actually looks after — a data pipeline gets different examples
than a web app. Generic examples make it look like a demo rather than their agent.
