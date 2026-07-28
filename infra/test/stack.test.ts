// Assertions on the synthesized template. Two things matter most:
//   1. No explicit physical resource names — the same stack must deploy many times per account.
//   2. No secret values in the template; only SSM parameter paths.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { loadConfig, REGION, REPO_ROOT } from "../lib/config.js";
import { SlackDevStack } from "../lib/stack.js";

function configRoot(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "slack-dev-cfg-"));
  writeFileSync(join(dir, "agent.config.json"), JSON.stringify(config));
  return dir;
}

const VALID = {
  name: "acme",
  displayName: "acme",
  description: "The acme agent.",
  githubRepo: "acme/platform",
};

function synth(overrides: Record<string, unknown> = {}) {
  const agent = loadConfig(configRoot({ ...VALID, ...overrides }));
  const app = new App();
  const stack = new SlackDevStack(app, agent.stackName, {
    stackName: agent.stackName,
    env: { account: "123456789012", region: REGION },
    agent,
  });
  return { agent, template: Template.fromStack(stack) };
}

describe("loadConfig", () => {
  it("derives every name from the agent slug", () => {
    const agent = loadConfig(configRoot(VALID));
    expect(agent.stackName).toBe("SlackDev-Acme");
    expect(agent.ssmPrefix).toBe("/slack-dev/acme");
    expect(agent.imageName).toBe("slack-dev-acme");
  });

  it("PascalCases the stack name so it reads properly in the console", () => {
    const agent = loadConfig(configRoot({ ...VALID, name: "my-ops-agent" }));
    expect(agent.stackName).toBe("SlackDev-MyOpsAgent");
    expect(agent.imageName).toBe("slack-dev-my-ops-agent");
  });

  it("rejects the placeholder name so a template is never deployed as-is", () => {
    expect(() => loadConfig(configRoot({ ...VALID, name: "demo" }))).toThrow(
      /placeholder/,
    );
  });

  it("rejects a slug the downstream APIs would refuse", () => {
    expect(() =>
      loadConfig(configRoot({ ...VALID, name: "Bad_Name" })),
    ).toThrow(/must match/);
    expect(() => loadConfig(configRoot({ ...VALID, name: "" }))).toThrow(
      /must match/,
    );
  });

  it("rejects the placeholder repository but allows none at all", () => {
    expect(() =>
      loadConfig(configRoot({ ...VALID, githubRepo: "OWNER/REPOSITORY" })),
    ).toThrow(/owner\/repo/);
    expect(
      loadConfig(configRoot({ ...VALID, githubRepo: "" })).githubRepo,
    ).toBe("");
  });
});

describe("the stack", () => {
  it("creates one session table, one Lambda, and one REST API", () => {
    const { template } = synth();
    // The microVM IMAGE is deliberately NOT here — CloudFormation has no resource type for it, so
    // `npm run image` registers it and publishes the ARN to SSM. See infra/microvm/build.sh.
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    expect(
      Object.keys(template.findResources("AWS::Lambda::Function")).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("tags every taggable resource with the project and the agent — cost allocation", () => {
    const { template } = synth({ name: "alpha" });
    // Applied once at the stack (infra/lib/stack.ts) and inherited, so a new resource is covered
    // without anyone remembering to tag it. Checked on the table and the log group specifically: they
    // carry cost and have CloudFormation-generated names, so a tag is the only way to attribute either.
    for (const type of ["AWS::DynamoDB::Table", "AWS::Logs::LogGroup"]) {
      for (const [id, resource] of Object.entries(
        template.findResources(type),
      )) {
        expect(
          resource.Properties?.Tags,
          `${type} ${id} must be tagged`,
        ).toEqual(
          expect.arrayContaining([
            { Key: "project", Value: "slack-dev" },
            { Key: "agent", Value: "alpha" },
          ]),
        );
      }
    }
  });

  it("leaves every physical resource name to CloudFormation — multi-deploy safety", () => {
    const { template } = synth();
    // Properties that pin a physical name. Any of these set to a constant would make a SECOND
    // deployment of this stack in the same account collide with "already exists".
    const forbidden: Array<[string, string]> = [
      ["AWS::IAM::Role", "RoleName"],
      ["AWS::Lambda::Function", "FunctionName"],
      ["AWS::Logs::LogGroup", "LogGroupName"],
      ["AWS::ECR::Repository", "RepositoryName"],
      ["AWS::SQS::Queue", "QueueName"],
      ["AWS::DynamoDB::Table", "TableName"],
      ["AWS::S3::Bucket", "BucketName"],
    ];
    for (const [type, property] of forbidden) {
      for (const [id, resource] of Object.entries(
        template.findResources(type),
      )) {
        expect(
          resource.Properties?.[property],
          `${type} ${id} must not set ${property}`,
        ).toBeUndefined();
      }
    }
  });

  it("scopes the few unavoidable names by agent, so two agents never collide", () => {
    // Three names ARE set, because the API requires them or CDK would otherwise default to the
    // construct id (identical across deployments). All three must carry the agent slug.
    const named = (name: string) => {
      const { template } = synth({ name });
      return {
        api: Object.values(
          template.findResources("AWS::ApiGateway::RestApi"),
        )[0]?.Properties?.Name,
        param: Object.values(template.findResources("AWS::SSM::Parameter"))[0]
          ?.Properties?.Name,
      };
    };
    const alpha = named("alpha");
    const beta = named("beta");
    // The table's name is CloudFormation-generated (undefined here), which is the point — only the two
    // that MUST be named are checked for the slug.
    for (const key of ["api", "param"] as const) {
      expect(alpha[key], `${key} must include the agent name`).toContain(
        "alpha",
      );
      expect(alpha[key]).not.toBe(beta[key]);
    }
  });

  it("namespaces the SSM parameter it creates by agent, so two agents don't overwrite each other", () => {
    const params = Object.values(
      synth({ name: "alpha" }).template.findResources("AWS::SSM::Parameter"),
    );
    expect(params).toHaveLength(1);
    expect(params[0]?.Properties?.Name).toBe(
      "/slack-dev/alpha/microvm-role-arn",
    );
  });

  it("passes only SSM parameter PATHS to the ingress, never a secret value", () => {
    const { template } = synth();
    const fn = Object.values(template.findResources("AWS::Lambda::Function")).find(
      (r) =>
        (r.Properties as { Environment?: { Variables?: Record<string, string> } })
          .Environment?.Variables?.SIGNING_SECRET_PARAM !== undefined,
    );
    const env = (
      fn?.Properties as { Environment: { Variables: Record<string, string> } }
    ).Environment.Variables;

    for (const key of ["SIGNING_SECRET_PARAM", "BOT_TOKEN_PARAM", "MICROVM_IMAGE_ARN_PARAM"]) {
      expect(env[key]).toMatch(/^\/slack-dev\/acme\//);
    }
    // The bare names would mean a real credential was baked into the template.
    for (const key of ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "GH_APP_PRIVATE_KEY"]) {
      expect(env[key]).toBeUndefined();
    }
    // The GitHub App's paths belong to the microVM image, not this Lambda — it has no use for them,
    // and handing it the private key's path would widen its reach for nothing.
    for (const key of ["GH_APP_ID_PARAM", "GH_APP_PRIVATE_KEY_PARAM"]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("bakes the agent's identity and secret PATHS into the microVM image", () => {
    // These reach the agent through the IMAGE (infra/microvm/build.sh --environment-variables), not the
    // stack — so this asserts the build script, which is the only place they're set. Paths only: the
    // runtime resolves each to a value at boot using the VM's own role.
    const build = readFileSync(join(REPO_ROOT, "infra", "microvm", "build.sh"), "utf8");
    for (const key of [
      "AGENT_NAME=",
      "SLACK_BOT_TOKEN_PARAM=",
      "GH_APP_ID_PARAM=",
      "GH_APP_INSTALL_ID_PARAM=",
      "GH_APP_PRIVATE_KEY_PARAM=",
    ]) {
      expect(build, `the image must carry ${key}`).toContain(key);
    }
    // Docker inside the VM is a headline capability; without this flag dockerd won't start at all.
    expect(build).toContain("--additional-os-capabilities ALL");
  });

  it("passes the channel allowlist to the ingress Lambda", () => {
    // A config value that never reaches the template is a silent security hole: the deploy succeeds,
    // the docs claim the agent is restricted, and every channel still works.
    const { template } = synth({ allowedChannels: ["C0AAAAAAA", "C0BBBBBBB"] });
    const envs = Object.values(
      template.findResources("AWS::Lambda::Function"),
    ).map(
      (r) =>
        (
          r.Properties as {
            Environment?: { Variables?: Record<string, string> };
          }
        ).Environment?.Variables,
    );
    const ingress = envs.find((v) => v?.ALLOWED_CHANNELS !== undefined);
    expect(ingress?.ALLOWED_CHANNELS).toBe("C0AAAAAAA,C0BBBBBBB");
  });

  it("suspends an idle microVM WELL BEFORE its 8h lifetime, or every thread bills the full window", () => {
    // The cost bug with no error message. A VM lives 8h; it stops BILLING when it suspends. If the idle
    // timeout equals the lifetime the VM can never suspend before it's terminated, so every Slack
    // thread bills a multi-GB VM for 8 hours — and nothing anywhere fails to tell you.
    const { template } = synth();
    const envs = Object.values(template.findResources("AWS::Lambda::Function")).map(
      (r) =>
        (r.Properties as { Environment?: { Variables?: Record<string, string> } })
          .Environment?.Variables,
    );
    const idle = Number(
      envs.find((v) => v?.MICROVM_IDLE_SECONDS !== undefined)?.MICROVM_IDLE_SECONDS,
    );
    expect(idle).toBeGreaterThanOrEqual(60); // the API's own minimum
    expect(idle, "idle must be well under the 8h ceiling").toBeLessThanOrEqual(3600);
  });

  it("keeps a thread's microVM warm for eight hours", () => {
    // The ingress passes this to run-microvm as the idle policy, so a follow-up later in the day
    // reaches the same VM with the conversation still in memory.
    // The 8h lifetime is a constant in microvm.ts (MAX_LIFETIME_SECONDS), not a stack input — it's the
    // service ceiling, so there's nothing per-agent to configure. Assert it where it lives.
    const client = readFileSync(
      join(REPO_ROOT, "infra", "lambda", "slack-events", "microvm.ts"),
      "utf8",
    );
    expect(client).toContain("MAX_LIFETIME_SECONDS = 28_800");
    expect(client).toContain("maximumDurationInSeconds: MAX_LIFETIME_SECONDS");
  });

  it("scopes the microVM role's SSM access to its own prefix", () => {
    const { template } = synth({ name: "alpha" });
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const ssmStatements = policies.flatMap((p) =>
      (
        p.Properties?.PolicyDocument?.Statement as Array<{
          Effect?: string;
          Action?: unknown;
          Resource?: unknown;
          NotResource?: unknown;
        }>
      ).filter((s) =>
        JSON.stringify(s.Action ?? "").includes("ssm:GetParameter"),
      ),
    );
    expect(ssmStatements.length).toBeGreaterThan(0);
    for (const statement of ssmStatements) {
      // Every SSM statement — Allow or Deny — must name this agent's prefix and nothing broader.
      const scope = JSON.stringify(statement.Resource ?? statement.NotResource);
      expect(scope).toContain("/slack-dev/alpha/");
    }
  });

  // The security property this stack depends on: several agents share an account, and ReadOnlyAccess
  // grants `ssm:Get*` on `*`. An Allow cannot narrow that, so without an explicit Deny any agent
  // could read every other agent's Slack token and GitHub App private key.
  it("DENIES the runtime access to other agents' parameters", () => {
    const { template } = synth({ name: "alpha" });
    const statements = Object.values(
      template.findResources("AWS::IAM::Policy"),
    ).flatMap(
      (p) =>
        p.Properties?.PolicyDocument?.Statement as Array<{
          Effect?: string;
          Action?: unknown;
          NotResource?: unknown;
        }>,
    );
    const deny = statements.find(
      (s) =>
        s.Effect === "Deny" &&
        JSON.stringify(s.Action ?? "").includes("ssm:GetParameter"),
    );

    expect(
      deny,
      "an explicit Deny on other agents' SSM parameters must exist",
    ).toBeDefined();
    // GetParametersByPath is the dangerous one — it's how you'd enumerate the whole namespace at once.
    expect(JSON.stringify(deny?.Action)).toContain("ssm:GetParametersByPath");
    expect(JSON.stringify(deny?.NotResource)).toContain("/slack-dev/alpha/");
  });

  it("grants kms:Decrypt only via SSM, since SecureString reads need it", () => {
    const { template } = synth();
    const statements = Object.values(
      template.findResources("AWS::IAM::Policy"),
    ).flatMap(
      (p) =>
        p.Properties?.PolicyDocument?.Statement as Array<{
          Action?: unknown;
          Condition?: unknown;
        }>,
    );
    const kms = statements.filter((s) =>
      JSON.stringify(s.Action ?? "").includes("kms:Decrypt"),
    );

    expect(kms.length).toBeGreaterThan(0);
    for (const statement of kms) {
      // Unconditioned kms:Decrypt on * would let the agent decrypt anything in the account.
      expect(JSON.stringify(statement.Condition)).toContain(
        "ssm.eu-west-1.amazonaws.com",
      );
    }
  });

  it("gives the microVM AWS read-only access so it can investigate its own account", () => {
    const { template } = synth();
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    const managed = roles.flatMap((r) =>
      JSON.stringify(r.Properties?.ManagedPolicyArns ?? []),
    );
    expect(managed.some((m) => m.includes("ReadOnlyAccess"))).toBe(true);
  });

  it("lets the microVM write its own logs", () => {
    // ReadOnlyAccess grants logs:Describe*/Get*/List* but NOT CreateLogStream/PutLogEvents, so without
    // an explicit grant the agent's structured output is dropped and every documented `grep` finds
    // nothing — which hides every other failure.
    const { template } = synth();
    const doc = JSON.stringify(
      Object.values(template.findResources("AWS::IAM::Policy")).map(
        (p) => p.Properties?.PolicyDocument,
      ),
    );
    expect(doc).toContain("logs:PutLogEvents");
    expect(doc).toContain("logs:CreateLogStream");
  });

  it("lets the microVM invoke Bedrock but never WRITE to the account", () => {
    // The agent needs Bedrock beyond ReadOnlyAccess (which doesn't cover invoking), and is often asked
    // about the account's own Bedrock setup. Everything else on THIS role must stay read-only: that's
    // what makes an injected instruction in a PR comment or CI log unable to touch a real resource. An
    // infra fix is a PR, never an apply.
    //
    // Scoped to the microVM role on purpose — the ingress Lambda legitimately writes to its own session
    // table and starts VMs, and lumping the two together would let a real widening here hide.
    const { template } = synth();
    const vmPolicy = Object.values(template.findResources("AWS::IAM::Policy")).find((p) =>
      JSON.stringify(p.Properties?.PolicyDocument ?? "").includes("bedrock:*"),
    );
    const statements = (
      vmPolicy?.Properties as {
        PolicyDocument: { Statement: Array<{ Effect: string; Action: unknown }> };
      }
    ).PolicyDocument.Statement;
    const allowed = statements
      .filter((st) => st.Effect === "Allow")
      .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter((a): a is string => typeof a === "string");

    expect(allowed).toContain("bedrock:*");
    const mutating = allowed.filter((a) =>
      // `logs:` is excluded deliberately — the agent writes its OWN log stream, scoped to
      // /aws/lambda-microvms/*, which is not access to the account's resources.
      /^(cloudformation|iam|ec2|s3|dynamodb|lambda|ecs|ecr):(Create|Delete|Put|Update|Modify|Attach|PassRole|Terminate|Run)/.test(
        a,
      ),
    );
    expect(mutating, "the microVM role must not be able to mutate anything").toEqual([]);
  });

  it("lets the ingress run microVMs, and pass ONLY the one role", () => {
    // Two grants that only fail on a live launch, never at synth: the IAM action names are
    // `Microvm` (lowercase vm) — wrong casing means the action doesn't exist and every run is
    // AccessDenied — and passing the network connectors is a permission distinct from RunMicrovm.
    const { template } = synth();
    const doc = JSON.stringify(
      Object.values(template.findResources("AWS::IAM::Policy")).map(
        (p) => p.Properties?.PolicyDocument,
      ),
    );
    expect(doc).toContain("lambda:RunMicrovm");
    expect(doc).toContain("lambda:CreateMicrovmAuthToken");
    expect(doc).toContain("lambda:PassNetworkConnector");
    // PassRole must name the one role, never "*" — else the ingress could hand a VM anything.
    const passRole = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap(
        (p) =>
          (p.Properties as {
            PolicyDocument: { Statement: Array<{ Action?: unknown; Resource?: unknown }> };
          }).PolicyDocument.Statement,
      )
      .filter((st) => JSON.stringify(st.Action ?? "").includes("iam:PassRole"));
    expect(passRole.length).toBe(1);
    expect(JSON.stringify(passRole[0]?.Resource)).not.toContain('"*"');
  });

  it("exposes the Slack events URL as an output, since Slack must be pointed at it by hand", () => {
    const outputs = synth().template.toJSON().Outputs as Record<
      string,
      { Value: unknown }
    >;
    expect(Object.keys(outputs)).toContain("SlackEventsUrl");
    expect(Object.keys(outputs)).toContain("MicroVmRoleArn");
  });

  it("refuses to deploy outside eu-west-1, the only MicroVM region", () => {
    const agent = loadConfig(configRoot(VALID));
    expect(
      () =>
        new SlackDevStack(new App(), agent.stackName, {
          env: { account: "123456789012", region: "us-east-1" },
          agent,
        }),
    ).toThrow(/eu-west-1/);
  });
});
