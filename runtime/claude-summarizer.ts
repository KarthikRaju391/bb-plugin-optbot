import { spawn } from "node:child_process";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import type { ApiConversation, ApiOptions } from "./models";

/** bb/claude-code or bb/claude-code/<model>: returns the model, or null for Claude Code's default. */
export function claudeRef(value: string) {
  const match = /^bb\/claude-code(?:\/([^\s/]+))?$/.exec(value);
  if (!match) throw new Error("Select bb/claude-code or bb/claude-code/<model>.");
  return match[1] ?? null;
}

/**
 * A tool-less summarizer through the host's existing Claude Code login (no API key): one
 * `claude --print` call per attempt with no tools, no MCP servers, no settings and no saved
 * session. Size feedback replays the earlier candidate in the next prompt, since each call is fresh.
 */
export function claudeConversation(blocks: { text: string }[], options: ApiOptions): ApiConversation & { close(): void } {
  let dialogue = blocks.map(block => block.text).join("\n\n"), last = "";
  const children = new Set<ReturnType<typeof spawn>>();
  async function run(prompt: string) {
    options.signal.throwIfAborted();
    const executable = options.env.OPTBOT_CLAUDE_EXECUTABLE || await experimental_resolveExecutablePath("claude");
    if (!executable) throw new Error("Install and sign into Claude Code on this BB machine; no API key is required.");
    const model = claudeRef(options.model);
    const args = ["--print", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt", options.system, ...(model ? ["--model", model] : [])];
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child);
      let out = "";
      const abort = () => { child.kill("SIGTERM"); reject(new Error("Claude summary cancelled")); };
      options.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", () => {}); // may hold account details; never logged
      child.on("error", () => reject(new Error("Could not launch Claude Code on this machine")));
      child.on("close", code => {
        children.delete(child); options.signal.removeEventListener("abort", abort);
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new Error(`Claude Code summary failed (exit ${code}); check its login and usage limits`));
      });
      child.stdin.end(prompt);
    });
  }
  return {
    addUser() { throw new Error("Use ask(message) for summarizer feedback"); },
    addResult() { throw new Error("Summarizer tools are disabled"); },
    close() { for (const child of children) child.kill("SIGTERM"); },
    async ask(feedback) {
      if (feedback) dialogue += `\n\nYour previous answer:\n${last}\n\n${feedback}`;
      last = await run(dialogue);
      return { text: last, thoughts: [], calls: [] };
    },
  };
}
