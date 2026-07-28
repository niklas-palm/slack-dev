#!/usr/bin/env bash
# Provision this agent's secrets in SSM — the manual path, and how you rotate one value later.
#
# `npm run github-app` and `npm run slack-app` store these for you; use this when doing it by hand.
# Order doesn't matter relative to the deploy — nothing here depends on the stack existing. But note
# both readers CACHE: the runtime reads these once per session, and the ingress Lambda once per warm
# container. So a rotated signing secret or bot token takes effect on the next fresh session/container;
# redeploy if you need it immediately.
#
#   npm run secrets
#
# Prompts for each value (silently, so nothing lands in shell history) and writes it as a SecureString
# under this agent's own prefix. Idempotent — re-run it to rotate a value.
set -euo pipefail

cd "$(dirname "$0")/.."

REGION="eu-west-1"
# node, not python3: node is already a hard prerequisite and macOS no longer bundles python3. The old
# form exited 127 with no message at all when it was missing.
NAME="$(node -e 'process.stdout.write(String(require("./agent.config.json").name??""))')"
PREFIX="/slack-dev/${NAME}"

if [ "$NAME" = "demo" ]; then
  echo "agent.config.json still has the placeholder name \"demo\" — set a real agent name first." >&2
  exit 1
fi

# Temporary shell credentials, never an AWS profile.
aws() { command env -u AWS_PROFILE aws "$@"; }

put() {
  local param="$1" value="$2"
  aws ssm put-parameter --region "$REGION" --type SecureString --overwrite \
    --name "${PREFIX}/${param}" --value "$value" > /dev/null
  echo "  ✓ ${PREFIX}/${param}"
}

ask() {
  local prompt="$1" var
  printf "%s: " "$prompt" >&2
  read -rs var
  printf "\n" >&2
  printf "%s" "$var"
}

echo "Writing secrets for agent \"${NAME}\" to ${PREFIX} in ${REGION}."
echo "Leave a value empty to skip it (keeps whatever is already there)."
echo

echo "Slack (from api.slack.com/apps)"
SIGNING="$(ask '  Signing secret (Basic Information → App Credentials)')"
[ -n "$SIGNING" ] && put slack-signing-secret "$SIGNING"
BOT_TOKEN="$(ask '  Bot User OAuth Token (xoxb-…)')"
[ -n "$BOT_TOKEN" ] && put slack-bot-token "$BOT_TOKEN"

echo
echo "GitHub App (from Settings → Developer settings → GitHub Apps)"
APP_ID="$(ask '  App ID (a number)')"
[ -n "$APP_ID" ] && put gh-app-id "$APP_ID"
INSTALL_ID="$(ask '  Installation ID (last path segment of the install URL)')"
[ -n "$INSTALL_ID" ] && put gh-app-install-id "$INSTALL_ID"

printf "  Path to the App private key .pem (empty to skip): " >&2
read -r PEM_PATH
if [ -n "$PEM_PATH" ]; then
  if [ ! -f "$PEM_PATH" ]; then
    echo "  ✗ no such file: $PEM_PATH" >&2
    exit 1
  fi
  put gh-app-private-key "$(cat "$PEM_PATH")"
fi

echo
cat <<NOTE
Done. A rotation is not live everywhere at once:

  new Slack threads    pick it up immediately
  running threads      keep the OLD value for up to 8h — each microVM reads its secrets once
  the ingress Lambda   caches per warm container, so redeploy to cycle the signing secret

If you rotated because a credential LEAKED, revoke it at the source (Slack / GitHub) too, and terminate
the live VMs — docs/lambda-microvms.md has the commands (CLI namespace \`aws lambda-microvms\`, not
\`aws lambda\`).
NOTE
