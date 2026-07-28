// The two app manifests, tested where they can actually be wrong.
//
// An earlier version of this had ~190 lines regexing the SETUP SCRIPTS' source text — asserting that
// `nameIsFree` appears, that one statement precedes another. Those break on a rename and never caught
// anything a single run of the script wouldn't. What's left is the two things that genuinely bite:
// an apostrophe breaking the HTML the manifest rides in, and the scripted manifest drifting from the
// committed yaml a human pastes by hand.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../lib/config.js";

/** The seven scopes the runtime's Slack calls need. */
const SCOPES = [
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "chat:write",
  "reactions:write",
  "files:read",
  "files:write",
];

describe("the GitHub App manifest", () => {
  // It rides in a single-quoted HTML attribute of an auto-submitting form, so an apostrophe in the
  // agent's description could close the attribute early and corrupt the JSON — and because the form
  // auto-submits, a human would only see GitHub's normal "Create App" screen.
  it("survives an apostrophe in the description", () => {
    const manifest = {
      name: "a",
      description: "It's the team's agent.",
      url: "https://x",
    };
    const embedded = JSON.stringify(manifest).replace(/'/g, "&apos;");

    expect(embedded).not.toMatch(/'/);
    expect(JSON.parse(embedded.replace(/&apos;/g, "'"))).toEqual(manifest);
  });

  // GitHub treats `hook_attributes` as a webhook declaration whose `url` is REQUIRED, so passing it
  // without one rejects the WHOLE manifest — with `"url" wasn't supplied`, which reads as if the
  // homepage were missing. Slack is our only trigger, so the object must be absent entirely.
  it("declares no webhook at all", () => {
    const source = readFileSync(
      join(REPO_ROOT, "infra", "scripts", "create-github-app.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/hook_attributes:\s*\{/);
  });
});

describe("the GitHub App's permissions", () => {
  // The agent's whole GitHub boundary is "propose, never land". These five lines are that boundary, and
  // a widened one wouldn't fail any other test — it would just quietly let an agent merge its own work.
  it("can author a workflow edit but cannot merge, administer, or run anything", () => {
    const source = readFileSync(
      join(REPO_ROOT, "infra", "scripts", "create-github-app.ts"),
      "utf8",
    );
    const block = source.slice(
      source.indexOf("default_permissions"),
      source.indexOf("default_events"),
    );

    // workflows:write is required — GitHub refuses an App push touching .github/workflows without it.
    for (const granted of [
      "contents",
      "pull_requests",
      "issues",
      "workflows",
    ]) {
      expect(block, `${granted} must be writable`).toMatch(
        new RegExp(`${granted}: "write"`),
      );
    }
    for (const readOnly of ["actions", "checks"]) {
      expect(block, `${readOnly} must stay read-only`).toMatch(
        new RegExp(`${readOnly}: "read"`),
      );
    }
    // Nothing that could merge a PR, administer the repo, or reach org-wide.
    for (const forbidden of [
      "administration",
      "members",
      "organization",
      "environments",
      "secrets",
    ]) {
      expect(block, `${forbidden} must not be requested`).not.toContain(
        forbidden,
      );
    }
    // Slack is the only trigger: an App with no events can't be woken by GitHub.
    expect(source).toMatch(/default_events: \[\] as string\[\]/);
  });
});

describe("the Slack app manifest", () => {
  // Two paths create the same app — the script (with the Request URL prefilled) and the committed yaml
  // a human pastes. If their scopes drift, whichever path you didn't use is quietly wrong.
  it("requests the same scopes as the yaml a human would paste", () => {
    const script = readFileSync(
      join(REPO_ROOT, "infra", "scripts", "create-slack-app.ts"),
      "utf8",
    );
    const yaml = parse(
      readFileSync(join(REPO_ROOT, "slack-app-manifest.yaml"), "utf8"),
    ) as {
      oauth_config: { scopes: { bot: string[] } };
      settings: Record<string, unknown>;
    };

    expect(yaml.oauth_config.scopes.bot.sort()).toEqual([...SCOPES].sort());
    for (const scope of SCOPES)
      expect(script, `the script must request ${scope}`).toContain(
        `"${scope}"`,
      );
    // The yaml deliberately omits event_subscriptions: Slack rejects a manifest declaring app_mention
    // without a Request URL, and that URL doesn't exist until the stack is deployed.
    expect(yaml.settings).not.toHaveProperty("event_subscriptions");
  });
});
