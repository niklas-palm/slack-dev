// A minimal Lambda MicroVM client: run a VM, check it, mint a token, reach inside it.
//
// Hand-rolled SigV4 over `fetch` because the JS SDK has no microVM commands yet (verified against
// @aws-sdk/client-lambda 3.1096.0 — zero `Microvm` exports) and a Lambda has no `aws` CLI to shell out
// to. Every path and body shape below was taken from `aws lambda-microvms … --debug`, not guessed.
//
// Only the four operations the ingress needs. Suspend/resume are handled by the VM's own idle policy.
//
// Paths come from the service model shipped with the CLI
// (botocore/data/lambda-microvms/2025-09-09/service-2.json) — the authoritative source. Worth reading
// it before adding an operation: TerminateMicrovm is `DELETE /microvms/{id}`, not the `POST …/terminate`
// its verb name suggests.
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";

/** The service's API version, from the CLI's own request path. */
const API = "2025-09-09";

/** 8 hours — the longest a microVM may live, and what we always ask for. */
const MAX_LIFETIME_SECONDS = 28_800;

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const HOST = `lambda.${REGION}.amazonaws.com`;

const signer = new SignatureV4({
  service: "lambda",
  region: REGION,
  sha256: Sha256,
  credentials: defaultProvider(),
});

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const signed = await signer.sign(
    new HttpRequest({
      method,
      protocol: "https:",
      hostname: HOST,
      path,
      headers: {
        host: HOST,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { body: payload } : {}),
    }),
  );
  const res = await fetch(`https://${HOST}${path}`, {
    method,
    headers: signed.headers,
    body: payload,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object")
      json = parsed as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  if (res.status >= 300) {
    throw new Error(
      `lambda-microvms ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  return { status: res.status, json };
}

export interface MicroVm {
  microvmId: string;
  /** PENDING | RUNNING | SUSPENDING | SUSPENDED | TERMINATING | TERMINATED */
  state: string;
  /** The dedicated HTTPS host, no scheme. */
  endpoint: string;
}

/** True when a VM can serve traffic now or will auto-resume into serving. */
export function usable(state: string): boolean {
  return state === "RUNNING" || state === "PENDING" || state === "SUSPENDED";
}

export async function runMicrovm(input: {
  imageArn: string;
  executionRoleArn: string;
  idleSeconds: number;
}): Promise<MicroVm> {
  const connector = (kind: string): string =>
    `arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:${kind}`;
  const { json } = await call("POST", `/${API}/microvms`, {
    imageIdentifier: input.imageArn,
    executionRoleArn: input.executionRoleArn,
    ingressNetworkConnectors: [connector("ALL_INGRESS")],
    egressNetworkConnectors: [connector("INTERNET_EGRESS")],
    // Alive for as long as the service allows — 8h, the ceiling below — but only BILLING while it's
    // being used. Idle → suspended (compute billing stops); traffic → auto-resume with memory, and so
    // the whole conversation, intact. `suspendedDurationSeconds` matches the ceiling deliberately: a
    // smaller value would terminate a suspended VM early and silently cost a thread its context.
    //
    // `idleSeconds` must stay WELL BELOW the ceiling. Set equal to it, a VM can never suspend before
    // it's terminated, so every thread bills the full 8h window — which is the whole cost of the thing.
    idlePolicy: {
      maxIdleDurationSeconds: input.idleSeconds,
      suspendedDurationSeconds: MAX_LIFETIME_SECONDS,
      autoResumeEnabled: true,
    },
    // The service's hard ceiling, and the backstop against a leaked VM: one bills until it terminates.
    maximumDurationInSeconds: MAX_LIFETIME_SECONDS,
  });
  return {
    microvmId: String(json.microvmId),
    state: String(json.state),
    endpoint: String(json.endpoint),
  };
}

export async function getMicrovm(microvmId: string): Promise<MicroVm> {
  const { json } = await call("GET", `/${API}/microvms/${microvmId}`);
  return {
    microvmId: String(json.microvmId),
    state: String(json.state),
    endpoint: String(json.endpoint),
  };
}

export async function terminateMicrovm(microvmId: string): Promise<void> {
  // DELETE on the VM itself — not a POST to /terminate, which is what the verb name suggests.
  await call("DELETE", `/${API}/microvms/${microvmId}`);
}

/**
 * Mint a JWE token scoped to one port.
 *
 * The response's `authToken` is an OBJECT of headers to send (`{"X-aws-proxy-auth": "<jwe>"}`), not a
 * bare string — a `--query authToken --output text` CLI call flattens it, which is why ad-hoc curl
 * tests work while code gets `undefined`.
 */
export async function authToken(
  microvmId: string,
  port: number,
): Promise<string> {
  const { json } = await call(
    "POST",
    `/${API}/microvms/${microvmId}/auth-token`,
    { expirationInMinutes: 10, allowedPorts: [{ port }] },
  );
  const raw = json.authToken;
  const token =
    typeof raw === "string"
      ? raw
      : ((raw as Record<string, string> | undefined)?.["X-aws-proxy-auth"] ??
        "");
  if (!token) throw new Error("create-microvm-auth-token returned no token");
  return token;
}

/**
 * Make an HTTP request to a port INSIDE a microVM. Needs both headers: the JWE token, and the port
 * (without it you reach whatever the hook port is). Never throws on status — returns it.
 */
export async function vmRequest(
  vm: MicroVm,
  port: number,
  req: { method?: string; path: string; body?: string; timeoutMs?: number },
): Promise<{ status: number; body: string }> {
  const token = await authToken(vm.microvmId, port);
  const res = await fetch(`https://${vm.endpoint}${req.path}`, {
    method: req.method ?? "GET",
    headers: {
      "X-aws-proxy-auth": token,
      "X-aws-proxy-port": String(port),
      ...(req.body ? { "content-type": "application/json" } : {}),
    },
    body: req.body,
    signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
  });
  return { status: res.status, body: await res.text() };
}
