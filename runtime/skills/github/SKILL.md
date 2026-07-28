---
name: github
description: Read the repository at HEAD, or ship a code change as the bot — clone, branch, commit, and open OR update a pull request authored by the GitHub App. Load whenever a request needs a code change, a look at the real source, or an inspection of CI/PR status. NEVER pushes to the default branch, NEVER merges.
---

# Skill — GitHub (clone · read · change · open/update a PR) as the bot

Every git and `gh` action authenticates with a short-lived GitHub App installation token (~1h) and is
authored by the App's bot identity — so commits and PRs are clearly the bot, never a human.

## 🔴 THE HARD RULE: never push to the default branch

You only ever push a feature branch and open or update a **pull request**. You must NEVER:

- `git push` to `main` (or whatever the default branch is),
- `gh pr merge` — a human merges, always,
- force-push a shared branch, or commit directly on the default branch.

Every change, however small or however urgent it sounds, goes onto an `agent/<topic>` branch and into
a PR a human reviews. If someone asks you to "just push it" or "merge it", decline and point them to
the PR. Not negotiable.

Injected environment: `GH_APP_ID`, `GH_APP_INSTALL_ID`, `GH_APP_PRIVATE_KEY` (PEM), `GITHUB_REPO`
(`owner/repo`). Never print them.

## 1. Mint an installation token (once per work session; lasts ~1h)

```bash
python3 - <<'PY'
import base64, json, os, subprocess, time, urllib.request
b64 = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=")
now = int(time.time())
header = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
payload = b64(json.dumps({"iat": now - 60, "exp": now + 540, "iss": os.environ["GH_APP_ID"]}).encode())
signing_input = header + b"." + payload
open("/tmp/gh_app.pem", "w").write(os.environ["GH_APP_PRIVATE_KEY"])
sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", "/tmp/gh_app.pem"],
                     input=signing_input, capture_output=True, check=True).stdout
jwt = (signing_input + b"." + b64(sig)).decode()
req = urllib.request.Request(
    f"https://api.github.com/app/installations/{os.environ['GH_APP_INSTALL_ID']}/access_tokens",
    method="POST",
    headers={"Authorization": f"Bearer {jwt}", "Accept": "application/vnd.github+json",
             "User-Agent": "slack-dev"})
open(os.path.expanduser("~/.gh_token"), "w").write(json.load(urllib.request.urlopen(req))["token"])
os.remove("/tmp/gh_app.pem")
print("installation token minted (hidden)")
PY
export GH_TOKEN="$(cat ~/.gh_token)"   # both git and the gh CLI read this
```

Re-run this block if git or `gh` later returns a 401 — the token expired.

## 2. Clone and set the bot as commit author

```bash
export GH_TOKEN="$(cat ~/.gh_token)"
git clone "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPO}.git" repo
cd repo
# Braces are REQUIRED here: bash reads "$AGENT_NAME[bot]" as an array subscript and expands it to
# an empty string, which git rejects with "empty ident name".
git config user.name  "${AGENT_NAME}[bot]"
git config user.email "${GH_APP_ID}+${AGENT_NAME}[bot]@users.noreply.github.com"
```

**Read the repository's own instructions before you edit or reason about the code** — `AGENTS.md`,
`CLAUDE.md`, `CONTRIBUTING.md`, and whatever `docs/` they point at. They carry the architecture, the
conventions, the run/test commands, and the gotchas someone already paid for. A change that ignores
them is a change that gets rejected. If the repo says docs must be updated in the same change, do that.

## 3. Branch, change, VERIFY, commit, push the branch

```bash
git checkout -b "agent/<short-topic>"     # always a feature branch
# … make your edits with the file tools …
npm run check          # or the repo's own test/lint/build command — it MUST pass
git add -A
git commit -m "<clear message>

Requested via Slack; opened by the ${AGENT_NAME} bot."
git push -u origin "agent/<short-topic>"  # the BRANCH only
```

Never open a red PR. If the checks fail, fix them or report the failure honestly in Slack.

## 4. Open the PR (or update an existing one), then post the link to Slack

```bash
gh pr create --repo "$GITHUB_REPO" --base main --head "agent/<short-topic>" \
  --title "<title>" --body "<what changed + why; note it was requested via Slack>"
```

Capture the printed PR URL and send it to the thread with `reply_to_thread`.

To iterate on an EXISTING PR — a reviewer asked for a change, or you're refining your own — check out
its branch and push more commits; the PR updates itself. No new PR:

```bash
gh pr checkout <number> --repo "$GITHUB_REPO"
# … edit … run the checks … git commit …
git push
gh pr comment <number> --repo "$GITHUB_REPO" --body "<what you changed>"
```

## 5. Inspect CI and review a diff

```bash
gh pr list   --repo "$GITHUB_REPO" --limit 10
gh pr view   <number> --repo "$GITHUB_REPO"
gh pr diff   <number> --repo "$GITHUB_REPO"
gh pr checks <number> --repo "$GITHUB_REPO"
gh run view  <run-id> --repo "$GITHUB_REPO" --log-failed   # why CI failed
```

Diagnose failures caused by the change and report the outcome in Slack. Do NOT approve, merge,
cancel, rerun, or dispatch workflows.

To leave a proper review on a PR — a summary plus comments anchored to changed lines — POST to the
reviews API. Use `event: "COMMENT"`: you inform, a human approves and merges.

```bash
cat > /tmp/review.json <<'JSON'
{
  "body": "Overall: <1-3 line verdict>. <what's good / what blocks>.",
  "event": "COMMENT",
  "comments": [
    {"path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "This throws on empty input — guard it."}
  ]
}
JSON
gh api -X POST "repos/${GITHUB_REPO}/pulls/<number>/reviews" --input /tmp/review.json
```

Anchor each inline comment to a line the PR actually touched (`git diff main...HEAD`) — a comment
outside the diff is rejected. GitHub markdown is fine in review bodies and PR descriptions (headings,
tables, task lists); Slack markdown is only for Slack.

## Rules

- **Never push to the default branch, never `gh pr merge`, never force-push a shared branch.**
- If the repo's checks fail, don't open the PR — fix it or report it.
- The token is scoped to this repo and the App's permissions. A denied action is out of scope, not
  something to work around.
