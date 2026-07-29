// Invoke the deployed agent directly, without Slack — the fastest way to check a deployed change.
//
//   npm run invoke -- --prompt "What services run in this account?"
//   npm run invoke -- --keep --prompt "…"     # leave the microVM running for a follow-up
//
// This is NOT a second implementation: it runs the real image, the real model, the real tools. The only
// difference from a Slack mention is that no `slack` block is passed, so the agent has nowhere to post
// — it answers in its final message, which lands in the VM's logs.
//
// For prompt iteration prefer `npm run docker` (no deploy at all) or `npm run local` in runtime/. Use
// this to confirm the DEPLOYED image behaves.
//
// Requires temporary AWS credentials in the shell (run with `env -u AWS_PROFILE`).
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { REGION } from "../lib/config.js";
import {
  vmRequest,
  getMicrovm,
  runMicrovm,
  terminateMicrovm,
} from "../lambda/slack-events/microvm.js";
import { arg, rejectUnknownFlags, requireConfig } from "./cli.js";

rejectUnknownFlags(["prompt", "keep"]);

const prompt = arg("prompt");
if (!prompt) {
  console.error(
    'Usage: npm run invoke -- --prompt "your request" [--keep]',
  );
  process.exit(1);
}

const agent = requireConfig();
const keep = process.argv.includes("--keep");
const AGENT_PORT = 9000;

const ssm = new SSMClient({ region: REGION });
const param = await ssm.send(
  new GetParameterCommand({ Name: `${agent.ssmPrefix}/microvm-image-arn` }),
);
const imageArn = param.Parameter?.Value;
if (!imageArn) {
  throw new Error(
    `No image ARN at ${agent.ssmPrefix}/microvm-image-arn — run \`npm run image\` first.`,
  );
}

// The role the stack created. Read from the stack's output rather than reconstructing an ARN.
const roleParam = await ssm
  .send(new GetParameterCommand({ Name: `${agent.ssmPrefix}/microvm-role-arn` }))
  .catch(() => undefined);
const roleArn = roleParam?.Parameter?.Value;
if (!roleArn) {
  throw new Error(
    `No role ARN at ${agent.ssmPrefix}/microvm-role-arn — is the stack deployed?`,
  );
}

console.log(`▸ starting a microVM from ${imageArn}`);
const vm = await runMicrovm({
  imageArn,
  executionRoleArn: roleArn,
  // Short, unlike a real Slack thread's 8h: this is a one-shot test VM and the script terminates it
  // anyway. The idle policy is just a safety net if the script dies before it can.
  idleSeconds: 900,
});
console.log(`  ${vm.microvmId} (${vm.state})`);

// A fresh VM needs a moment before it accepts traffic.
for (let i = 0; i < 30; i++) {
  const now = await getMicrovm(vm.microvmId);
  if (now.state === "RUNNING") break;
  await new Promise((r) => setTimeout(r, 2000));
}

const res = await vmRequest(vm, AGENT_PORT, {
  method: "POST",
  path: "/invoke",
  body: JSON.stringify({ sessionId: "invoke", prompt, source: "local" }),
  timeoutMs: 30_000,
});
console.log(`▸ /invoke → ${res.status} ${res.body.slice(0, 200)}`);

console.log(
  `\nThe agent works detached; its answer goes to the VM's logs. Follow them with:\n\n` +
    `  aws logs tail /aws/lambda-microvms/${agent.imageName} --region ${REGION} --since 5m --follow\n`,
);

if (keep) {
  console.log(
    `Left ${vm.microvmId} RUNNING (--keep). It BILLS until you terminate it:\n` +
      `  aws lambda-microvms terminate-microvm --microvm-identifier ${vm.microvmId} --region ${REGION}`,
  );
} else {
  // A microVM bills until it's terminated, so a test script must not leak one. Wait long enough for a
  // short turn to finish and reach the logs first.
  console.log("▸ waiting 90s for the turn, then terminating the VM");
  await new Promise((r) => setTimeout(r, 90_000));
  await terminateMicrovm(vm.microvmId);
  console.log(`✓ terminated ${vm.microvmId} (use --keep to leave it running)`);
}
