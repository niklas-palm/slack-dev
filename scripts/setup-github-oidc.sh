#!/usr/bin/env bash
# Create the IAM role GitHub Actions assumes to deploy THIS repo — keyless, via GitHub OIDC.
#
#   npm run setup:oidc
#
# You need this ONLY if this clone deploys itself from GitHub Actions, which is how the template repo
# tests itself. A spoke project — an agent you stood up for some other repository — deploys from a
# laptop with `npm run image` + `npm run deploy`, and needs none of this. That's why it's a script and
# not part of the CDK app: it's a one-off for one repo, not infrastructure every agent carries.
#
# Idempotent: re-run it after changing the repo or the permissions and it reconciles.
#
# It prints the role ARN. Set that as the repo VARIABLE `AWS_DEPLOY_ROLE_ARN`
# (Settings → Secrets and variables → Actions → Variables). It's not a secret — nothing can assume the
# role without a signed OIDC token from this repo's main branch.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REGION=eu-west-1
ISSUER=token.actions.githubusercontent.com

# node, not python3 — node is already required and macOS no longer ships python3.
REPO="${1:-$(node -e 'try{process.stdout.write(String(require(process.argv[1]).githubRepo??""))}catch{}' "$HERE/agent.config.json")}"
if [ -z "$REPO" ] || [ "$REPO" = "OWNER/REPOSITORY" ]; then
  echo "✗ Need a repo. Set \"githubRepo\" in agent.config.json, or pass it: npm run setup:oidc -- owner/repo" >&2
  exit 1
fi

ACCT="$(aws sts get-caller-identity --query Account --output text)"
ROLE="SlackDevGithubDeploy"
PROVIDER_ARN="arn:aws:iam::${ACCT}:oidc-provider/${ISSUER}"

# The OIDC provider is ACCOUNT-level and there can be only ONE per issuer, so an account that already
# uses GitHub Actions anywhere has it. Creating a second fails with EntityAlreadyExists — so reuse.
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  echo "▸ reusing the account's existing GitHub OIDC provider"
else
  echo "▸ creating the GitHub OIDC provider"
  # No --thumbprint-list: IAM now validates GitHub's certificate against its own trust store, and a
  # pinned thumbprint is a rotation hazard.
  aws iam create-open-id-connect-provider \
    --url "https://${ISSUER}" --client-id-list sts.amazonaws.com >/dev/null
fi

# The `sub` claim's exact format is NOT always `repo:owner/name:ref:...`. Some GitHub deployments embed
# numeric ids — `repo:owner@<owner_id>/name@<repo_id>:ref:...` — and a mismatch fails with the
# unhelpful "Not authorized to perform sts:AssumeRoleWithWebIdentity", which reads like a permissions
# problem rather than a string mismatch. So ASK GitHub for the ids and build the subject from them; if
# `gh` isn't available, fall back to the plain form.
#
# To see what a token actually carries, add this to a workflow job with `id-token: write`:
#   - run: |
#       curl -sH "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
#         "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" \
#         | python3 -c 'import json,sys,base64; t=json.load(sys.stdin)["value"].split(".")[1]; print(base64.urlsafe_b64decode(t+"=="))'
# Check the EXIT CODE, and sanity-check the shape. On a 404 `gh` still prints its error JSON to stdout,
# so `|| true` plus a non-empty test happily produced
# `repo:{"message":"Not Found",...}:ref:refs/heads/main` — a trust policy no token can ever match, which
# surfaces much later as the same misleading "Not authorized" this comment warns about.
IDS=""
if OUT="$(gh api "repos/${REPO}" --jq '"\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"' 2>/dev/null)"; then
  case "$OUT" in *@[0-9]*/*@[0-9]*) IDS="$OUT" ;; esac
fi
if [ -n "$IDS" ]; then
  SUBJECT="repo:${IDS}:ref:refs/heads/main"
  echo "▸ subject (from the GitHub API): ${SUBJECT}"
else
  SUBJECT="repo:${REPO}:ref:refs/heads/main"
  echo "▸ subject (gh unavailable, using the plain form): ${SUBJECT}"
fi

# Trust ONLY pushes to this repo's main branch.
#
# StringEquals on the full `sub`, never StringLike with a wildcard: a wildcard in the repo position
# would let ANY repository on GitHub assume this role — the classic OIDC misconfiguration. A pull
# request carries a different `sub`, so a PR (including from a fork) cannot deploy either. The `aud`
# condition is required too, or the role trusts any audience the issuer signs.
TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${PROVIDER_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${ISSUER}:aud": "sts.amazonaws.com",
        "${ISSUER}:sub": "${SUBJECT}"
      }
    }
  }]
}
JSON
)

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "▸ updating ${ROLE}'s trust policy (repo: ${REPO}, main only)"
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST" >/dev/null
else
  echo "▸ creating ${ROLE} (repo: ${REPO}, main only)"
  aws iam create-role --role-name "$ROLE" \
    --description "GitHub Actions deploys for ${REPO} (keyless OIDC, main branch only)." \
    --assume-role-policy-document "$TRUST" >/dev/null
fi

# What a deploy needs, and nothing more.
#
# Note what's ABSENT: ssm:GetParameter and kms:Decrypt. CI publishes the image ARN but cannot READ any
# agent's secrets, so a compromised workflow can redeploy the agent — it cannot exfiltrate a Slack
# token or a GitHub private key. The iam: grants name ONE role: on a wildcard, iam:PutRolePolicy is a
# privilege-escalation path to account admin.
#
# CDK itself doesn't use these credentials directly — it assumes the account's bootstrap roles, which is
# why sts:AssumeRole on cdk-hnb659fds-* is the only broad grant here.
#
# lambda:PassNetworkConnector is needed at IMAGE-BUILD time, not just at run-microvm time:
# CreateMicrovmImage validates the connectors the image will run with. It's a permission distinct from
# CreateMicrovmImage, and it only ever fails on a real call — never at synth or in a dry run.
#
# The logs grant is what lets `npm run image` put a 14-day retention on the agent's log group (see
# infra/microvm/build.sh — an implicitly created group keeps its data for ever). Create + set retention
# only: no read verb, so CI still cannot see what an agent logged. NOTE for an existing pipeline: re-run
# `npm run setup:oidc` after pulling this, or the image step fails with AccessDenied.
POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "CdkBootstrapRoles", "Effect": "Allow", "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::${ACCT}:role/cdk-hnb659fds-*-${ACCT}-*" },
    { "Sid": "MicrovmImage", "Effect": "Allow",
      "Action": ["lambda:CreateMicrovmImage", "lambda:UpdateMicrovmImage", "lambda:GetMicrovmImage",
                 "lambda:ListMicrovmImages", "lambda:ListMicrovmImageBuilds"],
      "Resource": "*" },
    { "Sid": "PassNetworkConnectors", "Effect": "Allow",
      "Action": "lambda:PassNetworkConnector",
      "Resource": ["arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS",
                   "arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"] },
    { "Sid": "BuildArtifacts", "Effect": "Allow",
      "Action": ["s3:CreateBucket", "s3:PutBucketPublicAccessBlock", "s3:GetBucketLocation",
                 "s3:ListBucket", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::slack-dev-microvm-${ACCT}-${REGION}",
                   "arn:aws:s3:::slack-dev-microvm-${ACCT}-${REGION}/*"] },
    { "Sid": "ImageBuildRoleOnly", "Effect": "Allow",
      "Action": ["iam:GetRole", "iam:CreateRole", "iam:PutRolePolicy", "iam:PassRole"],
      "Resource": "arn:aws:iam::${ACCT}:role/SlackDevMicrovmBuildRole" },
    { "Sid": "PublishImageArnOnly", "Effect": "Allow",
      "Action": ["ssm:PutParameter", "ssm:AddTagsToResource"],
      "Resource": "arn:aws:ssm:${REGION}:${ACCT}:parameter/slack-dev/*/microvm-image-arn" },
    { "Sid": "AgentLogRetention", "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:PutRetentionPolicy"],
      "Resource": ["arn:aws:logs:${REGION}:${ACCT}:log-group:/aws/lambda-microvms/slack-dev-*",
                   "arn:aws:logs:${REGION}:${ACCT}:log-group:/aws/lambda-microvms/slack-dev-*:*"] }
  ]
}
JSON
)
aws iam put-role-policy --role-name "$ROLE" --policy-name deploy --policy-document "$POLICY" >/dev/null

ROLE_ARN="arn:aws:iam::${ACCT}:role/${ROLE}"
cat <<EOF

✓ ${ROLE_ARN}

Next, in https://github.com/${REPO}/settings/variables/actions
  → New repository variable, name AWS_DEPLOY_ROLE_ARN, value the ARN above.

Then protect `main` — with this workflow, push access to main IS deploy access.
setup.md's "Deploying from GitHub Actions" section has the exact command (it needs a JSON body; gh's
-f/-F flags silently do nothing for that endpoint).
EOF
