# The agent's image. TypeScript runs directly via tsx — no build step, so what you edit is what ships.
#
# This ONE image is both the Lambda MicroVM image and what you run locally with `docker run`
# (`npm run docker` — see CONTRIBUTING.md). Owning the whole image is the reason we're on microVMs
# rather than a managed runtime: the thing you test on your laptop is the thing that boots in the VM.
#
# Amazon Linux 2023 matches the MicroVM managed base OS (`al2023-1`). Docker is installed so the agent
# can run a project's own docker-compose.yml and test a change end to end inside its own VM; that needs
# `--additional-os-capabilities ALL` at image-create time (infra/microvm/build.sh), or dockerd dies at
# "Devices cgroup isn't mounted".
#
# IMPORTANT: everything the agent needs at run time must be installed HERE. A microVM's DNS resolver is
# a loopback forwarder that a nested build container cannot reach, so `docker build` INSIDE the VM hangs
# on DNS forever (`docker pull` is fine — dockerd uses the VM's own resolver). Build-time DNS works
# normally. Full mechanics: docs/lambda-microvms.md.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# The tools the agent shells out to, plus Docker and the AWS CLI.
RUN dnf -y update && \
    dnf -y install docker git tar gzip jq openssl findutils awscli-2 python3.12 python3.12-pip && \
    dnf -y install nodejs22 nodejs22-npm --allowerasing && \
    dnf clean all && rm -rf /var/cache/dnf

# AL2023 ships several Node majors side by side and points `node` at the OLDEST (18). Pin the links to
# 22: Node 18 predates `import.meta.dirname`, which config.ts uses, so the agent doesn't even boot on it.
# `node -v | grep` makes that a BUILD failure rather than a crash at first boot.
RUN ln -sf /usr/bin/node-22 /usr/local/bin/node && \
    ln -sf /usr/bin/npm-22 /usr/local/bin/npm && \
    ln -sf /usr/bin/npx-22 /usr/local/bin/npx && \
    node -v | grep -q '^v22'

# The docker compose plugin (v2) — dnf's docker package doesn't bundle it.
RUN mkdir -p /usr/libexec/docker/cli-plugins && \
    ARCH="$(uname -m)"; case "$ARCH" in aarch64) A=aarch64;; *) A=x86_64;; esac; \
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.1/docker-compose-linux-${A}" \
      -o /usr/libexec/docker/cli-plugins/docker-compose && \
    chmod +x /usr/libexec/docker/cli-plugins/docker-compose

# ripgrep — the agent's search tool, and the prompt promises it. Not in AL2023's repos, so take the
# release binary rather than a best-effort `dnf install || true`, which silently shipped an image whose
# prompt advertised a missing binary.
RUN ARCH="$(uname -m)"; case "$ARCH" in aarch64) A=aarch64-unknown-linux-gnu;; *) A=x86_64-unknown-linux-musl;; esac; \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${A}.tar.gz" \
      -o /tmp/rg.tgz && tar -xzf /tmp/rg.tgz -C /tmp && \
    mv "/tmp/ripgrep-14.1.1-${A}/rg" /usr/local/bin/rg && rm -rf /tmp/rg* && rg --version >/dev/null

# The GitHub CLI — the agent's PR path. Not in AL2023's repos, so take the release tarball.
RUN ARCH="$(uname -m)"; case "$ARCH" in aarch64) A=arm64;; *) A=amd64;; esac; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_${A}.tar.gz" \
      -o /tmp/gh.tgz && tar -xzf /tmp/gh.tgz -C /tmp && \
    mv "/tmp/gh_2.63.2_linux_${A}/bin/gh" /usr/local/bin/gh && rm -rf /tmp/gh*

# boto3 for read-only AWS queries via run_python; httpx for HTTP from Python.
#
# python3.12, not AL2023's default python3 — that's 3.9, too old for current boto3/httpx wheels. The
# symlink is what makes `python3` in the agent's `run_python` (and in run_bash) mean 3.12.
RUN ln -sf /usr/bin/python3.12 /usr/local/bin/python3 && \
    python3 -m pip install --no-cache-dir boto3==1.43.23 httpx==0.28.1

WORKDIR /app

# Manifests first so a source-only change doesn't reinstall dependencies.
#
# `npm ci` against a committed lockfile, NOT `npm install`: the build context is this directory only,
# so the workspace-root lockfile is not visible here. Without runtime/package-lock.json every image
# build re-resolved the `^` ranges, meaning two builds of the same commit could ship different SDK
# versions and a breaking minor could land with nothing in the diff. A root `npm install` does NOT
# update this file — see CONTRIBUTING.md for how to regenerate it.
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit

# The agent itself: harness, prompt, skills.
COPY src ./src
COPY PROMPT.md ./PROMPT.md
COPY skills ./skills

# The entrypoint: start dockerd, then serve the lifecycle hooks + /invoke.
COPY start.sh ./start.sh
RUN chmod +x ./start.sh && mkdir -p /workspace

# NOTE: deliberately NO `NODE_ENV=production` — it broke every repo the agent clones.
#
# npm derives `omit=dev` from it (verify: `NODE_ENV=production npm config get omit` → `dev`), so an
# `npm ci` in the agent's WORKSPACE installed no devDependencies, and the repo's own typecheck and tests
# then failed on a missing `vitest`/`@types`. Every `run_bash` child inherits the image env, so this
# applied to somebody else's project, not ours. Two agents each burned ~7 turns of Opus 5 diagnosing it
# before finding the cause was us. It bought nothing in return: this image's own deps are installed by
# the `npm ci` above, and nothing in src/ reads NODE_ENV.
ENV NODE_NO_WARNINGS=1 \
    WORKSPACE_DIR=/workspace \
    HOME=/workspace \
    HOOK_PORT=9000

EXPOSE 9000
CMD ["/app/start.sh"]
