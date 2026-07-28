#!/usr/bin/env node
import { App } from "aws-cdk-lib";

import { loadConfig, REGION } from "../lib/config.js";
import { SlackDevStack } from "../lib/stack.js";

const app = new App();
const agent = loadConfig();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

// Tags (project, agent) are applied inside the stack, so they hold however it is instantiated.
new SlackDevStack(app, agent.stackName, {
  stackName: agent.stackName,
  description: agent.description,
  env,
  agent,
});
