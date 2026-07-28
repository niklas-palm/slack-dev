#!/bin/bash
# The image entrypoint: start dockerd, then serve the agent.
#
# dockerd is best-effort. It lets the agent run a project's own docker-compose.yml inside its VM, but
# nothing about answering a Slack mention depends on it — so a failure here logs and carries on rather
# than killing the agent. In the microVM it needs `--additional-os-capabilities ALL`; locally it needs
# `--privileged` (see `npm run docker`). Without either, dockerd exits and only Docker-using tasks fail.
set -uo pipefail

if [ "${SKIP_DOCKERD:-0}" != "1" ]; then
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null 2>&1 \
    && echo '{"event":"dockerd_ready"}' \
    || echo '{"event":"dockerd_unavailable","hint":"needs --additional-os-capabilities ALL (microVM) or --privileged (local); see /var/log/dockerd.log"}'
fi

exec npx tsx src/server.ts
