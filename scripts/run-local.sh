#!/usr/bin/env bash
# Build and run the REAL agent image locally, then talk to it exactly like the ingress Lambda does.
#
#   npm run docker                          # build + boot, then wait (ctrl-C to stop)
#   npm run docker -- "what is in /app?"    # ...and send one prompt through /invoke
#
# This is the same image the microVM boots, so it exercises the whole in-VM path: the lifecycle hooks,
# the /invoke contract, the agent, the tools, dockerd. The only thing absent is Slack — with no `slack`
# in the payload the Slack tools report "this turn did not come from Slack" and the agent answers in
# its final message, which lands in the container logs.
#
# SLACK_BOT_TOKEN gets a placeholder because the /run hook refuses to come up without one (in a real VM
# a missing token means the agent can work but nobody ever hears from it). Nothing here calls Slack, so
# the value is never used. Export a real one to exercise the Slack path against a live workspace.
#
# Needs: Docker, and AWS credentials in the shell for Bedrock (`env -u AWS_PROFILE`).
set -euo pipefail

PROMPT="${1:-}"
NAME=slack-dev-local
PORT="${PORT:-9000}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ building the image (this is the microVM image, unchanged)"
docker build -q -t "$NAME" "$HERE/runtime" >/dev/null

docker rm -f "$NAME" >/dev/null 2>&1 || true

# --privileged is what `--additional-os-capabilities ALL` does for us in the microVM: it's what lets
# dockerd run inside. Nothing but Docker-using tasks needs it, so drop it if you'd rather not.
echo "▸ starting the container on :$PORT"
docker run -d --name "$NAME" --privileged -p "$PORT:9000" \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  -e "AGENT_NAME=${AGENT_NAME:-local}" \
  -e "SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-local-no-slack}" \
  "$NAME" >/dev/null

# The healthz + hook probes ARE the test: if these pass, the contract the microVM depends on works.
echo "▸ waiting for the server"
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:$PORT/healthz" >/dev/null || { echo "✗ never came up:"; docker logs "$NAME" | tail -30; exit 1; }

echo "▸ lifecycle hooks (what Lambda POSTs at build + per VM)"
for hook in ready run resume suspend terminate; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://localhost:$PORT/aws/lambda-microvms/runtime/v1/$hook" -d '{}')
  printf '  %-10s → %s\n' "$hook" "$code"
  [ "$code" = "200" ] || { echo "✗ hook $hook returned $code (Lambda needs 200)"; exit 1; }
done

if [ -n "$PROMPT" ]; then
  echo "▸ POST /invoke"
  curl -s -X POST "http://localhost:$PORT/invoke" \
    -H 'content-type: application/json' \
    -d "$(printf '{"sessionId":"local","prompt":%s}' "$(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
  echo
  echo "▸ following the logs (ctrl-C to stop; the answer appears as an \"event\":\"text\" line)"
  docker logs -f "$NAME"
else
  echo "✓ all hooks answered. Container '$NAME' is running on :$PORT."
  echo "  send a prompt:  curl -s localhost:$PORT/invoke -H 'content-type: application/json' -d '{\"prompt\":\"hi\"}'"
  echo "  logs:           docker logs -f $NAME"
  echo "  stop:           docker rm -f $NAME"
fi
