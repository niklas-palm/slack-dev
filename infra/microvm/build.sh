#!/usr/bin/env bash
# Build and register the agent's Lambda MicroVM image, then publish its ARN to SSM.
#
#   npm run image
#
# Run this after editing anything under runtime/ — including PROMPT.md, which is the usual reason. It's
# independent of `npm run deploy`: the ingress Lambda reads the image ARN from SSM at call time, so a
# rebuilt image is picked up with no stack change.
#
# Why a script and not CDK: CloudFormation has no Lambda-MicroVM resource type. The image is also
# versioned independently of the infrastructure around it, which suits a per-agent image that changes
# whenever its prompt does.
#
# Needs: AWS credentials in the shell (`env -u AWS_PROFILE`), and `agent.config.json`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REGION=eu-west-1 # MicroVMs exists only here and in us-east-1; keep in sync with infra/lib/config.ts

# Read the agent's name from its config, the same source CDK uses.
# Read config with NODE, not python3: node is already a hard prerequisite, and python3 isn't bundled with
# macOS any more. The old `python3 … || true` also SWALLOWED a missing interpreter, so the script then
# reported "set a real name in agent.config.json" about a config that was perfectly fine.
cfg() { node -e 'const c=require(process.argv[1]);process.stdout.write(String(c[process.argv[2]]??""))' "$ROOT/agent.config.json" "$1"; }
NAME="$(cfg name)"
DISPLAY_NAME="$(cfg displayName)"
GITHUB_REPO="$(cfg githubRepo)"
if [ -z "$NAME" ] || [ "$NAME" = "demo" ]; then
  echo "✗ Set a real \"name\" in agent.config.json first (copy agent.config.example.json). See setup.md step 2." >&2
  exit 1
fi

ACCT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE_NAME="slack-dev-${NAME}"
IMAGE_ARN="arn:aws:lambda:${REGION}:${ACCT}:microvm-image:${IMAGE_NAME}"
BUCKET="slack-dev-microvm-${ACCT}-${REGION}"
BUILD_ROLE="arn:aws:iam::${ACCT}:role/SlackDevMicrovmBuildRole"
SSM_PARAM="/slack-dev/${NAME}/microvm-image-arn"

# The artifacts bucket and the build role are account-level, shared by every agent — create once.
if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "▸ creating the artifacts bucket $BUCKET"
  aws s3 mb "s3://${BUCKET}" --region "$REGION" >/dev/null
  # The zip is only build input, never anything's source of truth — but it's still ours, so block public
  # access and let the account default handle encryption.
  aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
fi

if ! aws iam get-role --role-name SlackDevMicrovmBuildRole >/dev/null 2>&1; then
  echo "▸ creating the image-build role"
  aws iam create-role --role-name SlackDevMicrovmBuildRole \
    --description "Lets the Lambda MicroVM image builder read slack-dev build artifacts from S3." \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":["sts:AssumeRole","sts:TagSession"]}]}' >/dev/null
fi
# Reconciled every run (idempotent), so a bucket added later is covered.
aws iam put-role-policy --role-name SlackDevMicrovmBuildRole --policy-name read-artifacts \
  --policy-document "$(printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion"],"Resource":"arn:aws:s3:::%s/*"},{"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"}]}' "$BUCKET")" >/dev/null
# The logs grant is not optional: without it Lambda cannot write the build log, and the failure message
# above tells the operator to go read a log that was never created.

# The build context is runtime/ — the Dockerfile plus everything it COPYs. .dockerignore keeps tests and
# scratch files out, so an unrelated edit doesn't produce a new image.
echo "▸ packaging runtime/"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -C "$ROOT/runtime" \
  --exclude=node_modules --exclude='*.test.ts' --exclude='*scratch*' --exclude='*probe*' \
  -cf - . | tar -xf - -C "$STAGE"
(cd "$STAGE" && zip -qr image.zip .)
aws s3 cp "$STAGE/image.zip" "s3://${BUCKET}/${IMAGE_NAME}/image.zip" --region "$REGION" >/dev/null

# --additional-os-capabilities ALL is REQUIRED for Docker inside the VM: without it dockerd dies at
# "Devices cgroup isn't mounted". See docs/lambda-microvms.md.
#
# Hooks: `ready` fires once at build time and 200 is the signal to snapshot — everything slow is already
# baked by the Dockerfile, so the server answers immediately. The per-VM hooks let the agent survive an
# idle-suspend with its conversation intact.
HOOKS='{"port":9000,"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300},"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":30,"resume":"ENABLED","resumeTimeoutInSeconds":30,"suspend":"ENABLED","suspendTimeoutInSeconds":30,"terminate":"ENABLED","terminateTimeoutInSeconds":60}}'

# 4 GB (≈2 vCPU). The agent is I/O-bound on the model, but a `docker compose up` of a real project needs
# room — and the default 2 GB/1 vCPU makes builds and test runs inside the VM slow.
RESOURCES='minimumMemoryInMiB=4096'

# Baked into the image: who this agent is, and the SSM PATHS to its secrets. Only paths — the runtime
# resolves each `<VAR>_PARAM` to `<VAR>` at boot (runtime/src/secrets.ts) using the VM's own execution
# role, so no secret value is ever stored on the image.
#
# NOTE: AWS_REGION is a reserved key here — don't set it. The runtime hardcodes its region anyway.
ENVVARS="AGENT_NAME=${DISPLAY_NAME:-$NAME}"
ENVVARS="${ENVVARS},WORKSPACE_DIR=/workspace"
ENVVARS="${ENVVARS},SLACK_BOT_TOKEN_PARAM=/slack-dev/${NAME}/slack-bot-token"
ENVVARS="${ENVVARS},GH_APP_ID_PARAM=/slack-dev/${NAME}/gh-app-id"
ENVVARS="${ENVVARS},GH_APP_INSTALL_ID_PARAM=/slack-dev/${NAME}/gh-app-install-id"
ENVVARS="${ENVVARS},GH_APP_PRIVATE_KEY_PARAM=/slack-dev/${NAME}/gh-app-private-key"
[ -n "$GITHUB_REPO" ] && ENVVARS="${ENVVARS},GITHUB_REPO=${GITHUB_REPO}"

COMMON=(
  --code-artifact "uri=s3://${BUCKET}/${IMAGE_NAME}/image.zip"
  --environment-variables "$ENVVARS"
  --base-image-arn "arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1"
  --build-role-arn "$BUILD_ROLE"
  --additional-os-capabilities ALL
  --resources "$RESOURCES"
  --hooks "$HOOKS"
  --region "$REGION"
)

if aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --region "$REGION" >/dev/null 2>&1; then
  echo "▸ updating $IMAGE_NAME (a new version)"
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${COMMON[@]}" >/dev/null
else
  echo "▸ creating $IMAGE_NAME"
  aws lambda-microvms create-microvm-image --name "$IMAGE_NAME" "${COMMON[@]}" >/dev/null
fi

# The build is asynchronous, and a `run-microvm` against a still-building image fails — so wait, and say
# why if it fails rather than leaving a broken agent that looks deployed.
#
# The terminal states differ by branch, which is easy to get wrong: a CREATE ends at CREATED, an UPDATE
# at UPDATED. Accepting only CREATED would report every rebuild — the common case, since editing
# PROMPT.md means a rebuild — as a 20-minute timeout on a build that actually succeeded. The failure
# states are CREATE_FAILED / UPDATE_FAILED; there is no plain `FAILED`.
# (Enum: botocore/data/lambda-microvms/2025-09-09/service-2.json, MicrovmImageState.)
echo "▸ waiting for the image build (a few minutes on the first run)"
for _ in $(seq 1 120); do
  STATE="$(aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --region "$REGION" --query state --output text 2>/dev/null || echo CREATING)"
  case "$STATE" in
    CREATED | UPDATED)
      echo "✓ image ready ($STATE): $IMAGE_ARN"
      # Published only NOW. A `run-microvm` against an image that isn't in a ready state fails with
      # ResourceNotFoundException, so publishing the ARN before the build finished left a window where a
      # Slack mention hit a broken agent.
      aws ssm put-parameter --name "$SSM_PARAM" --value "$IMAGE_ARN" --type String --overwrite \
        --region "$REGION" >/dev/null
      echo "▸ image ARN → $SSM_PARAM"
      exit 0 ;;
    CREATE_FAILED | UPDATE_FAILED)
      echo "✗ the image build FAILED ($STATE). The build log names the failing Dockerfile step:" >&2
      echo "    aws lambda-microvms list-microvm-image-builds --image-identifier $IMAGE_ARN --region $REGION" >&2
      exit 1 ;;
  esac
  sleep 10
done
echo "✗ the image was still building after 20 minutes — check:" >&2
echo "    aws lambda-microvms get-microvm-image --image-identifier $IMAGE_ARN --region $REGION" >&2
exit 1
