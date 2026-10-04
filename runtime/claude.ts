import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { experimental_resolveExecutablePath as resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelBoundary, ModelEvent, ModelOptions } from "./turn";

/** Adapter over the documented Claude Agent SDK message unions, not a second agent loop. */
export function eventsFromClaude(message: SDKMessage): ModelEvent[] {
  if (message.type === "assistant") {
    if (message.parent_tool_use_id) return []; // Subagent internals aren't the bot's own chat.
    return message.message.content.flatMap((block, i): ModelEvent[] => {
      if (block.type === "text") return [{ kind: "talk", id: `${message.message.id}:${i}`, text: block.text }];
      if (block.type === "tool_use") return [{ kind: "tool", id: block.id, name: block.name, input: block.input }];
      return []; // Never store reasoning or signatures.
    });
  }
  if (message.type === "user" && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
    return message.message.content.flatMap((block): ModelEvent[] => block.type === "tool_result" ? [{ kind: "echo", id: block.tool_use_id, text: typeof block.content === "string" ? block.content : JSON.stringify(block.content), error: block.is_error }] : []);
  }
  if (message.type === "result") return [{ kind: "result", success: !message.is_error && message.subtype === "success", text: message.subtype === "success" ? message.result : message.errors.join("\n") }];
  return [];
}
function sdkOptions(options: Omit<ModelOptions, "tools">): Options {
  return {
    cwd: options.cwd, model: options.model, env: options.env,
    permissionMode: options.permissionMode === "plan" ? "plan" : "bypassPermissions",
    allowDangerouslySkipPermissions: options.permissionMode === "full",
    settingSources: [], persistSession: false,
    systemPrompt: { type: "preset", preset: "claude_code", append: options.instructions },
    // No SDK-relative runtime assets are assumed after BB bundles host.ts.
    // Claude reads its own login; credentials never enter plugin memory.
  };
}
function controllerFor(signal: AbortSignal) {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal });
  return controller;
}
export const claudeModel: ModelBoundary = {
  async *stream(prompt, options) {
    const executable = await resolveExecutablePath("claude");
    if (!executable) throw new Error("Install and sign into Claude Code on this execution machine before using OptBot");
    const tools = options.tools.map((entry) => {
      const schema = z.fromJSONSchema(entry.inputSchema as z.core.JSONSchema.JSONSchema);
      if (!(schema instanceof z.ZodObject)) throw new Error(`Tool ${entry.name} has a non-object schema`);
      return tool(entry.name, entry.description, schema.shape, (input) => entry.execute(input));
    });
    const controller = controllerFor(options.signal);
    try {
      for await (const message of query({ prompt, options: { ...sdkOptions(options), pathToClaudeCodeExecutable: executable, abortController: controller, mcpServers: { bb: createSdkMcpServer({ name: "bb", tools }) } } })) {
        for (const event of eventsFromClaude(message)) yield event;
      }
    } finally { controller.abort(); }
  },
  async summarize(prompt, options) {
    const executable = await resolveExecutablePath("claude");
    if (!executable) throw new Error("Install and sign into Claude Code on this execution machine before using OptBot");
    const controller = controllerFor(options.signal);
    try {
      for await (const message of query({ prompt, options: { ...sdkOptions(options), pathToClaudeCodeExecutable: executable, abortController: controller, systemPrompt: options.instructions, tools: [], maxTurns: 1 } })) {
        if (message.type !== "result") continue;
        if (message.subtype === "success" && !message.is_error) return message.result;
        throw new Error(message.subtype === "success" ? "Compactor failed" : message.errors.join("\n"));
      }
      throw new Error("Compactor exited without a result");
    } finally { controller.abort(); }
  },
};
