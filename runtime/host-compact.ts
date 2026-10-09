import { sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/provider-bridge";
import { compactNode } from "../lib/compactor";
import type { Compression } from "../lib/optchat";

/** The host side of the compact call: the summarizer CLI runs with the daemon's environment, or the configured binary. */
export function compactOnHost({ task, model, executable }: { task: Compression; model: string; executable?: string }, signal: AbortSignal, base: NodeJS.ProcessEnv = process.env) {
  const env = sanitizeInheritedChildProcessEnv({ env: base });
  if (executable) env[/^bb\/claude-code/.test(model) ? "OPTBOT_CLAUDE_EXECUTABLE" : /^bb\/pi/.test(model) ? "OPTBOT_PI_EXECUTABLE" : "OPTBOT_CODEX_EXECUTABLE"] = executable;
  return compactNode(task, { model, system: "", env, signal });
}
