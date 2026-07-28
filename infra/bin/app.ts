#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";

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
