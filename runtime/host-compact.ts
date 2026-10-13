import { sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/provider-bridge";
import { compactNode } from "../lib/compactor";
import type { Compression } from "../lib/optchat";

/** The host side of the compact call: the summarizer CLI runs with the daemon's environment, or the configured binary. */
export function compactOnHost({ task, model, executable, poolToken }: { task: Compression; model: string; executable?: string; poolToken?: string }, signal: AbortSignal, base: NodeJS.ProcessEnv = process.env) {
  const env = sanitizeInheritedChildProcessEnv({ env: base });
  // Account Pooler, set up the way BB sets up a Claude Code thread: the real Claude Code CLI, pointed at
  // the pool's proxy on this machine's BB server, which picks and switches accounts per request.
  if (poolToken) {
    if (!/^bb\/claude-code(\/|$)/.test(model)) throw new Error("Account Pooler summaries through a CLI need a bb/claude-code model");
    if (!base.BB_SERVER_URL) throw new Error("This BB machine does not know its BB server URL, so it cannot reach Account Pooler");
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_BASE_URL = `${base.BB_SERVER_URL.replace(/\/$/, "")}/api/v1/plugins/account-pool/http`;
    env.ANTHROPIC_AUTH_TOKEN = poolToken;
  }
  if (executable) env[/^bb\/claude-code/.test(model) ? "OPTBOT_CLAUDE_EXECUTABLE" : /^bb\/pi/.test(model) ? "OPTBOT_PI_EXECUTABLE" : "OPTBOT_CODEX_EXECUTABLE"] = executable;
  return compactNode(task, { model, system: "", env, signal });
}
