# Lambda MicroVMs: how they actually work

Everything here is verified against the live API (`aws lambda-microvms`, 2026-07-28) or carried over from
a working production implementation. Read this before touching `infra/microvm/` or the image build — the
non-obvious parts below each cost real debugging time to discover.

## The model

A **microVM image** is a Firecracker VM image you build from a Dockerfile plus an AWS-managed base OS. A
**microVM** is one running instance of it, with its own dedicated HTTPS endpoint. You control the whole
image, so there is no runtime contract to satisfy beyond an optional lifecycle-hook HTTP server.

```
create-microvm-image  ──build──►  image (CREATED)  ──run-microvm──►  microVM (PENDING→RUNNING)
      │                                │                                    │
   Dockerfile + zip in S3         SNAPSHOT of the                  https://<id>.lambda-microvm
   + build role                   fully-booted VM                  .<region>.on.aws
```

**The snapshot is the whole point.** The image build boots the VM, runs your entrypoint, and calls your
`/ready` hook; when that returns 200, Lambda snapshots **disk *and* memory, including every running
process**. A later `run-microvm` restores that snapshot in seconds — so anything slow (installing
dependencies, warming a daemon, starting a server) should happen at *build* time, once, not per VM.

## Region

This template is **pinned to `eu-west-1`**, where Claude Opus 5 is `ACTIVE`, so the model and the
compute share one region.

**MicroVMs is not in every region — ASK the API, don't trust a list.** Any list written down here goes
stale as AWS adds regions, and an enumerated one was wrong within weeks of being written: it had been
generalised from a single negative probe (`eu-north-1` → `AccessDeniedException`), which cannot establish
what IS supported. Check the region you want:

```bash
# the real probe. `list-microvm-images` is NOT one — it returns {"items": []} in supported and
# unsupported regions alike, so it looks like a clean answer while telling you nothing.
aws lambda-microvms list-managed-microvm-images --region <r>
```

Moving is a set of pinned constants, not a config knob. **Find them with `grep`, not from a list here** —
a written list is stale the moment someone adds a pin, and reads exhaustive while it isn't:

```bash
grep -rn "eu-west-1\|eu\.anthropic" --include='*.ts' --include='*.sh' --include='*.yml' \
  --exclude-dir=node_modules --exclude-dir=cdk.out .
```

Two that are easy to miss even so: **`.github/workflows/deploy.yml`'s `aws-region`** (CI would deploy
into the old region, or trip the stack's guard), and **`MODEL_ID`, because the inference-profile prefix is
regional** (`us.anthropic.claude-opus-5` in a US region, not `eu.`) — forgetting that one deploys cleanly
and then fails at the first model call. Two region-pinned tests also assert the value
(`infra/test/stack.test.ts`: the deploy guard, and a `kms:ViaService` ARN).

Confirm your model is `ACTIVE` in the new region too — the compute being available does not imply the
model is. Don't run a mixed pair: stack in one region, image built in the other fails late and
confusingly.

Base image: `arn:aws:lambda:<region>:aws:microvm-image:al2023-1` (Amazon Linux 2023, the only managed
base offered).

## Docker inside a microVM — the requirement and the trap

**Docker works, with `--additional-os-capabilities ALL` on the image.** Without it `dockerd` dies at
`Devices cgroup isn't mounted`. Environment inside: cgroup v2, kernel 6.1 aarch64, root, Docker 29.x.

**Running containers is verified. Building images in-VM has a known DNS trap.**

| Operation | Status |
|---|---|
| `dockerd` boots | ✅ verified (needs the `ALL` capability) |
| `docker pull` | ✅ verified — dockerd uses the VM's own resolver |
| `docker run` | ✅ verified (`hello-world`, exit 0) |
| `docker compose up` | ✅ verified — a real multi-service topology on localhost |
| `docker build` (default) | ❌ hangs on DNS — see below |
| `docker build --network=host` | ⚠️ untested; expected to work |

The trap: the VM's resolver is a **loopback forwarder** (`nameserver 127.0.0.2`, Lambda's managed egress
DNS). `dockerd` reaches it, which is why pulls work. But a **build container gets its own network
namespace**, cannot reach `127.0.0.2`, and external resolvers (8.8.8.8, 1.1.1.1) are blocked by egress —
so `npm install` inside a default `docker build` hangs on DNS forever.

`--network=host` puts the build in the VM's own namespace, where `127.0.0.2` *is* reachable, so it should
resolve the problem. **This has not been tested** — the project this was learned from pivoted to
CI→ECR→pull instead and never tried it. If you need in-VM builds, test that flag before designing around
the limitation.

The safe rule either way: **anything the agent needs at run time belongs in the image Dockerfile**, where
DNS works normally. Prefer `docker pull` of a prebuilt image over building one in the VM.

## The IAM you need, including one that only fails on a real call

Two grants are easy to miss because neither shows up at synth, in a dry run, or in any template.

**`lambda:PassNetworkConnector`** — needed to *run* a VM, and also to **build an image**:
`CreateMicrovmImage` validates the connectors the image will run with. It's a permission distinct from
`CreateMicrovmImage`/`RunMicrovm`, scoped to the connector ARNs:

```
arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:ALL_INGRESS
arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:INTERNET_EGRESS
```

**The action names use `Microvm`, lowercase `vm`** — they match the API operation names exactly. Wrong
casing (`MicroVm`) means the action doesn't exist, so the policy looks correct and every call is denied.

Also worth knowing:

- The **image build role** needs `s3:GetObject` on the artifacts bucket **plus**
  `logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents`. Without the log grants Lambda cannot write the
  build log — and a failed build then tells you to go read a log that was never created.
- The **execution role** needs those same three `logs:` actions. `ReadOnlyAccess` grants
  `logs:Describe*`/`Get*`/`List*` but **not** `CreateLogStream` or `PutLogEvents`, so without an explicit
  grant every log line the agent emits is silently dropped — which hides every other failure.
- Both roles are assumed by `lambda.amazonaws.com`. The **build** role's trust policy also allows
  `sts:TagSession` (`build.sh` sets it); the **execution** role does NOT need it — CDK's `assumedBy`
  emits `sts:AssumeRole` alone, and the deployed role has only that while `run-microvm` works fine.
  Verified against the live role, not inferred: don't "fix" the stack to match an earlier version of
  this line, which claimed both roles required it.
- A role created seconds before its first `run-microvm` can fail with *"We were unable to assume the role
  provided"* — that's IAM propagation, not a wrong trust policy. Retry before debugging.

Reference implementations: `infra/lib/stack.ts` (the execution role), `infra/microvm/build.sh` (the build
role), `scripts/setup-github-oidc.sh` (what CI needs).

## Lifecycle hooks

Configured with `--hooks` at image build. Your entrypoint runs an HTTP server on the hook port; Lambda
POSTs to `/aws/lambda-microvms/runtime/v1/<hook>`.

| Hook | When | Timeout | Notes |
|---|---|---|---|
| `ready` | image build, once | ≤ 3600s | **Required if any hook is enabled.** Must return 200 before the snapshot is taken. |
| `run` | each `run-microvm` | ≤ 60s | Carries `--run-hook-payload` (max 16 KB) — how a generic image specializes itself. |
| `resume` | on auto-resume | ≤ 60s | Disk *and* memory survive suspension; a liveness check is usually enough. |
| `suspend` | on idle-suspend | ≤ 60s | |
| `terminate` | on terminate | ≤ 60s | Best-effort cleanup; the VM dies regardless. |

**`/ready` must poll, not block.** Return `503` immediately while the work continues in the background,
and `200` only when done. Holding the request open until the timeout *ends the build*. Same for `/run`:
it has a hard 60-second ceiling, so kick slow work into the background and expose progress on your own
status endpoint.

`/run` delivery is **at-least-once** — latch it so a redelivery doesn't repeat the work.

## Reaching into a running microVM

The endpoint is not directly browsable. Every request needs two things:

1. **`X-aws-proxy-auth`** — a JWE token from `create-microvm-auth-token`, scoped to specific ports and
   minted for N minutes.
2. **`X-aws-proxy-port`** — which port inside the VM to hit. Without it you reach the hook port.

```bash
aws lambda-microvms create-microvm-auth-token --microvm-identifier <id> \
  --expiration-in-minutes 10 --allowed-ports '[{"port":9000}]' --region eu-west-1
```

**The response's `authToken` is an OBJECT of headers to send** — `{"X-aws-proxy-auth": "<jwe>"}` — not a
bare string. A `--query authToken --output text` CLI call flattens it, which is why ad-hoc curl tests
work while SDK code gets `undefined`. Extract the header value.

Minting is a control-plane call, so **cache the token per (vm, port)** and re-mint shortly before expiry;
otherwise a polling loop mints one per request.

## Idle, suspend, and lifetime

```
--idle-policy maxIdleDurationSeconds=…,suspendedDurationSeconds=…,autoResumeEnabled=true
--maximum-duration-in-seconds N     # hard ceiling, ≤ 28800 (8h)
```

Idle → suspended (billing stops for compute); traffic → auto-resume with memory intact. Suspended longer
than `suspendedDurationSeconds` → terminated. **A microVM bills until it is terminated or hits its max
duration**, so terminate explicitly when you're done.

**"Idle" means no INBOUND traffic through the proxy endpoint — nothing else.** The API's own words: *"Idle
time is measured by inbound traffic through the MicroVM proxy endpoint — if no requests arrive within the
configured duration, the MicroVM is suspended."* Not CPU, not an outbound HTTP call, not a running child
process. So a VM working hard on a single request looks completely idle:

> A turn takes one inbound request (`/invoke`) and can then run for many minutes — model round-trips, a
> clone, a test suite. Cross `maxIdleDurationSeconds` and it is **suspended mid-flight**: the in-flight
> socket and any child process freeze, and on the next mention they thaw into a dead connection. It
> surfaces as a long silence followed by an error, which reads like a model problem rather than a
> lifecycle one.

There is no keep-alive from inside — the VM cannot generate inbound traffic to itself through the proxy.
The mitigations are (a) set the idle window comfortably above your longest plausible request, and (b) log
at the `suspend` hook when work is in flight, so the symptom is diagnosable. This project does both
(`IDLE_SESSION_SECONDS` in `infra/lib/config.ts`; `suspended_mid_turn` in `runtime/src/server.ts`).

Resources default to 2 GB / 1 vCPU; `--resources minimumMemoryInMiB=8192` gives 8 GB / 4 vCPU.

### Listing and killing VMs by hand

Note the CLI namespace — **`aws lambda-microvms`**, not `aws lambda`. The microVM API is a separate
service model, so it doesn't appear under `aws lambda help` at all (nor in the JS SDK, which is why
`infra/lambda/slack-events/microvm.ts` signs its own requests).

```bash
aws lambda-microvms list-microvms --region eu-west-1 \
  --query 'items[?state!=`TERMINATED`].[microvmId,state]' --output text
aws lambda-microvms terminate-microvm --microvm-identifier <id> --region eu-west-1
```

The response field is `items`, and the terminate flag is `--microvm-identifier` (not `--microvm-id`).
Reach for this after rotating a leaked secret — a running VM holds the old value in memory for its whole
life — or to stop a VM billing before its 8h ceiling.

## No session routing, no tags

`run-microvm` accepts **no tags**, and `list-microvms` filters only by image — there is no way to ask
"which VM belongs to thread X". Unlike AgentCore's `runtimeSessionId`, **session→VM routing is yours to
build.** This sample keeps a small DynamoDB table (`infra/lib/stack.ts`, `SessionTable`), read by the ingress in
`infra/lambda/slack-events/handler.ts` — see the architecture diagram in [../README.md](../README.md).

## What this replaced, and why

We ran on **Bedrock AgentCore** first. It gave session→microVM routing for free, which is genuinely less
code. We moved because:

- **You own the image.** No runtime contract, no SDK wrapper — a plain HTTP server on a port.
- **Docker works inside**, so an agent can run a project's own `docker-compose.yml` to test a change end
  to end in the same isolation as production.
- **The lifecycle is explicit** (run/suspend/resume/terminate), so idle cost and lifetime are ours to set.

The cost is honest: we now own thread→VM routing and image builds. The build is
[`infra/microvm/build.sh`](../infra/microvm/build.sh) (`npm run image`); [../setup.md](../setup.md)
step 4 is the operator's view of it.

## Reproducing the Docker proof

```bash
BUCKET=<your-artifacts-bucket>
zip probe.zip app.js Dockerfile     # app.js: start dockerd, then `docker run hello-world`
aws s3 cp probe.zip s3://$BUCKET/probe/probe.zip --region eu-west-1
aws lambda-microvms create-microvm-image --name probe-docker \
  --code-artifact uri=s3://$BUCKET/probe/probe.zip \
  --base-image-arn arn:aws:lambda:eu-west-1:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::<acct>:role/<BuildRole> \
  --additional-os-capabilities ALL --region eu-west-1
# then run-microvm, mint a token, curl the probe path — and TERMINATE the VM (it bills until you do).
```
