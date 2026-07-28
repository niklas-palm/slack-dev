// Register this agent's GitHub App via the App Manifest flow, then store its credentials in SSM.
//
//   npm run github-app            (add --org MY-ORG to create it under an organization)
//
// What this replaces: creating the App by hand through ~9 settings screens, then copying an App ID,
// downloading a .pem, and hunting for an Installation ID in a URL. GitHub's manifest flow hands all of
// that back programmatically, so the only thing left for a human is the two clicks GitHub REQUIRES —
// naming the App, and choosing which repository to install it on. Those are deliberate consent gates;
// there is no API to bypass them (verified against GitHub's OpenAPI description — the only creation
// endpoint is POST /app-manifests/{code}/conversions, and nothing can install an App on your behalf).
//
// The flow (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
//   1. We serve a local page that POSTs a manifest to github.com/settings/apps/new.
//   2. You name the App and click Create. GitHub redirects back to us with a temporary `code`.
//   3. We exchange the code for the App id + private key + slug (one hour to complete, per GitHub).
//   4. We write id and key to SSM, then open the install page and WAIT for you to install it —
//      polling GitHub with the App's own JWT until the installation appears, which is how we learn the
//      Installation ID without you reading it out of a URL.
import { createServer } from "node:http";
import { createSign } from "node:crypto";

import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { REGION } from "../lib/config.js";
import { arg, openBrowser, requireConfig } from "./cli.js";

const PORT = 8724; // arbitrary, only needs to be free for a minute
const REDIRECT = `http://localhost:${PORT}/callback`;

const agent = requireConfig();
const org = arg("org");
const ssm = new SSMClient({ region: REGION });

/**
 * Is this GitHub App name free? Names are unique across ALL of GitHub, so a plain one is often taken —
 * and GitHub only tells you at submit time, in the browser. There's no availability API, but an App's
 * public page 404s when the slug is unused. Undefined = the check couldn't run; don't block on it.
 */
async function nameIsFree(name: string): Promise<boolean | undefined> {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return false;
  try {
    const res = await fetch(`https://github.com/apps/${slug}`, { method: "HEAD", redirect: "manual" });
    return res.status === 404;
  } catch {
    return undefined;
  }
}

/**
 * The App's permissions, and the reason for each. Being code, this can't drift from what the agent
 * actually needs:
 *   contents      — clone the repo and push feature branches
 *   pull_requests — open and update PRs, and READ review comments (the common ask: "look at the
 *                   feedback on my PR and address it")
 *   issues        — comment on issues (GitHub models a PR as an issue)
 *   actions       — read CI status and failed workflow logs
 *   checks        — read check runs
 *   workflows     — edit files under .github/workflows. Needed because GitHub REFUSES a push that
 *                   touches a workflow file without it ("refusing to allow a GitHub App to create or
 *                   update workflow"), so "fix the CI workflow" fails at the push without it.
 *
 * The boundary is PROPOSE, NEVER LAND: nothing here can merge a PR, push to a protected branch,
 * administer the repo, or trigger/cancel a workflow run. Note what `workflows: write` does widen — a
 * merged workflow edit runs with the repo's secrets — which is precisely why the agent can only open a
 * PR for it and a human reviews the diff.
 *
 * `hook_attributes` is deliberately ABSENT rather than `{active: false}`. Slack is the only trigger, so
 * we want no webhook — and GitHub treats the object as a webhook declaration whose `url` is REQUIRED,
 * rejecting the whole manifest with `"url" wasn't supplied` if you pass it without one (that message is
 * about the hook's url, not the homepage — a genuinely confusing error). Omitting it leaves no webhook.
 */
function buildManifest(appName: string): Record<string, unknown> {
  return {
    name: appName,
    url: agent.githubRepo ? `https://github.com/${agent.githubRepo}` : "https://github.com",
    description: agent.description.slice(0, 200),
    public: false,
    redirect_url: REDIRECT,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      actions: "read",
      checks: "read",
      // See the note above: without this, any PR touching .github/workflows fails at `git push`.
      workflows: "write",
    },
    default_events: [] as string[],
  };
}

async function putSecret(name: string, value: string): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: `${agent.ssmPrefix}/${name}`,
      Value: value,
      Type: "SecureString",
      Overwrite: true,
    }),
  );
  console.log(`  ✓ ${agent.ssmPrefix}/${name}`);
}

/** Serve the auto-submitting form, and resolve with the `code` GitHub redirects back. */
function awaitManifestCode(manifest: Record<string, unknown>): Promise<string> {
  const target = org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          code
            ? `<h2>✓ App created</h2><p>Back to your terminal — it's finishing setup.</p>`
            : `<h2>No code returned</h2><p>Start over in the terminal.</p>`,
        );
        server.close();
        // The manifest is POSTed as a single form field literally named "manifest".
        code ? resolve(code) : reject(new Error("GitHub redirected without a code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<body style="font:16px system-ui;margin:3rem auto;max-width:34rem">
<h2>Creating the GitHub App “${manifest.name}”…</h2>
<p>Sending you to GitHub. The name is prefilled — just click <b>Create GitHub App</b>.</p>
<form id="f" action="${target}" method="post">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&apos;")}'>
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("f").submit()</script>`);
    });

    server.on("error", reject);
    server.listen(PORT, () => {
      // Say what is about to be created BEFORE opening the browser. The page auto-submits to GitHub, so
      // from the operator's side one keystroke away is a real App on their account — and an App can only
      // be deleted by hand, since GitHub has no API for it. Naming it here makes an accidental run
      // obvious while the tab is still closable.
      console.log(`\nAbout to register the GitHub App "${String(manifest.name)}" on your account.`);
      console.log(`Nothing is created until you click "Create GitHub App" — close the tab to abort.\n`);
      console.log(`Opening your browser. If it doesn't open, visit http://localhost:${PORT}\n`);
      openBrowser(`http://localhost:${PORT}`);
    });
    // An hour is GitHub's own limit on the code; no point waiting longer.
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for GitHub (the manifest code expires after an hour)"));
    }, 3_600_000).unref();
  });
}

/** An App JWT, signed with the private key we just received. Lets us query the App's own installations. */
function appJwt(appId: string, pem: string): string {
  const b64 = (b: Buffer): string => b.toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const signature = b64(createSign("RSA-SHA256").update(`${header}.${payload}`).sign(pem));
  return `${header}.${payload}.${signature}`;
}

async function githubJson(path: string, token: string, method = "GET"): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "slack-dev-setup" },
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Wait for the human to install the App, then read the Installation ID off the API.
 *
 * This is the step people misread out of a URL. Installing is a consent action GitHub gives us no way
 * to perform, but once done, `GET /app/installations` tells us the id — so we poll instead of asking
 * anyone to copy a number.
 */
async function awaitInstallation(appId: string, pem: string, slug: string): Promise<{ id: number; account: string }> {
  const installUrl = `https://github.com/apps/${slug}/installations/new`;
  console.log(`\nNow install it${agent.githubRepo ? ` on ${agent.githubRepo}` : ""}:`);
  console.log(`  ${installUrl}`);
  console.log(`  Choose "Only select repositories" and pick ${agent.githubRepo || "your repo"}.\n`);
  openBrowser(installUrl);
  process.stdout.write("Waiting for the installation… ");

  const deadline = Date.now() + 900_000; // 15 minutes is plenty for a click
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      // Re-sign each round: an App JWT is only valid ~10 minutes.
      const installs = (await githubJson("/app/installations", appJwt(appId, pem))) as Array<{
        id: number;
        account?: { login?: string };
      }>;
      if (installs.length > 0) {
        const first = installs[0]!;
        process.stdout.write("found.\n");
        return { id: first.id, account: first.account?.login ?? "unknown" };
      }
    } catch (e) {
      // Keep polling through a transient failure. This runs up to ~300 times over 15 minutes, so a
      // single 401 (clock skew), 5xx, or secondary rate-limit would otherwise abort AFTER the App was
      // created and its key stored — the dead end the re-run guard then refuses to fix.
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write(".");
  }

  process.stdout.write("\n");
  console.error(`✗ Timed out waiting for the installation.${lastError ? `\n  Last error: ${lastError}` : ""}`);
  console.error(`\n  The App exists and its credentials are stored; only the installation id is missing.`);
  console.error(`  Install it at ${installUrl}, then store the id from the resulting URL:`);
  console.error(`    env -u AWS_PROFILE aws ssm put-parameter --region ${REGION} --type SecureString --overwrite \\`);
  console.error(`      --name ${agent.ssmPrefix}/gh-app-install-id --value <ID>`);
  process.exit(1);
}

async function alreadyConfigured(): Promise<boolean> {
  try {
    await ssm.send(new GetParameterCommand({ Name: `${agent.ssmPrefix}/gh-app-id` }));
    return true;
  } catch {
    return false;
  }
}

// --- main ------------------------------------------------------------------

if (!agent.githubRepo) {
  console.error(`✗ Set "githubRepo" in agent.config.json to the "owner/repo" this agent works on.`);
  console.error(`  (An agent without GitHub access doesn't need an App — skip this step.)`);
  process.exit(1);
}

if (await alreadyConfigured()) {
  console.log(`${agent.ssmPrefix}/gh-app-id already exists — an App is configured for "${agent.name}".`);
  console.log(`Delete that parameter first if you really want to register a new one.`);
  process.exit(1);
}

// The App name is the bot's identity on every PR it opens, so we never silently substitute a variant
// when the configured one is taken — stop and let the human pick, via --app-name.
const appName = arg("app-name") ?? agent.displayName;
if ((await nameIsFree(appName)) === false) {
  console.error(`✗ The GitHub App name "${appName}" is already taken (names are unique across all of GitHub).`);
  console.error(`\n  Re-run with a name you want — it's display-only and needn't match agent.config.json:`);
  console.error(`    npm run github-app -- --app-name ${appName}-agent`);
  process.exit(1);
}

console.log(`Registering GitHub App "${appName}" for agent "${agent.name}" (repo ${agent.githubRepo})`);
console.log(`Credentials will be stored under ${agent.ssmPrefix}/ in ${REGION}.`);

const manifest = buildManifest(appName);
const code = await awaitManifestCode(manifest);
const created = (await (
  await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "slack-dev-setup" },
  })
).json()) as { id?: number; pem?: string; slug?: string; html_url?: string; message?: string };

if (!created.id || !created.pem || !created.slug) {
  console.error("✗ GitHub didn't return the App credentials.");
  console.error(`  ${created.message ?? JSON.stringify(created).slice(0, 200)}`);
  process.exit(1);
}

const appId = String(created.id);
console.log(`\n✓ Created App "${created.slug}" (id ${appId})`);
console.log(`  ${created.html_url}`);
console.log(`\nStoring credentials:`);
await putSecret("gh-app-id", appId);
await putSecret("gh-app-private-key", created.pem);

const installation = await awaitInstallation(appId, created.pem, created.slug);
console.log(`\n✓ Installed on ${installation.account} (installation ${installation.id})`);
await putSecret("gh-app-install-id", String(installation.id));

console.log(`\nGitHub is done — no App ID, private key, or Installation ID to copy by hand.`);
console.log(`Next: deploy (npm run deploy), then create the Slack app (npm run slack-app).`);
