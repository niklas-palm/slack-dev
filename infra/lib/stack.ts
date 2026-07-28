// The one stack: a Slack @mention becomes an agent working in its own Lambda MicroVM.
//
//   Slack @mention → POST /slack/events → Lambda (verify HMAC · channel allowlist · 👀)
//                                       → thread→VM lookup in DynamoDB
//                                       → run-microvm on a miss, else reuse the warm one
//                                       → POST /invoke inside the VM (Claude Opus 5)
//                                       → replies in the Slack thread · opens PRs · reads AWS
//
// DEPLOY IT INTO THE ACCOUNT IT LOOKS AFTER. The microVM execution role carries ReadOnlyAccess, so the
// agent can read that workload's own CloudWatch logs, metrics, ECS services, and tables directly.
//
// The microVM IMAGE is not a CDK resource — `npm run image` builds and registers it (infra/microvm/
// build.sh) and publishes its ARN to SSM, which this stack's Lambda reads. That split is deliberate:
// CloudFormation has no Lambda-MicroVM resource type, and the image is versioned independently of the
// infrastructure around it.
//
// NO EXPLICIT PHYSICAL RESOURCE NAMES. Every construct lets CloudFormation generate its name, so the
// same stack can be deployed many times in one account for different agents. The only per-agent
// identifiers are the ones an API demands: the stack name, the REST API name, and the SSM parameter
// paths — all derived from `agent.config.json` `name` (see lib/config.ts).
import { join } from "node:path";

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import {
  AuthorizationType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

import type { AgentConfig } from "./config.js";
import { REGION, REPO_ROOT } from "./config.js";

export interface SlackDevStackProps extends StackProps {
  agent: AgentConfig;
}

export class SlackDevStack extends Stack {
  constructor(scope: Construct, id: string, props: SlackDevStackProps) {
    super(scope, id, props);
    const { agent } = props;

    if (this.region !== REGION) {
      throw new Error(
        `This stack must deploy in ${REGION} (got ${this.region}) — this deployment is pinned there. Lambda MicroVMs exists only in eu-west-1 and us-east-1; changing region means changing the pinned constants, MODEL_ID included.`,
      );
    }

    // SSM paths for the secrets an operator provisions out of band (see setup.md). CDK only ever
    // references the PATHS, so no secret value lands in the CloudFormation template.
    const params = {
      slackSigningSecret: `${agent.ssmPrefix}/slack-signing-secret`,
      slackBotToken: `${agent.ssmPrefix}/slack-bot-token`,
      githubAppId: `${agent.ssmPrefix}/gh-app-id`,
      githubAppInstallId: `${agent.ssmPrefix}/gh-app-install-id`,
      githubAppPrivateKey: `${agent.ssmPrefix}/gh-app-private-key`,
      /** Written by `npm run image`, read by the ingress Lambda. */
      imageArn: `${agent.ssmPrefix}/microvm-image-arn`,
    };

    // --- Thread → microVM routing ------------------------------------------

    // Lambda MicroVMs have no session concept, no tags, and `list-microvms` can't filter — so unlike
    // AgentCore's runtimeSessionId, mapping a Slack thread to its VM is ours to keep. Small and hot:
    // one item per active thread, read once per mention.
    //
    // `expiresAt` (TTL) clears rows for VMs that have long since been reclaimed. It's a tidy-up, not
    // the correctness mechanism: the Lambda always re-checks the VM's real state before reusing it,
    // because a row can outlive its VM (idle-terminated, max duration reached, crashed).
    const sessions = new Table(this, "SessionTable", {
      partitionKey: { name: "threadKey", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      // The table holds routing pointers, never conversation content — losing it costs a thread its
      // warm VM, nothing more. So a destroyed stack shouldn't leave one behind.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- The microVM execution role ----------------------------------------

    // Passed to every microVM this agent runs (`run-microvm --execution-role-arn`), which is how the
    // agent gets credentials INSIDE the VM (via IMDSv2). This is the agent's actual permission
    // boundary — see README "Guardrails".
    const vmRole = new Role(this, "MicroVmRole", {
      // The Lambda-MicroVM service assumes this to give the VM credentials via IMDSv2.
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the ${agent.name} agent's microVMs: Bedrock + AWS read-only + its own secrets.`,
      // The point of deploying into the workload's own account: the agent can investigate it.
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess"),
      ],
    });
    vmRole.addToPrincipalPolicy(
      new PolicyStatement({
        // Model ARNs vary by cross-region inference profile, so `*` is the pragmatic scope here.
        //
        // `bedrock:*` rather than the four Converse actions: the agent is often asked ABOUT Bedrock in
        // the account it looks after (which models are enabled, why a throttle happened, what an agent
        // or knowledge base is configured as), and ReadOnlyAccess's Bedrock coverage doesn't extend to
        // invoking. Bedrock has no data of its own to leak — the account's data lives in the services
        // ReadOnlyAccess already governs — so the marginal risk is spend, which the MAX_TURNS cap and
        // the channel allowlist bound. Everything else the role can do stays read-only.
        actions: ["bedrock:*"],
        resources: ["*"],
      }),
    );
    // Write its own logs. NOT covered by ReadOnlyAccess — that grants logs:Describe*/Get*/List* but
    // not CreateLogStream or PutLogEvents (verified against the live managed policy). Without this the
    // agent's structured output is silently dropped, and every log line setup.md tells an operator to
    // grep for (`session_start`, `incomplete_turn`, `ALERT`) never exists — so a failure anywhere else
    // becomes undiagnosable.
    vmRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda-microvms/*`,
        ],
      }),
    );
    // This agent's own parameters, and the KMS grant to decrypt them. ReadOnlyAccess covers
    // `ssm:Get*` but not `kms:Decrypt`, which a SecureString read requires — today it works only
    // because the default `aws/ssm` key's policy allows the whole account via `kms:ViaService`, so
    // make the dependency explicit rather than relying on that.
    vmRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ],
        resources: [
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${agent.ssmPrefix}/*`,
        ],
      }),
    );
    vmRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
          },
        },
      }),
    );
    // …and an explicit DENY on every OTHER agent's parameters.
    //
    // This is load-bearing, not belt-and-braces. `ReadOnlyAccess` grants `ssm:Get*` on `*` (verified
    // against the live managed policy), and several agents share one account by design — so the Allow
    // above does NOT narrow anything, and without this Deny any prompt injection that got the agent
    // to call `get_parameters_by_path(Path="/slack-dev/", WithDecryption=True)` would hand over
    // every other agent's Slack token and GitHub App private key. Only an explicit Deny beats a
    // managed Allow. `notResources` keeps this agent's own prefix readable.
    vmRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ],
        notResources: [
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${agent.ssmPrefix}/*`,
        ],
      }),
    );

    // Published so `npm run invoke` (and any future caller) can start a VM the same way the ingress
    // does, without reconstructing an ARN that changes if the role is replaced.
    new StringParameter(this, "MicroVmRoleParam", {
      parameterName: `${agent.ssmPrefix}/microvm-role-arn`,
      stringValue: vmRole.roleArn,
      description: `Execution role for the ${agent.name} agent's microVMs.`,
    });

    // --- The Slack trigger -------------------------------------------------

    const slackFn = new NodejsFunction(this, "SlackEventsFn", {
      entry: join(REPO_ROOT, "infra", "lambda", "slack-events", "handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // Verify, react, route to a VM, ack. The real work happens in the VM, not here — but starting a
      // VM on a cold thread costs a few seconds, so this is longer than the pure-ack version was.
      //
      // 25s, under API Gateway REST's fixed 29s integration timeout: at 30s the gateway returned 504 to
      // Slack a second BEFORE the function's own deadline, so the handler's failure notice never ran.
      // The handler budgets its retries against getRemainingTimeInMillis(), so this value bounds them.
      timeout: Duration.seconds(25),
      // An explicit (unnamed) log group rather than the deprecated `logRetention` prop, which
      // provisions a custom resource to mutate a group Lambda implicitly owns.
      logGroup: new LogGroup(this, "SlackEventsLogs", {
        retention: RetentionDays.ONE_MONTH,
      }),
      // NodejsFunction externalizes @aws-sdk/* by default on the assumption the Lambda runtime ships
      // them — but the bundled SDK's contents aren't guaranteed, and a missing client fails at runtime
      // with "Cannot find module". Bundle everything: a few hundred KB, certain.
      bundling: { externalModules: [] },
      environment: {
        // Empty string = no restriction. The ingress drops a mention from anywhere else before the 👀.
        ALLOWED_CHANNELS: agent.allowedChannels.join(","),
        SESSION_TABLE: sessions.tableName,
        MICROVM_IMAGE_ARN_PARAM: params.imageArn,
        MICROVM_ROLE_ARN: vmRole.roleArn,
        MICROVM_IDLE_SECONDS: String(agent.idleSessionTimeout),
        SIGNING_SECRET_PARAM: params.slackSigningSecret,
        BOT_TOKEN_PARAM: params.slackBotToken,
      },
    });
    sessions.grantReadWriteData(slackFn);
    // Exactly the parameters the handler reads — not the whole prefix, which would also expose the
    // GitHub App private key to a function that has no use for it.
    slackFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          params.imageArn,
          params.slackSigningSecret,
          params.slackBotToken,
        ].map(
          (name) =>
            `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`,
        ),
      }),
    );
    slackFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
          },
        },
      }),
    );
    // Run and reach into microVMs.
    //
    // NOTE THE CASING: the IAM actions match the API operation names exactly — `Microvm` (lowercase
    // `vm`), NOT `MicroVm`. Wrong casing means the action simply doesn't exist, so the policy looks
    // fine and every run-microvm fails with AccessDenied.
    //
    // Not resource-scopable today (the service takes an image identifier, and a VM id doesn't exist
    // until it's created), so the scope is the action set: run, inspect, terminate, mint a token.
    slackFn.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "lambda:RunMicrovm",
          "lambda:GetMicrovm",
          "lambda:TerminateMicrovm",
          "lambda:CreateMicrovmAuthToken",
        ],
        resources: ["*"],
      }),
    );
    // `run-microvm` PASSES the ingress/egress network connectors, which is a DISTINCT permission from
    // RunMicrovm. Without it the launch fails with AccessDenied on lambda:PassNetworkConnector — and
    // only ever on a live launch, never at synth or deploy.
    slackFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["lambda:PassNetworkConnector"],
        resources: [
          `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
          `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
        ],
      }),
    );
    // `--execution-role-arn` is a PassRole: without it the Lambda can start a VM but not give it any
    // credentials, so the agent boots unable to read its own secrets or call Bedrock. Scoped to the one
    // role, so it can never hand a VM something more privileged.
    slackFn.addToRolePolicy(
      new PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [vmRole.roleArn],
      }),
    );

    // A public POST route. Authentication is the Slack HMAC the handler verifies before doing
    // anything — unsigned traffic is rejected 401 without ever reaching the agent.
    const api = new RestApi(this, "SlackEventsApi", {
      // RestApi defaults its physical name to the CONSTRUCT ID, so without this every agent's API
      // would be called "SlackEventsApi". Derive it from the agent instead — the one place we set a
      // name, and it's per-agent by construction.
      restApiName: `slack-dev-${agent.name}`,
      description: `Slack events webhook for the ${agent.name} agent`,
      deployOptions: { stageName: "prod" },
    });
    api.root
      .addResource("slack")
      .addResource("events")
      .addMethod("POST", new LambdaIntegration(slackFn), {
        authorizationType: AuthorizationType.NONE,
      });

    new CfnOutput(this, "SlackEventsUrl", {
      value: `${api.url}slack/events`,
      description:
        "Paste this into the Slack app's Event Subscriptions Request URL.",
    });
    new CfnOutput(this, "MicroVmRoleArn", {
      value: vmRole.roleArn,
      description: "The execution role every microVM for this agent assumes.",
    });
    new CfnOutput(this, "SsmPrefix", {
      value: agent.ssmPrefix,
      description: "Where this agent's secrets and its image ARN live.",
    });
  }
}
