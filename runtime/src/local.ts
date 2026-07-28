// Run one turn locally, with no Slack and no deploy.
//
//   cd runtime && WORKSPACE_DIR=/tmp/agent npm run local -- "your request"
//
// This is the loop for iterating on PROMPT.md: real model, real tools, real workspace — only Slack is
// absent, so the agent answers in its final message instead of posting. Needs AWS credentials in the
// shell for Bedrock (`env -u AWS_PROFILE`) and nothing else; no stack, no secrets, no Slack app.
import { mkdirSync } from "node:fs";

import { buildAgent, runAgent } from "./agent.js";
import { MODEL_ID, WORKSPACE_DIR } from "./config.js";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error('Usage: npm run local -- "your request"');
  process.exit(1);
}

// The container's Dockerfile creates /workspace; locally the directory is whatever you point
// WORKSPACE_DIR at, so create it. Every tool spawns with `cwd: WORKSPACE_DIR` — if it doesn't exist,
// bash, git and gh all die with "spawn bash ENOENT", which reads as if bash were missing.
mkdirSync(WORKSPACE_DIR, { recursive: true });

console.error(`model=${MODEL_ID} workspace=${WORKSPACE_DIR}\n`);

// No `slackTurn`: the Slack tools report that this turn didn't come from Slack, and the prompt tells the
// agent to answer in its final message instead. Everything else is exactly what runs in production.
const answer = await runAgent(buildAgent("local"), prompt, "local");

console.log(`\n--- answer ---\n${answer.text || "(the agent produced no final text — see the tool calls above)"}`);
