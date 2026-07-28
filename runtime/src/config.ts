// Single source of truth for runtime configuration. Nothing else reads process.env for config.
//
// Two tiers:
//   1. Invariants  — hardcoded. Never read from the environment, so a stale shell value can't
//      misroute a call.
//   2. Deploy-provided — baked into the microVM image at build time, or passed per-VM.
import { resolve } from "node:path";

// --- 1. Invariants ---------------------------------------------------------

/** Everything lives in eu-west-1, where Opus 5 is ACTIVE, so compute and model share one region.
 *  MicroVMs is not available in every region — see docs/lambda-microvms.md before moving. Deliberately NOT read from AWS_REGION (a stale
 *  shell value must not be able to misroute a call). See docs/lambda-microvms.md. */
export const REGION = "eu-west-1";

/** The only model this agent runs. One model, no per-task routing — that's the whole point. The `eu.`
 *  prefix is a REGIONAL inference profile — in a US region this must be `us.anthropic.claude-opus-5` — so a
 *  region change that forgets this line deploys cleanly and fails at the first model call. */
export const MODEL_ID = "eu.anthropic.claude-opus-5";

/** Ceiling on ONE model response's output tokens (BedrockModel.maxTokens). */
export const MAX_TOKENS = 32_000;

/** Model round-trips allowed in ONE turn, so a retry loop can't run until the microVM dies. */
export const MAX_TURNS = 200;

/** The port the in-VM server listens on: lifecycle hooks + /invoke. Reached via `X-aws-proxy-port`. */
export const HOOK_PORT = Number(process.env.HOOK_PORT ?? 9000);

// --- 2. Deploy-provided ----------------------------------------------------

/** The agent's sandbox. Tools refuse to touch anything outside it. */
export const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? "/workspace");

/** `owner/repo` the GitHub App is installed on. The agent clones this. */
export const GITHUB_REPO = process.env.GITHUB_REPO ?? "";

/** Free-text name shown in prompts/logs (e.g. "platform-ops"). */
export const AGENT_NAME = process.env.AGENT_NAME ?? "agent";

/** Where PROMPT.md lives — baked into the image next to src/. */
export const PROMPT_FILE = resolve(process.env.PROMPT_FILE ?? resolve(import.meta.dirname, "..", "PROMPT.md"));

/** Where the skills live — the AgentSkills plugin scans this directory. */
export const SKILLS_DIR = resolve(process.env.SKILLS_DIR ?? resolve(import.meta.dirname, "..", "skills"));

/** Slack's API root. The override exists so the real code can be pointed at a local stub to assert an
 *  actual call sequence end to end (how the status protocol was verified against a live model); the
 *  unit tests stub `fetch` instead, and nothing in production sets it. */
export const SLACK_API_BASE = (process.env.SLACK_API_BASE ?? "https://slack.com/api").replace(/\/$/, "");
