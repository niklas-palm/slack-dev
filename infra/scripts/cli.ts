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

