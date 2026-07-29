// The whole per-agent configuration: read agent.config.json, validate it, derive every name from it.
//
// Everything that varies between agents lives in that one file. Everything structural (region, model)
// is an invariant here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Every resource lives here. This deployment is pinned to eu-west-1, where Opus 5 is ACTIVE, so
 *  compute and model share one region. Moving region means changing this AND runtime MODEL_ID (the
 *  `eu.`/`us.` inference-profile prefix is regional), and confirming MicroVMs is available there.
 *  See docs/lambda-microvms.md. */
export const REGION = "eu-west-1";

/**
 * Seconds a thread's microVM may sit IDLE before it suspends. Not its lifetime — that's a fixed 8h
 * (the service ceiling), and suspending doesn't shorten it: a suspended VM auto-resumes on the next
 * mention with its memory, and therefore the whole conversation, intact.
 *
 * This is the cost knob. Compute billing stops while suspended, so a thread costs for the time it is
 * actually being worked on rather than the whole 8h window. Setting it TO 8h would mean a VM can never
 * suspend before it's terminated — every thread billing the full window.
 *
 * But it also has a FLOOR. The idle timer counts inbound traffic through the proxy endpoint only, and a
 * turn in flight generates none (its work is all outbound: Bedrock, git, the Slack API). So a turn
 * running longer than this window is suspended mid-flight and thaws into a dead socket on the next
 * mention — a spurious error after a long silence. `run_bash` alone permits 900s per call, so keep this
 * comfortably above the longest turn you expect. 45 min bounds cost while leaving real headroom.
 *
 * A module constant, not a field on AgentConfig: it sat there with a 30-line comment while loadConfig
 * hardcoded it and never read it from the file, so setting it in agent.config.json silently did nothing.
 */
export const IDLE_SESSION_SECONDS = 2_700;

export interface AgentConfig {
  /** Short slug identifying this agent. Derives the stack name and the SSM prefix. */
  name: string;
  /** Human-facing name used in prompts and log lines (e.g. "platform-ops"). Defaults to `name`. */
  displayName: string;
  description: string;
  /** `owner/repo` the GitHub App is installed on. Optional — an agent can be AWS/Slack only. */
  githubRepo: string;
  /**
   * Slack channel IDs the agent will answer in. A mention from anywhere else is dropped by the ingress
   * Lambda before anything happens — no 👀, no invoke, no reply.
   *
   * Empty means ANY channel the bot is a member of, which is the right default for a small workspace
   * and the wrong one for a large org: anyone who can `/invite` the bot could otherwise put it to work.
   */
  allowedChannels: string[];
  /** Stack name: unique per agent so several can coexist in one account. */
  stackName: string;
  /** SSM prefix holding this agent's secrets. Namespaced by agent name. */
  ssmPrefix: string;
  /** The microVM image name — `npm run image` registers `slack-dev-<name>`. */
  imageName: string;
}

// The slug feeds a CloudFormation stack name, an SSM path, and a microVM image name, so keep it to the
// intersection of what all three accept.
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

// Slack channel ids: C… public, G… private group, D… DM. Not names — the event payload carries only
// the id, so a name would mean an API lookup inside the ingress path (see setup.md).
const CHANNEL_RE = /^[CGD][A-Z0-9]{6,}$/;

/** What agent.config.example.json ships. Valid-looking, and silently disables the agent everywhere. */
const PLACEHOLDER_CHANNEL = "C0123456789";

export function loadConfig(root: string = REPO_ROOT): AgentConfig {
  const file = join(root, "agent.config.json");
  let raw: Partial<AgentConfig>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AgentConfig>;
  } catch (e) {
    // The file is gitignored, so a fresh clone genuinely doesn't have one — say what to do rather than
    // reporting ENOENT on a path the reader has never heard of.
    const missing = (e as { code?: string }).code === "ENOENT";
    throw new Error(
      missing
        ? `No agent.config.json yet. Copy the template and edit it:\n\n  cp agent.config.example.json agent.config.json\n\nSee setup.md step 2.`
        : `Could not read ${file}: ${e instanceof Error ? e.message : e}`,
    );
  }

  const name = (raw.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `agent.config.json "name" must match ${NAME_RE} (lowercase letters, digits, hyphens); got "${name}"`,
    );
  }
  if (name === "demo") {
    throw new Error(
      'agent.config.json still has the placeholder name "demo" — set a real agent name first.',
    );
  }

  const githubRepo = (raw.githubRepo ?? "").trim();
  if (
    githubRepo &&
    (!/^[^/\s]+\/[^/\s]+$/.test(githubRepo) ||
      githubRepo === "OWNER/REPOSITORY")
  ) {
    throw new Error(
      `agent.config.json "githubRepo" must be "owner/repo" (or empty); got "${githubRepo}"`,
    );
  }

  const allowedChannels = (raw.allowedChannels ?? [])
    .map((c) => c.trim())
    .filter(Boolean);
  for (const channel of allowedChannels) {
    // The example file's placeholder. Left in, it deploys an agent that answers in NO channel and shows
    // no sign of life anywhere — by design, so it looks exactly like a failed deploy. Rejected here for
    // the same reason as the placeholder name and repo.
    if (channel === PLACEHOLDER_CHANNEL) {
      throw new Error(
        `agent.config.json still has the placeholder channel "${channel}". Replace it with a real channel ` +
          `id (right-click the channel in Slack → View channel details), or use [] to allow every channel ` +
          `the bot is in. See setup.md step 2.`,
      );
    }
    if (channel.startsWith("#") || !CHANNEL_RE.test(channel)) {
      throw new Error(
        `agent.config.json "allowedChannels" takes channel IDs, not names; got "${channel}". ` +
          `In Slack: right-click the channel → View channel details → the ID is at the bottom.`,
      );
    }
  }

  return {
    name,
    displayName: (raw.displayName ?? name).trim(),
    description: (
      raw.description ?? `Slack-triggered engineering agent: ${name}`
    ).trim(),
    githubRepo,
    allowedChannels,
    // PascalCase the slug so the stack reads as "SlackDev-MyThing" in the console.
    stackName: `SlackDev-${name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())}`,
    ssmPrefix: `/slack-dev/${name}`,
    imageName: `slack-dev-${name}`,
  };
}
