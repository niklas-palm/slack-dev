/**
 * The auto-submitting HTML form that carries a GitHub App manifest to github.com.
 *
 * Its own module for the same reason as slack-setup-state.ts: the script's top-level body runs the whole
 * setup (reads config, builds an SSM client), so a test can't import it. The escaping below was
 * previously "tested" by a case that rebuilt the same `.replace()` inline and asserted on its own local
 * copy — so deleting the real one left all eight tests green. Third time this repo has paid for that
 * shape, hence: one exported function, tested where it actually runs.
 */

/**
 * The manifest rides in a SINGLE-quoted HTML attribute, so a lone apostrophe — `It's the team's agent` —
 * closes the attribute early and corrupts the JSON. And because the form auto-submits, a human sees only
 * GitHub's normal "Create App" screen with no hint of what went wrong.
 */
export function manifestFormHtml(
  manifest: Record<string, unknown>,
  target: string,
): string {
  const embedded = JSON.stringify(manifest).replace(/'/g, "&apos;");
  return `<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<body style="font:16px system-ui;margin:3rem auto;max-width:34rem">
<h2>Creating the GitHub App “${manifest.name}”…</h2>
<p>Sending you to GitHub. The name is prefilled — just click <b>Create GitHub App</b>.</p>
<form id="f" action="${target}" method="post">
  <input type="hidden" name="manifest" value='${embedded}'>
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("f").submit()</script>`;
}
