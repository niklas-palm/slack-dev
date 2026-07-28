// Create this agent's Slack app via the App Manifest API, with the deployed Request URL and the
// app_mention subscription already wired up.
//
//   npm run slack-app
//
// What this replaces: pasting a manifest by hand, then going back into Event Subscriptions to paste the
// Request URL, wait for Slack's green check, and add app_mention. Because the manifest can carry
// `settings.event_subscriptions.request_url`, and the stack has already been deployed by the time we run,
// we can fill that in ourselves — so the whole of that step disappears.
//
// What still needs a human: clicking "Install to Workspace". A bot token only exists after a workspace
// grants the app access, and no API can consent on the workspace's behalf. So this script creates and
// configures the app, then prints the install link and asks for the one value it cannot obtain.
//
// AUTH: an app-configuration token, which is NOT app-specific — you generate one refresh token once at
// api.slack.com/apps and every future agent reuses it. Access tokens last 12 hours, so we store only the
// REFRESH token and mint a fresh access token per run (tooling.tokens.rotate also returns a new refresh
// token, which we write back — miss that and the stored one goes stale).
import { createInterface } from "node:readline/promises";

import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

import { REGION } from "../lib/config.js";
import { arg, openBrowser, requireConfig } from "./cli.js";

/** Shared across every agent, so it lives outside the per-agent prefix. */
const CONFIG_TOKEN_PARAM = "/slack-dev/_shared/slack-config-refresh-token";

const ssm = new SSMClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

async function ssmGet(name: string): Promise<string | undefined> {
  try {
    const r = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return r.Parameter?.Value;
  } catch {
    return undefined;
  }
}

async function ssmPut(name: string, value: string): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: "SecureString",
      Overwrite: true,
    }),
  );
}

async function slack(
  method: string,
  token: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** The Slack events URL this agent's deployed stack exposes. Without it there's nothing to subscribe. */
async function deployedEventsUrl(stackName: string): Promise<string> {
  try {
    const r = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    const url = (r.Stacks?.[0]?.Outputs ?? []).find(
      (o) => o.OutputKey === "SlackEventsUrl",
    )?.OutputValue;
    if (url) return url;
  } catch {
    // falls through to the message below
  }
  console.error(`✗ Couldn't read a SlackEventsUrl from stack "${stackName}".`);
  console.error(
    `\n  Deploy first — the Slack app needs a Request URL that exists:`,
  );
  console.error(`    env -u AWS_PROFILE npm run deploy`);
  process.exit(1);
}

/**
 * A valid access token, minted from the stored refresh token.
 *
 * Access tokens live 12 hours, so we never store one — we store the refresh token and rotate on every
 * run. Rotation ALSO issues a new refresh token, so we must persist that immediately; forgetting to
 * would leave the saved value stale and send you back to the UI.
 */
async function accessToken(): Promise<string> {
  const refresh = await ssmGet(CONFIG_TOKEN_PARAM);
  if (!refresh) {
    console.error(`✗ No Slack app-configuration token stored yet.\n`);
    console.error(
      `  This is a ONE-TIME setup, shared by every agent you ever create:`,
    );
    console.error(`    1. Open https://api.slack.com/apps`);
    console.error(
      `    2. Scroll below the app list to "Your App Configuration Tokens"`,
    );
    console.error(
      `    3. Generate Token → pick your workspace → copy the REFRESH token (prefixed "xoxe")`,
    );
    console.error(`    4. Store it:`);
    console.error(
      `       SLACK_CONFIG_REFRESH_TOKEN=<token> npm run slack-app`,
    );
    console.error(
      `       (or: npm run slack-app -- --refresh-token <token>)\n`,
    );
    console.error(
      `  (Slack has no API to issue this token; it must come from that page once.)`,
    );
    process.exit(1);
  }

  const r = await slack("tooling.tokens.rotate", "", {
    refresh_token: refresh,
  });
  if (!r.ok) {
    console.error(`✗ Could not refresh the Slack config token: ${r.error}`);
    if (r.error === "invalid_refresh_token") {
      console.error(
        `\n  The stored refresh token is stale or was revoked. Generate a new one:`,
      );
      console.error(
        `    https://api.slack.com/apps → Your App Configuration Tokens → Generate Token`,
      );
      console.error(`    SLACK_CONFIG_REFRESH_TOKEN=<token> npm run slack-app`);
    }
    process.exit(1);
  }
  // Persist the NEW refresh token before doing anything else — it replaces the one we just spent.
  if (typeof r.refresh_token === "string")
    await ssmPut(CONFIG_TOKEN_PARAM, r.refresh_token);
  return String(r.token);
}

/**
 * The manifest. Unlike the committed yaml (which a human pastes before the stack exists), this one can
 * declare event_subscriptions, because we already know the deployed URL — which is exactly what removes
 * the manual "enable Event Subscriptions" step.
 */
function manifest(name: string, description: string, requestUrl: string) {
  return {
    display_information: {
      name,
      description: description.slice(0, 140),
    },
    features: {
      bot_user: { display_name: name, always_online: false },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read", // receive the @mention that triggers the agent
          "channels:history", // read thread context in public channels
          "groups:history", // …and in private channels
          "chat:write", // post replies
          "reactions:write", // 👀 / 🟡 / ❓ / 🟢 / 🔴 status
          "files:read", // read attached files
          "files:write", // upload logs, diffs, screenshots
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: ["app_mention"],
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

// --- main ------------------------------------------------------------------

// Storing the shared refresh token is ACCOUNT-level, not agent-level, so handle it before touching
// agent.config.json — otherwise the one-time setup is blocked by a placeholder config in a fresh clone,
// which is exactly when you'd be doing it.
// Accept the token from the environment as well as `--refresh-token`. A CLI argument lands in shell
// history — and if an AI agent is driving the setup, in the transcript too. `SLACK_CONFIG_REFRESH_TOKEN=…`
// (or a piped stdin) lets the human keep the secret in their own shell while an agent runs everything
// else. Same reasoning as the bot token below.
const provided =
  arg("refresh-token") ?? process.env.SLACK_CONFIG_REFRESH_TOKEN?.trim();
if (provided) {
  if (!provided.startsWith("xoxe-")) {
    console.error(
      `✗ That doesn't look like a refresh token (expected it to start "xoxe-").`,
    );
    console.error(
      `  On api.slack.com/apps, copy the REFRESH token, not the access token.`,
    );
    process.exit(1);
  }
  await ssmPut(CONFIG_TOKEN_PARAM, provided);
  console.log(
    `✓ Stored the shared Slack config refresh token at ${CONFIG_TOKEN_PARAM}.`,
  );
  console.log(`  Every agent reuses it — you shouldn't need to do this again.`);
  console.log(`\nNow run: npm run slack-app`);
  process.exit(0);
}

const agent = requireConfig();
const appName = arg("app-name") ?? agent.displayName;

if (await ssmGet(`${agent.ssmPrefix}/slack-bot-token`)) {
  console.log(
    `${agent.ssmPrefix}/slack-bot-token already exists — Slack is configured for "${agent.name}".`,
  );
  console.log(`Delete that parameter first if you want to start over.`);
  process.exit(1);
}

const requestUrl = await deployedEventsUrl(agent.stackName);
console.log(`Creating Slack app "${appName}" for agent "${agent.name}"`);
console.log(`  Request URL: ${requestUrl}`);

const token = await accessToken();
const spec = manifest(appName, agent.description, requestUrl);

// Validate before creating. Slack reports per-field errors here, and a failed create would otherwise
// leave you guessing whether the problem was the manifest or the Request URL.
const validated = await slack("apps.manifest.validate", token, {
  manifest: spec,
});
if (!validated.ok) {
  console.error(`\n✗ Slack rejected the manifest: ${validated.error}`);
  for (const e of (validated.errors ?? []) as Array<{
    message?: string;
    pointer?: string;
  }>) {
    console.error(`    ${e.pointer ?? ""} ${e.message ?? ""}`.trim());
  }
  console.error(
    `\n  Slack POSTs a challenge to the Request URL to verify it. Check the stack is reachable:`,
  );
  console.error(
    `    curl -i -X POST "${requestUrl}" -d '{}'   → expect 401 (the signature check working)`,
  );
  process.exit(1);
}

const created = await slack("apps.manifest.create", token, { manifest: spec });

if (!created.ok) {
  console.error(`\n✗ Slack rejected the app: ${created.error}`);
  // Slack returns per-field detail for a bad manifest; surface it rather than just the code.
  const errors = (created.errors ?? []) as Array<{
    message?: string;
    pointer?: string;
  }>;
  for (const e of errors)
    console.error(`    ${e.pointer ?? ""} ${e.message ?? ""}`.trim());
  if (
    created.error === "invalid_manifest" &&
    errors.some((e) => /url/i.test(e.message ?? ""))
  ) {
    console.error(
      `\n  Slack verifies the Request URL by POSTing a challenge to it. Check the stack is`,
    );
    console.error(
      `  deployed and reachable: curl -i -X POST "${requestUrl}" -d '{}'  → expect 401`,
    );
  }
  process.exit(1);
}

const appId = String(created.app_id);
const credentials = (created.credentials ?? {}) as Record<string, string>;
console.log(
  `\n✓ Created Slack app ${appId} with app_mention already subscribed to the deployed URL.`,
);

// The signing secret comes straight back from the API — one of the two values you used to copy by hand.
if (credentials.signing_secret) {
  await ssmPut(
    `${agent.ssmPrefix}/slack-signing-secret`,
    credentials.signing_secret,
  );
  console.log(
    `  ✓ ${agent.ssmPrefix}/slack-signing-secret  (from the API, not copied)`,
  );
}

// The bot token is the one thing an API cannot produce: it only exists once a workspace installs the app.
const installUrl = `https://api.slack.com/apps/${appId}/install-on-team`;
console.log(
  `\nOne click left — installing is a workspace consent step with no API:`,
);
console.log(`  1. ${installUrl}`);
console.log(`  2. "Install to Workspace" → Allow`);
console.log(`  3. Copy the Bot User OAuth Token (xoxb-…)\n`);
openBrowser(installUrl);

// Ask until we get something plausible. Exiting here used to be a trap: the app already exists, but
// the re-run guard keys on `slack-bot-token` — which is written below — so re-running would create a
// SECOND Slack app and leave the first orphaned.
// SLACK_BOT_TOKEN in the environment skips the prompt entirely, so the human can supply it from their
// own shell without it passing through anyone else's hands (or an AI agent's transcript).
let botToken = process.env.SLACK_BOT_TOKEN?.trim() ?? "";
if (botToken && !botToken.startsWith("xoxb-")) {
  console.error(
    `✗ SLACK_BOT_TOKEN is set but doesn't look like a bot token (expected "xoxb-…").`,
  );
  process.exit(1);
}
if (botToken) {
  console.log(`  Using the bot token from SLACK_BOT_TOKEN.`);
} else if (!process.stdin.isTTY) {
  // No TTY means nobody can answer the prompt — a script, a CI job, or an AI agent running the command.
  // Failing here with instructions beats hanging forever on a question no one will see.
  console.error(
    `\n✗ No TTY, so the token can't be typed — and the Slack app "${appName}" (${appId}) now EXISTS.`,
  );
  console.error(
    `  Don't re-run this script; it would create a second app. Instead, in your own terminal:`,
  );
  console.error(
    `    export SLACK_BOT_TOKEN='<the xoxb- token>'   # from https://api.slack.com/apps/${appId}/oauth`,
  );
  console.error(`    env -u AWS_PROFILE npm run slack-app`);
  console.error(
    `  (or store it directly with the put-parameter command below)`,
  );
  console.error(
    `    env -u AWS_PROFILE aws ssm put-parameter --region ${REGION} --type SecureString --overwrite \\`,
  );
  console.error(
    `      --name ${agent.ssmPrefix}/slack-bot-token --value xoxb-…`,
  );
  process.exit(1);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (let attempt = 0; attempt < 3 && !botToken; attempt++) {
    const entered = (
      await rl.question("Paste the Bot User OAuth Token (xoxb-…): ")
    ).trim();
    if (entered.startsWith("xoxb-")) botToken = entered;
    else
      console.error(
        `  That doesn't look like a bot token (expected "xoxb-…"). ${attempt < 2 ? "Try again." : ""}`,
      );
  }
  rl.close();
}

if (!botToken) {
  console.error(
    `\n✗ No bot token stored — but the Slack app "${appName}" (${appId}) DOES exist.`,
  );
  console.error(
    `  Don't re-run this script; it would create a second app. Store the token directly:`,
  );
  console.error(
    `    env -u AWS_PROFILE aws ssm put-parameter --region ${REGION} --type SecureString --overwrite \\`,
  );
  console.error(
    `      --name ${agent.ssmPrefix}/slack-bot-token --value <xoxb-…>`,
  );
  console.error(`  Find it at https://api.slack.com/apps/${appId}/oauth`);
  process.exit(1);
}
await ssmPut(`${agent.ssmPrefix}/slack-bot-token`, botToken);
console.log(`  ✓ ${agent.ssmPrefix}/slack-bot-token`);

console.log(
  `\nSlack is connected. Invite the bot to a channel and mention it:`,
);
console.log(`  /invite @${appName}`);
console.log(`  @${appName} hello`);
