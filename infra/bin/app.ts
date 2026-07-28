#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";

import { CiStack } from "../lib/ci-stack.js";
import { loadConfig, REGION } from "../lib/config.js";
import { SlackDevStack } from "../lib/stack.js";

const app = new App();
const agent = loadConfig();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

const stack = new SlackDevStack(app, agent.stackName, {
  stackName: agent.stackName,
  description: agent.description,
  env,
  agent,
});

// Cost allocation: every resource carries the agent it belongs to, since one account may host several.
Tags.of(stack).add("project", "slack-dev");
Tags.of(stack).add("agent", agent.name);

// The CI deploy identity — OPTIONAL and separate, only synthesized when `githubRepo` is set.
//
// Deployed once by hand (`npm run deploy:ci`), never by `npm run deploy`: it's the identity that
// performs deploys, so a deploy must not be able to widen its own permissions. It's also
// account-level rather than per-agent, so several agents in one account share it — hence the fixed
// stack name and the `existingOidcProviderArn` escape hatch (an account may hold only one provider
// per issuer).
if (agent.githubRepo) {
  const ci = new CiStack(app, "SlackDevCI", {
    stackName: "SlackDevCI",
    description: "GitHub Actions OIDC deploy role for slack-dev.",
    env,
    githubRepo: agent.githubRepo,
    existingOidcProviderArn: process.env.GITHUB_OIDC_PROVIDER_ARN,
  });
  Tags.of(ci).add("project", "slack-dev");
}
