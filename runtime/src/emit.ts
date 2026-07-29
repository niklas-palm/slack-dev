// One structured JSON line per event, to stdout → CloudWatch. The only observability surface:
// every invocation is fire-and-forget, so these lines are how you debug a run after the fact.

/**
 * Secret shapes that must never reach the log stream.
 *
 * Why this exists: `tool_input`/`tool_result` log whatever a tool printed, and the github skill puts a
 * minted installation token in `~/.gh_token` AND in the clone's remote URL. So `git remote -v`,
 * `git config --list`, `env`, `cat ~/.gh_token`, or merely a git command that fails and echoes the remote
 * in its error, persisted a LIVE `ghs_…` token to CloudWatch. Verified before this fix: a result
 * containing `https://x-access-token:ghs_…@github.com/o/r.git` was emitted complete.
 *
 * The prompt tells the model not to paste credentials, but this path needs no model cooperation at all —
 * the runtime logs it unconditionally. A prompt can't fix a runtime leak, so redact at the chokepoint.
 */
const SECRET_PATTERNS: RegExp[] = [
  /ghs_[A-Za-z0-9]{20,}/g, // GitHub App installation token (what the agent actually holds)
  /ghp_[A-Za-z0-9]{20,}/g, // classic PAT
  /github_pat_[A-Za-z0-9_]{20,}/g, // fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack bot/user/app tokens
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /x-access-token:[^@\s"']+/g, // the credential embedded in a clone URL
];

/**
 * Values we know are secret because we put them in the environment ourselves. Pattern matching can't
 * cover a signing secret (it's just hex), so scrub the literal values too. Read on each call, not at
 * import: secrets are loaded per-VM in /run, long after this module is first imported.
 */
const SECRET_ENV_VARS = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "GH_APP_PRIVATE_KEY",
  "GH_TOKEN",
];

function redact(line: string): string {
  let out = line;
  for (const name of SECRET_ENV_VARS) {
    const secret = process.env[name];
    // A short value would match everywhere and mangle unrelated output; a real credential is long.
    if (secret && secret.length >= 12) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export function emit(event: string, data: Record<string, unknown> = {}): void {
  // Redact the SERIALIZED line, not each field: a secret can be nested anywhere in a tool result, so
  // stringifying first means one pass covers every shape.
  console.log(redact(JSON.stringify({ event, ...data })));
}
