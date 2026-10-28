import { sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/provider-bridge";
import { batchTimeout, compactBatch, compactNode, type BatchItem } from "../lib/compactor";
import type { Compression } from "../lib/optchat";

type Login = { model: string; executable?: string; poolToken?: string };
/** The summarizer CLI's environment on this host: the daemon's, or the configured binary, or Account Pooler. */
function hostEnv({ model, executable, poolToken }: Login, base: NodeJS.ProcessEnv) {
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
  return env;
}
/** The host side of the compact call: the summarizer CLI runs with the daemon's environment, or the configured binary. */
export function compactOnHost(input: Login & { task: Compression; rules?: string }, signal: AbortSignal, base: NodeJS.ProcessEnv = process.env) {
  return compactNode(input.task, { model: input.model, system: input.rules ?? "", env: hostEnv(input, base), signal });
}
/** The host side of a batch: one CLI call for many nodes, sharing one context. */
export function compactBatchOnHost(input: Login & { items: BatchItem[]; context: string; rules?: string }, signal: AbortSignal, base: NodeJS.ProcessEnv = process.env) {
  return compactBatch(input.items, input.context, { model: input.model, system: input.rules ?? "", env: hostEnv(input, base), signal, timeoutMs: batchTimeout(input.items.length) });
}
