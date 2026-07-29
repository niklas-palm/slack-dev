#!/usr/bin/env bash
# Reclaim the disk this project's build loops fill up.
#
#   npm run reclaim          # report what's reclaimable, change nothing
#   npm run reclaim -- --yes # actually reclaim it
#
# Why this exists: `npm run docker` and `npm run image` build the runtime image, and a few rounds of that
# — especially several agents building in parallel — put tens of GB into Docker's build cache. It filled a
# 460 GB disk to zero once, which is worse than it sounds: at zero bytes free, Docker Desktop can't start,
# so `docker prune` (the fix) can't run either. That dead end is the reason this is a script and not a
# line in a doc.
#
# Everything here is a CACHE. Nothing is source, nothing is deployed state, and nothing is unrecoverable —
# the cost of clearing it is a slower next build. It deliberately does NOT touch node_modules (reinstalling
# across every project is a worse trade) or anything in AWS.
set -euo pipefail

APPLY=false
[ "${1:-}" = "--yes" ] && APPLY=true

DOCKER_RAW="$HOME/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"

# `du` prints nothing for a path that doesn't exist, which reads as a broken script rather than "empty".
size() { du -sh "$1" 2>/dev/null | cut -f1 || true; }
size_or_empty() { local s; s="$(size "$1")"; echo "${s:-0B (absent)}"; }
free_now() { df -h / | awk 'NR==2 {print $4}'; }

echo "Free now: $(free_now)"
echo

# 1. Docker. Prefer the daemon's own prune: it knows what's in use and keeps running containers.
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "▸ Docker is running — reclaimable:"
  docker system df 2>/dev/null | awk 'NR==1 || /RECLAIMABLE/ || NF>3'
  if $APPLY; then
    echo "  pruning build cache + unused images…"
    docker builder prune -af >/dev/null
    docker image prune -af >/dev/null
    echo "  ✓ done"
  fi
elif [ -f "$DOCKER_RAW" ]; then
  # Daemon down. The whole VM disk is one file, and it is pure cache for us: images, layers, build cache.
  # Deleting it is the ONLY way out of the disk-full deadlock, and Docker recreates it empty on next start.
  echo "▸ Docker is NOT running. Its VM disk is $(size "$DOCKER_RAW") ($DOCKER_RAW)."
  echo "  Deleting it discards every local image and cache; Docker rebuilds it empty on next start."
  if $APPLY; then
    rm -f "$DOCKER_RAW"
    echo "  ✓ removed — start Docker Desktop when you next need it"
  fi
else
  echo "▸ Docker: nothing to reclaim (no VM disk, daemon down)."
fi
echo

# 2. The npm package cache. Pure download cache — npm refetches whatever it needs.
#
# Report `_cacache` specifically, not the whole ~/.npm: `npm cache clean` only clears that subdirectory,
# while the parent also holds things it never touches (_libvips, _prebuilds, node-sass, _npx). Printing the
# parent's size made a successful clean look like a no-op — 973M before and after.
NPM_CACHE="$(npm config get cache)"
echo "▸ npm package cache: $(size_or_empty "$NPM_CACHE/_cacache") in $NPM_CACHE/_cacache"
if $APPLY; then
  npm cache clean --force >/dev/null 2>&1
  echo "  ✓ cleared"
fi
OTHER="$(size "$NPM_CACHE")"
echo "  ($OTHER total in $NPM_CACHE — the rest is _libvips/_prebuilds/_npx etc., which npm won't clear;"
echo "   delete those by hand only if you're desperate, they're rebuilt by whatever needed them.)"
echo

if $APPLY; then
  echo "Free now: $(free_now)"
else
  echo "Nothing changed. Re-run with --yes to reclaim:  npm run reclaim -- --yes"
fi
