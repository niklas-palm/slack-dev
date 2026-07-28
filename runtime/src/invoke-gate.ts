// Should this /invoke run at all — and if not, with which status?
//
// Extracted from server.ts for one reason: server.ts starts an HTTP listener at import time, so nothing
// in it can be unit-tested. This decision is the one that used to be wrong in production, so it's the one
// that needs a test. (Same reasoning as infra/scripts/slack-setup-state.ts.)
//
// The rule behind both rejections: the ingress can only report a failure it can SEE. It reads the HTTP
// status and nothing else, so a refusal delivered inside a 200 is a silent one — the thread keeps its
// lone 👀 and the person waits for a reply that will never come.
import { NO_BOT_TOKEN } from "./slack.js";

export type InvokeGate =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * @param text   the prompt after the bot mention is stripped
 * @param hasBotToken  whether SLACK_BOT_TOKEN resolved (call AFTER retrying the SSM read)
 */
export function invokeGate(text: string, hasBotToken: boolean): InvokeGate {
  // A bare "@bot" with no text. There is nothing to work on, and 200 made the ingress log a success.
  // 4xx so the ingress stops retrying — see worthRetrying in infra/lambda/slack-events/handler.ts.
  if (!text) return { ok: false, status: 400, error: "missing 'prompt' in payload" };

  // Without a bot token the agent is MUTE: it can run a full turn, but every Slack call short-circuits,
  // so it posts no reply, no error, and no reaction. Observed live — a failed secret read at boot left a
  // VM answering into the void for its whole life. 5xx, because a re-read may well fix it.
  if (!hasBotToken) return { ok: false, status: 503, error: NO_BOT_TOKEN };

  return { ok: true };
}
