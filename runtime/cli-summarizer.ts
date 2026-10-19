import { spawn } from "node:child_process";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import type { ApiConversation, ApiOptions } from "./models";

type Cli = "claude-code" | "pi";
// One print-mode call normally takes seconds; a CLI that hangs (for example a version-manager wrapper
// script waiting on its own setup) must fail the summary so it is retried, not block memory forever.
export const CLI_CALL_TIMEOUT_MS = 90_000;
// The CLI's last error line, without email addresses or token-like strings, for logs and turn errors.
function reason(stderr: string) {
  const line = stderr.split("\n").map(l => l.trim()).filter(l => l && !/^Warning: Extension/.test(l)).at(-1);
  return line ? `: ${line.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").slice(0, 200)}` : "";
}
function stop(child: ReturnType<typeof spawn>) {
  try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}
/** bb/claude-code[/<model>] or bb/pi[/<provider>/<model>]: the CLI and its model (null: the CLI's default). */
export function cliRef(value: string): { cli: Cli; model: string | null } {
  const match = /^bb\/(claude-code|pi)(?:\/(.+))?$/.exec(value);
  if (!match || /\s/.test(match[2] ?? "")) throw new Error("Select bb/claude-code[/<model>] or bb/pi[/<provider>/<model>].");
  return { cli: match[1] as Cli, model: match[2] ?? null };
}
// Each CLI runs one prompt with no tools (Claude at xhigh effort, as the spec runs Haiku), no extensions/MCP/skills, no settings and no saved session.
function invocation(cli: Cli, model: string | null, system: string) {
  if (cli === "claude-code") return { bin: "claude", env: "OPTBOT_CLAUDE_EXECUTABLE", args: ["--print", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt", system, "--effort", "xhigh", ...(model ? ["--model", model] : [])] };
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
    const timeoutMs = Number(options.env.OPTBOT_SUMMARY_TIMEOUT_MS) || CLI_CALL_TIMEOUT_MS;
    return new Promise<string>((resolve, reject) => {
      // Its own process group, so a wrapper and everything it started are stopped together.
      const child = spawn(executable, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      children.add(child);
      let out = "", err = "", done = false;
      const finish = (error: Error | null, text = "") => {
        if (done) return;
        done = true; clearTimeout(timer); children.delete(child); options.signal.removeEventListener("abort", abort);
        if (error) { stop(child); reject(error); } else resolve(text);
      };
      const abort = () => finish(new Error("Summary cancelled"));
      const timer = setTimeout(() => finish(new Error(`${options.model} summary timed out after ${Math.round(timeoutMs / 1000)} s: ${executable} gave no answer${reason(err)}. If it is a wrapper script, set OptBot's compactorExecutable setting to the real ${bin} binary`)), timeoutMs);
      options.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", chunk => { err = (err + chunk).slice(-4000); });
      child.on("error", () => finish(new Error(`Could not launch ${executable} on this machine`)));
      child.on("close", code => {
        if (code === 0) finish(null, out.trim()); // an empty answer is no line: the caller clips the source
        else finish(new Error(`${options.model} summary failed (exit ${code})${reason(err)}; check that ${executable} is signed in on the compactor machine and within its usage limits`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }
  return {
    addUser() { throw new Error("Use ask(message) for summarizer feedback"); },
    addResult() { throw new Error("Summarizer tools are disabled"); },
    close() { for (const child of children) stop(child); },
    async ask(feedback) {
      if (feedback) dialogue += `\n\nYour previous answer:\n${last}\n\n${feedback}`;
      last = await run(dialogue);
      return { text: last, thoughts: [], calls: [] };
    },
  };
}
