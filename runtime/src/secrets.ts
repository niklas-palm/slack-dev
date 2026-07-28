// Load SSM SecureString secrets into process.env at startup — generic and opt-in.
//
// Convention: for any env var `FOO_PARAM=/some/ssm/path`, read that SSM SecureString (decrypted)
// and set `process.env.FOO`. CDK injects only the param NAMES, so no secret value ever lands in
// the CloudFormation template.
//
// Why env-projection rather than a getSecret() the tools call: the github skill drives `git`/`gh`
// through `run_bash`, and a child process inherits process.env — so `$GH_APP_PRIVATE_KEY` has to be
// in the environment for that bash to mint a token. The Slack tools read `SLACK_BOT_TOKEN`
// in-process and wouldn't need this, but it comes along for free. Locally, just `export …` — an
// already-set var is left alone.
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { REGION } from "./config.js";

const ssm = new SSMClient({ region: REGION });

/**
 * Load every `FOO_PARAM` into `FOO`. Returns the targets that did NOT resolve, so a caller can tell
 * "read fine" from "SSM was down" — a per-parameter failure is swallowed here on purpose (a missing
 * GitHub key shouldn't stop the VM booting), which otherwise makes the two indistinguishable.
 */
export async function loadSecretsFromSsm(): Promise<string[]> {
  const failed: string[] = [];
  const paramVars = Object.keys(process.env).filter((k) => k.endsWith("_PARAM"));
  await Promise.all(
    paramVars.map(async (paramVar) => {
      const target = paramVar.slice(0, -"_PARAM".length); // FOO_PARAM → FOO
      if (process.env[target]) return; // already provided (local dev)
      const name = process.env[paramVar];
      if (!name) return;
      try {
        const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
        const value = r.Parameter?.Value;
        if (value) process.env[target] = value;
        else {
          failed.push(target);
          console.error(`[secrets] SSM parameter ${name} (for ${target}) is empty`);
        }
      } catch (e) {
        // Don't crash the runtime: let the failure surface where the credential is used (a Slack tool
        // returning `not_authed`, or the github skill's token mint returning 401), which is more
        // debuggable than a container that won't boot. SLACK_BOT_TOKEN is the exception — server.ts
        // checks it at boot, because without it the agent can't report any failure at all.
        failed.push(target);
        console.error(`[secrets] failed to load ${target} from ${name}:`, e instanceof Error ? e.message : e);
      }
    }),
  );
  return failed;
}
