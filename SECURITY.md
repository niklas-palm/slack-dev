# Security — Slack Dev

## Reporting a vulnerability

Please **don't open a public issue.** Use GitHub's private reporting — *Security → Report a
vulnerability* on this repository — or contact the maintainers directly. We'll acknowledge and work with
you on a fix before any disclosure.

## What this sample actually grants

Worth understanding before you deploy it, because some of it is unusual for a sample:

- **An unrestricted shell.** `run_bash` has no command allowlist. Anyone who can @-mention the agent in
  an approved channel can run arbitrary code in its microVM.
- **GitHub write credentials.** The App can push branches, open PRs, and edit `.github/workflows`. It
  **cannot** merge, push to the default branch, administer the repo, or trigger a workflow run.
- **AWS read access** to the account it's deployed in (`ReadOnlyAccess`), plus Bedrock. It cannot create,
  modify, or delete a resource — so an infra fix is a PR, not an apply.

The isolation is the microVM: one per Slack thread, Firecracker-isolated, terminated within 8 hours.

## The two controls that bound who can direct it

1. **`allowedChannels`** — the Slack channel ids it answers in, enforced in the ingress Lambda before any
   reaction or model call. **Set this in a large workspace.** Left empty, anyone who can `/invite` the
   bot can put an agent with repository credentials to work.
2. **The GitHub App's installation scope** — install it on one repository, not an organisation.

## Prompt injection

The agent treats everything it *reads* as data, never as instructions: repository files (including any
`AGENTS.md`/`CLAUDE.md`), Slack messages from other people, PR and issue bodies, CI logs, and `curl`
output. That rule is in the system prompt and pinned by tests.

It is a mitigation, not a proof. The reason a successful injection is survivable here is the permission
boundary, not the prompt: AWS is read-only, and GitHub can only propose. Please keep it that way when
you extend this — and if you widen either, say so loudly in your fork.

## Known limits, accepted deliberately

- **Secrets are redacted from logs at one chokepoint, and the redaction is not total.** `emit()`
  (`runtime/src/emit.ts`) scrubs known token shapes (`ghs_`, `xox…`, PEM blocks, `x-access-token:`) plus
  the literal values of the secrets we put in the environment, because `tool_result` lines log whatever a
  command printed — and the GitHub token lives in the clone's remote URL, so a plain `git remote -v` used
  to persist a live credential to CloudWatch. Two limits worth knowing: a token **split across a line
  break** still gets through (the patterns are per-line), and `emit()` is the ONLY redacted path — a bare
  `console.log` added later is not covered.
- **`curl` inside `run_bash` is unguarded** — no SSRF protection, size cap, or content-type check. Fine
  for a trusted workspace fetching a doc page; port a real fetcher if you need research.
- **Isolation is per-THREAD, not per-message.** A thread's microVM is created on the first mention and
  REUSED for every later one until it expires (8h ceiling, suspended while idle) — that reuse is what
  gives a follow-up its conversation and its cloned repo. The consequence: if a thread is compromised by
  prompt injection, the same VM — and everything written to `/workspace` — is still there for the next
  mention in that thread. Firecracker isolates one thread from another, not a thread from its own past.
  **If you suspect a thread, start a new one** rather than correcting in place.
- **Never push to the default branch / never merge is enforced by the prompt, not by IAM.** The App's
  `contents: write` technically allows both. Add a branch-protection rule if that matters to you.
- **Secrets live in SSM SecureStrings** and reach the runtime as parameter *paths*; no value enters a
  CloudFormation template.
- **The agent can read its own credentials, and nothing technically stops it sending them somewhere.**
  This is the most important accepted risk here, so it's stated plainly rather than implied. The GitHub
  App id/key are in the microVM's environment; `run_bash` spawns children that inherit it (which is how
  the **github** skill mints a token at all), the clone's `.git/config` holds a live token, and egress is
  unrestricted — so `curl` can reach any host. Only the system prompt stands in the way, and a prompt is
  not a security control: a sufficiently convincing injection in a PR body, a CI log or a fetched page
  could in principle talk the agent into exfiltration.

  We accept it, because the credential is deliberately weak and the blast radius small: the installation
  token lasts ~1h, the App is scoped to ONE repository, and it cannot merge, push to a protected branch,
  administer the repo, or touch any other repo. Worst realistic case is an hour of unwanted branches and
  PR comments on a repo whose source is public anyway — not a breach. `ReadOnlyAccess` grants no
  `secretsmanager:GetSecretValue` and no `kms:Decrypt` (verified against the AWS managed policy), and the
  stack adds an explicit Deny so a VM can't read another agent's SSM secrets.

  That Deny is only as good as its action list. It once named `GetParameter`, `GetParameters` and
  `GetParametersByPath` — and `ssm:GetParameterHistory`, which also returns a decrypted SecureString,
  walked straight through it (verified against the live account: it returned a co-tenant's `xoxb-…` token
  in plaintext). It is now `ssm:Get*`, plus a Deny on `kms:Decrypt` outside this agent's own prefix,
  because the ViaService condition scopes the KMS Allow to SSM but not to a parameter. **If you add an
  agent to an account that already has one, this boundary is what separates them — an enumerated action
  list will silently reopen it the next time AWS ships a read verb.**

  For calibration: this is the same trade anyone makes running a coding agent locally with a `gh` token
  or an SSH key in their shell — the agent can read the credential and reach the network, and only its
  instructions say otherwise. The difference here is in our favour: a personal token usually carries
  every repo you can touch and the power to merge, while this one expires in ~1h, sees ONE repo, and can
  only propose. What's genuinely different is *who can trigger it* — a teammate in a Slack channel rather
  than you at your keyboard — which is why `allowedChannels` is the control that matters most.

  **If that trade doesn't hold for you** — a private repo with valuable history, an org-wide install, a
  broad channel policy — the fix that actually works is **egress restriction** (allow only GitHub, Slack
  and Bedrock). Explicit GitHub tools would *not* fix it: the agent needs a working clone to do its job,
  and a clone's credentials are reachable from the shell it debugs in.

See the README's *Guardrails* and *Trust boundary* sections for the full picture, including which
protections are enforced in code and which are prompt-only.
