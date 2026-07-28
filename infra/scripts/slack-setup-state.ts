/**
 * What a run of `npm run slack-app` should do, given what's already stored.
 *
 * Its own module so it can be tested without importing the script (whose top-level body runs the whole
 * setup). Pure, so the decision is testable — an earlier attempt tested this by grepping the script's
 * source and passed against the very bug it was written for, because the string it matched was in a
 * comment.
 *
 * The four states exist because the signing secret is written the instant an app is created, while the
 * bot token only arrives after a human installs it:
 *
 * `create`      — nothing stored yet; make the app.
 * `store-token` — the app exists and a token was supplied: store it, create nothing.
 * `need-token`  — the app exists, but no token is stored or supplied. Creating another app would
 *                 overwrite this one's signing secret, leaving a secret and a token from DIFFERENT apps
 *                 — which fails every HMAC check with no obvious cause. A real incident, not a theory.
 * `done`        — both stored; nothing to do.
 */
export type SlackSetupStep = "create" | "store-token" | "need-token" | "done";

export function nextStep(
  secretStored: boolean,
  tokenStored: boolean,
  tokenSupplied: boolean,
): SlackSetupStep {
  if (!secretStored) return "create";
  if (tokenStored) return "done";
  return tokenSupplied ? "store-token" : "need-token";
}
