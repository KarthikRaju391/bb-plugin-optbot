import { spawn } from "node:child_process";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import type { ApiConversation, ApiOptions } from "./models";

type Cli = "claude-code" | "pi";
// The CLI's last error line, without email addresses or token-like strings, for logs and turn errors.
function reason(stderr: string) {
  const line = stderr.split("\n").map(l => l.trim()).filter(l => l && !/^Warning: Extension/.test(l)).at(-1);
  return line ? `: ${line.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").slice(0, 200)}` : "";
}
/** bb/claude-code[/<model>] or bb/pi[/<provider>/<model>]: the CLI and its model (null: the CLI's default). */
export function cliRef(value: string): { cli: Cli; model: string | null } {
  const match = /^bb\/(claude-code|pi)(?:\/(.+))?$/.exec(value);
  if (!match || /\s/.test(match[2] ?? "")) throw new Error("Select bb/claude-code[/<model>] or bb/pi[/<provider>/<model>].");
  return { cli: match[1] as Cli, model: match[2] ?? null };
}
// Each CLI runs one prompt with no tools, no extensions/MCP/skills, no settings and no saved session.
function invocation(cli: Cli, model: string | null, system: string) {
  if (cli === "claude-code") return { bin: "claude", env: "OPTBOT_CLAUDE_EXECUTABLE", args: ["--print", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt", system, ...(model ? ["--model", model] : [])] };
  // Pi: the spec's medium effort unless the model pattern names a thinking level.
  return { bin: "pi", env: "OPTBOT_PI_EXECUTABLE", args: ["--print", "--mode", "text", "--no-tools", "--no-extensions", "--no-skills", "--no-session", "--system-prompt", system, ...(model ? ["--model", model.includes(":") ? model : `${model}:medium`] : [])] };
}

/**
 * A tool-less summarizer through the host's existing Claude Code or Pi login (no API key): one
 * print-mode call per attempt. Size feedback replays the earlier candidate, since each call is fresh.
 */
export function cliConversation(blocks: { text: string }[], options: ApiOptions): ApiConversation & { close(): void } {
  let dialogue = blocks.map(block => block.text).join("\n\n"), last = "";
  const children = new Set<ReturnType<typeof spawn>>();
  async function run(prompt: string) {
    options.signal.throwIfAborted();
    const { cli, model } = cliRef(options.model), { bin, env, args } = invocation(cli, model, options.system);
    const executable = options.env[env] || await experimental_resolveExecutablePath(bin);
    if (!executable) throw new Error(`Install and sign into ${bin} on this BB machine; no API key is required.`);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child);
      let out = "";
      const abort = () => { child.kill("SIGTERM"); reject(new Error("Summary cancelled")); };
      options.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => { out += chunk; });
      let err = "";
      child.stderr.on("data", chunk => { err = (err + chunk).slice(-4000); });
      child.on("error", () => reject(new Error(`Could not launch ${executable} on this machine`)));
      child.on("close", code => {
        children.delete(child); options.signal.removeEventListener("abort", abort);
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new Error(`${options.model} summary failed (exit ${code})${reason(err)}; check that ${executable} is signed in on the compactor machine and within its usage limits`));
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
