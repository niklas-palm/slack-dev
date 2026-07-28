// The CI deploy identity. Two properties matter more than anything else here, and both are the kind
// that look fine in a review: who may assume the role, and what it can reach if someone does.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { CiStack } from "../lib/ci-stack.js";
import { REGION } from "../lib/config.js";

function synth(githubRepo = "acme/platform", existingOidcProviderArn?: string) {
  const stack = new CiStack(new App(), "SlackDevCI", {
    env: { account: "123456789012", region: REGION },
    githubRepo,
    ...(existingOidcProviderArn ? { existingOidcProviderArn } : {}),
  });
  return Template.fromStack(stack);
}

/** Every statement in every policy this stack creates, flattened. */
function statements(template: Template): Array<{
  Effect: string;
  Action: unknown;
  Resource: unknown;
}> {
  return Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) =>
      (
        p.Properties as {
          PolicyDocument: {
            Statement: Array<{ Effect: string; Action: unknown; Resource: unknown }>;
          };
        }
      ).PolicyDocument.Statement,
  );
}

describe("the deploy role's trust policy", () => {
  it("trusts ONLY this repo's main branch", () => {
    // Pick the role by its trust, not by position: the OIDC provider construct brings its own
    // Lambda-trusted role along, and asserting on [0] silently tested that one instead.
    const role = Object.values(synth().findResources("AWS::IAM::Role")).find((r) =>
      JSON.stringify(r.Properties?.AssumeRolePolicyDocument).includes(
        "token.actions.githubusercontent.com",
      ),
    );
    expect(role, "no web-identity role found").toBeDefined();
    const trust = JSON.stringify(role?.Properties?.AssumeRolePolicyDocument);

    expect(trust).toContain("repo:acme/platform:ref:refs/heads/main");
    expect(trust).toContain("sts.amazonaws.com");
    // The classic OIDC misconfiguration: a wildcard anywhere in `sub` lets any repository on GitHub
    // assume the role. StringLike is how you'd express one, so neither may appear.
    expect(trust).not.toContain("StringLike");
    expect(trust).not.toContain("*");
    // Without an `aud` condition the role trusts any audience the issuer signs.
    expect(trust).toContain("token.actions.githubusercontent.com:aud");
  });

  it("can reuse an account's existing OIDC provider", () => {
    // An account may hold only ONE provider per issuer URL, so a second agent — or an account that
    // already uses GitHub OIDC — must be able to point at the existing one instead of failing with
    // EntityAlreadyExists.
    const fresh = synth();
    fresh.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);

    const reused = synth(
      "acme/platform",
      "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
    );
    reused.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
  });
});

describe("what the deploy role can reach", () => {
  it("cannot READ any agent's secrets", () => {
    // CI publishes the image ARN and nothing else. A read grant here would put every agent's Slack
    // token and GitHub private key one compromised workflow away.
    const actions = statements(synth())
      .flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]))
      .filter((a): a is string => typeof a === "string");

    expect(actions).toContain("ssm:PutParameter");
    for (const forbidden of [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "kms:Decrypt",
    ]) {
      expect(actions, `CI must not be able to ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("writes only the image-arn parameter, not the whole prefix", () => {
    const put = statements(synth()).find((st) =>
      JSON.stringify(st.Action).includes("ssm:PutParameter"),
    );
    const resource = JSON.stringify(put?.Resource);
    expect(resource).toContain("microvm-image-arn");
    // `parameter/slack-dev/*` would cover slack-bot-token and gh-app-private-key.
    expect(resource).not.toMatch(/parameter\/slack-dev\/\*"/);
  });

  it("scopes its IAM grants to the one build role", () => {
    // iam:PutRolePolicy or iam:PassRole on a wildcard is a privilege-escalation path to account admin
    // — the role could grant itself anything. Both must name exactly one role.
    const iamStatements = statements(synth()).filter((st) =>
      /iam:(PutRolePolicy|CreateRole|PassRole)/.test(JSON.stringify(st.Action)),
    );
    expect(iamStatements.length).toBeGreaterThan(0);
    for (const st of iamStatements) {
      const resource = JSON.stringify(st.Resource);
      expect(resource).toContain("SlackDevMicrovmBuildRole");
      expect(resource).not.toContain('"*"');
    }
  });

  it("does not grant administrative or credential-bearing access", () => {
    const doc = JSON.stringify(statements(synth()));
    for (const forbidden of [
      "iam:CreateAccessKey",
      "iam:AttachRolePolicy",
      "iam:UpdateAssumeRolePolicy",
      "sts:GetFederationToken",
      "lambda:RunMicrovm",
    ]) {
      expect(doc, `CI must not be able to ${forbidden}`).not.toContain(forbidden);
    }
    // CDK itself works by assuming the bootstrap roles, which is the only broad grant it needs.
    expect(doc).toContain("cdk-hnb659fds");
  });
});
