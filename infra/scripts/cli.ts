// Shared helpers for the setup scripts.
//
// These are the first thing a person sees when standing up an agent, so a configuration mistake should
// read as one sentence they can act on — not a Node stack trace. (CDK still wants the throw, so
// loadConfig keeps throwing and we catch it here.)
import { loadConfig, type AgentConfig } from "../lib/config.js";

/** Read the agent config, exiting with a plain message if it isn't usable yet. */
export function requireConfig(): AgentConfig {
  try {
    return loadConfig();
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    console.error(`\n  Edit agent.config.json, then re-run. See setup.md step 2.`);
    process.exit(1);
  }
}

/** Value after `--name` on the command line, if present. */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Reject any flag the script doesn't know, rather than ignoring it.
 *
 * These scripts create real, hard-to-undo things — a GitHub App, a Slack app — and a mistyped or
 * since-removed flag is indistinguishable from no flag at all. That is not hypothetical: a stale
 * `--store-token-only` silently became a plain run, which took the CREATE path and produced a second
 * Slack app whose signing secret overwrote the first one's. Failing loudly costs a retype; guessing
 * costs a manual cleanup in someone else's console.
 */
export function rejectUnknownFlags(known: string[]): void {
  // Walk positionally rather than filtering: the entry after a known flag is its VALUE, and a value may
  // legitimately start with "--" (`--prompt "--dry-run is failing, why?"` is a fair question to ask an
  // agent). Filtering treated that as a flag and rejected the whole command.
  const bad: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    // `--flag=value` is rejected even when `flag` is known, because arg() reads the NEXT argv entry — so
    // `--app-name=x` yields undefined and the script would quietly fall back to the config's name. A
    // recognised-but-unreadable flag is the same silent-wrong-behaviour class as an unrecognised one.
    if (a.includes("=") || !known.includes(a.slice(2))) bad.push(a);
    else i++; // skip its value, whatever it looks like
  }
  if (bad.length === 0) return;
  console.error(`✗ Unknown option(s): ${bad.join(" ")}`);
  console.error(`  Supported: ${known.map((k) => `--${k}`).join(", ")}`);
  if (bad.some((f) => f.includes("="))) {
    console.error(`  Use a space, not "=" — the value is read as the next argument.`);
  }
  process.exit(1);
}

/** Open a URL in the user's default browser. Best-effort: the script always prints the URL too. */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Imported lazily so this module stays usable in tests that never open anything.
  void import("node:child_process").then(({ spawn }) => {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    // MUST swallow 'error'. Without a listener, a missing opener (xdg-utils is absent on plenty of
    // headless/WSL hosts) is an unhandled event → uncaughtException → the script dies. In
    // create-github-app that happens AFTER the App exists and its key is in SSM, leaving a half-built
    // App that the re-run guard then refuses to fix. The URL is printed regardless, so this is cosmetic.
    child.on("error", () => {});
    child.unref();
  });
}

