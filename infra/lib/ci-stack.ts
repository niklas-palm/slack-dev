// The CI deploy identity: a GitHub OIDC provider + one IAM role GitHub Actions assumes to deploy.
//
// Keyless — there are NO long-lived AWS keys in the repo or in GitHub secrets. The only secret the
// workflow needs is the role's ARN, which isn't sensitive.
//
// OPTIONAL, and only useful if THIS clone is itself a git repo you push. Two ways people run this
// sample, and only the first wants CI:
//   1. The clone lives in its own repo and pushes to main deploy it. Set up the role below.
//   2. The clone sits beside the project it looks after (what the `create-slack-dev` skill does) and
//      an operator deploys from their laptop. Then skip this entirely — `npm run deploy` never
//      includes it, and nothing else depends on it.
//
// BOOTSTRAP ORDER (chicken and egg): this stack is what LETS GitHub deploy, so GitHub can't deploy it.
// Deploy it ONCE by hand with your own credentials:
//
//   env -u AWS_PROFILE npm run deploy:ci
//
// then put the printed ARN in the repo as the `AWS_DEPLOY_ROLE_ARN` variable. After that, pushes to
// main deploy everything else. It's deliberately a SEPARATE stack from the agent's, so `npm run deploy`
// never touches the identity that performs deploys.
//
// The role covers the two things a deploy does — `npm run image` (build + register the microVM image)
// and `npm run deploy` (the CDK stack) — and nothing else. Notably it CANNOT read any agent's secrets:
// the SSM grant is write-only on one parameter path.
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import {
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

export interface CiStackProps extends StackProps {
  /** `owner/repo` allowed to assume the deploy role. Only this repo's main branch. */
  githubRepo: string;
  /**
   * Reuse an existing provider instead of creating one. An account can hold only ONE provider per
   * issuer URL, so a second stack — or an account that already has GitHub OIDC set up — must pass
   * the existing ARN or the deploy fails with `EntityAlreadyExists`.
   */
  existingOidcProviderArn?: string;
}

export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const providerArn =
      props.existingOidcProviderArn ??
      new OpenIdConnectProvider(this, "GitHubOidc", {
        url: GITHUB_ISSUER,
        clientIds: ["sts.amazonaws.com"],
      }).openIdConnectProviderArn;

    // Trust ONLY pushes to this repo's main branch.
    //
    // `StringEquals` on the full `sub`, never `StringLike` with a wildcard: a wildcard in the repo
    // position ("repo:*") would let ANY GitHub repository on the internet assume this role, which is
    // the classic OIDC misconfiguration. Pull requests get a different `sub`
    // (`pull_request`), so a PR from a fork cannot deploy either.
    //
    // The `aud` condition is also required — without it the role trusts any audience the issuer signs.
    const role = new Role(this, "DeployRole", {
      assumedBy: new WebIdentityPrincipal(providerArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${props.githubRepo}:ref:refs/heads/main`,
        },
      }),
      description: `GitHub Actions deploys for ${props.githubRepo} (keyless, main only).`,
    });

    // 1. `npm run deploy` — CDK doesn't use these credentials directly. It ASSUMES the account's
    //    cdk-bootstrap roles (deploy / file-publishing / image-publishing / lookup), so this one
    //    grant is all CDK needs. Scoped to the default `hnb659fds` qualifier and this account.
    role.addToPolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-*`,
        ],
      }),
    );

    // 2. `npm run image` — the microVM image build, which does NOT go through CDK (CloudFormation has
    //    no Lambda-MicroVM resource type). Registering an image and reading its build state.
    //
    //    Note the casing: the IAM actions match the API operation names exactly — `Microvm`, lowercase
    //    `vm`. Wrong casing means the action doesn't exist, so the policy looks right and every call
    //    is denied. Not resource-scopable: an image ARN doesn't exist before the first create.
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          "lambda:CreateMicrovmImage",
          "lambda:UpdateMicrovmImage",
          "lambda:GetMicrovmImage",
          "lambda:ListMicrovmImages",
          "lambda:ListMicrovmImageBuilds",
        ],
        resources: ["*"],
      }),
    );

    // The build artifacts bucket: `npm run image` uploads the packaged runtime/ there, and creates the
    // bucket on first run. Scoped to this account's slack-dev bucket by name.
    const bucket = `arn:${this.partition}:s3:::slack-dev-microvm-${this.account}-${this.region}`;
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          "s3:CreateBucket",
          "s3:PutBucketPublicAccessBlock",
          "s3:GetBucketLocation",
          "s3:ListBucket",
          "s3:PutObject",
        ],
        resources: [bucket, `${bucket}/*`],
      }),
    );

    // The image-build role, which `npm run image` reconciles so the builder can read those artifacts.
    // Scoped to that ONE role name — this is a PassRole-adjacent grant, so it must never be `*`:
    // `iam:PutRolePolicy` on a wildcard is a privilege-escalation path to account admin.
    role.addToPolicy(
      new PolicyStatement({
        actions: ["iam:GetRole", "iam:CreateRole", "iam:PutRolePolicy"],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/SlackDevMicrovmBuildRole`,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/SlackDevMicrovmBuildRole`,
        ],
      }),
    );

    // Publishing the image ARN so the ingress can find it. WRITE ONLY, and only on that one suffix —
    // CI has no reason to read a bot token or a GitHub private key, and this makes that structural
    // rather than a matter of trust. `ssm:GetParameter` is deliberately absent.
    role.addToPolicy(
      new PolicyStatement({
        actions: ["ssm:PutParameter", "ssm:AddTagsToResource"],
        resources: [
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/slack-dev/*/microvm-image-arn`,
        ],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: role.roleArn,
      description:
        "Set this as the GitHub repository variable AWS_DEPLOY_ROLE_ARN (it is not a secret).",
    });
  }
}
