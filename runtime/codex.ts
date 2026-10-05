import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { z } from "zod";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelBoundary, ModelEvent, ModelOptions } from "./turn";
import type { ApiConversation, ApiOptions } from "./models";
import { capResult } from "./cache";
import { MASTER, VIEW_DOC } from "./prompts";

type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: unknown };
export function codexRef(value: string) {
  const match = /^bb\/codex(?:\/([^\s/]+))?$/.exec(value);
  if (!match) throw new Error("Select bb/codex or bb/codex/<model>. Other BB runtimes are not yet supported by this adapter.");
  return match[1] ?? null;
}
/** Uses the same app-server protocol and host login as BB's Codex provider.
 * No credential files, private BB imports, persisted sessions or BB threads. */
async function connection(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  signal.throwIfAborted();
  const executable = env.OPTBOT_CODEX_EXECUTABLE || await experimental_resolveExecutablePath("codex");
  signal.throwIfAborted();
  if (!executable) throw new Error("Install and sign into Codex on this BB machine; no API key is required.");
  const child = spawn(executable, ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let serial = 0, closed = false, failure: Error | undefined, wake: (() => void) | undefined;
  const frames: Frame[] = [], pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const send = (frame: Frame) => { if (failure) throw failure; if (closed) throw new Error("Codex connection closed"); child.stdin.write(JSON.stringify(frame) + "\n"); };
  const fail = (error: Error) => { failure ??= error; for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); } pending.clear(); wake?.(); };
  // Stderr can contain credentials/provider bodies: drain it, never log it.
  child.stderr.on("data", () => {});
  child.on("error", () => fail(new Error("Could not launch Codex on this execution machine")));
  child.on("exit", () => { if (!closed) fail(new Error("Codex exited before completing the request")); });
  lines.on("line", line => {
    if (line.length > 8_000_000) { fail(new Error("Codex frame exceeds the transport limit")); return; }
    let frame: Frame; try { frame = JSON.parse(line); } catch { fail(new Error("Invalid Codex JSON-RPC frame")); return; }
    if (frame.id !== undefined && !frame.method) {
      const job = pending.get(Number(frame.id)); if (!job) return;
      pending.delete(Number(frame.id)); clearTimeout(job.timer);
      // Never include raw vendor errors in durable bot memory.
      if (frame.error) job.reject(new Error("Codex request failed; check host login, selected model and runtime version")); else job.resolve(frame.result);
    } else { frames.push(frame); wake?.(); }
  });
  function request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 60_000);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  function close() {
    if (closed) return; closed = true; signal.removeEventListener("abort", abort);
    fail(new Error("Codex connection closed")); lines.close(); child.stdin.destroy(); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000); timer.unref(); child.once("exit", () => clearTimeout(timer));
  }
  const abort = () => { fail(new Error("Codex request cancelled")); close(); };
  signal.addEventListener("abort", abort, { once: true });
  const next = async (): Promise<Frame> => { while (!frames.length) { if (failure) throw failure; await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; } return frames.shift()!; };
  try { await request("initialize", { clientInfo: { name: "optbot", version: "0.1.0" }, capabilities: { experimentalApi: true } }); send({ method: "initialized", params: {} }); }
  catch (error) { close(); throw error; }
  return { request, send, next, close, push(frame: Frame) { frames.push(frame); wake?.(); } };
}
export async function codexModels(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const rpc = await connection(env, signal);
  try {
    const models: { id: string; displayName: string; isDefault: boolean }[] = []; let cursor: string | null = null;
    do {
      const result = z.object({ data: z.array(z.object({ model: z.string(), displayName: z.string(), isDefault: z.boolean() })), nextCursor: z.string().nullable() }).parse(await rpc.request("model/list", { cursor, includeHidden: false }));
      models.push(...result.data.map(model => ({ id: `bb/codex/${model.model}`, displayName: `BB Codex — ${model.displayName}`, isDefault: false }))); cursor = result.nextCursor;
    } while (cursor);
    return models;
  } finally { rpc.close(); }
}
async function session(options: ApiOptions & { cwd?: string }) {
  const rpc = await connection(options.env, options.signal);
  try {
    const result = await rpc.request("thread/start", { model: codexRef(options.model), cwd: options.cwd ?? tmpdir(), ephemeral: true,
      baseInstructions: options.system, developerInstructions: "Use only the supplied dynamic tools. Do not delegate or spawn agents.",
      approvalPolicy: "never", sandbox: "read-only", environments: [], selectedCapabilityRoots: [],
      config: { web_search: "disabled", "features.multi_agent": false, "features.memories": false, "features.code_mode": false },
      dynamicTools: (options.tools ?? []).map(tool => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema, deferLoading: false })) });
    const thread = z.object({ thread: z.object({ id: z.string() }) }).parse(result).thread.id;
    return { rpc, thread };
  } catch (error) { rpc.close(); throw error; }
}
const userInput = (text: string) => [{ type: "text", text, text_elements: [] }];
async function* turn(state: Awaited<ReturnType<typeof session>>, prompt: string, options: ApiOptions, incoming?: ModelOptions["incoming"], deferred: { id: string; text: string }[] = []): AsyncGenerator<ModelEvent> {
  const { rpc, thread } = state;
  const start = await rpc.request("turn/start", { threadId: thread, input: userInput(prompt), effort: "medium", summary: "auto" });
  const turnId = z.object({ turn: z.object({ id: z.string() }) }).parse(start).turn.id;
  let final = "";
  const tick = incoming ? setInterval(() => rpc.push({ method: "optbot/tick" }), 100) : undefined;
  try {
    for (;;) {
      options.signal.throwIfAborted(); const frame = await rpc.next(), p = frame.params;
      if (p?.threadId && p.threadId !== thread) continue;
      if (p?.turnId && p.turnId !== turnId) continue;
      if (frame.method === "item/tool/call" && frame.id !== undefined) {
        const id = String(p.callId), tool = options.tools?.find(tool => tool.name === p.tool);
        yield { kind: "tool", id, name: String(p.tool), input: p.arguments };
        let text: string, error = false;
        try {
          if (!tool || !p.arguments || typeof p.arguments !== "object" || Array.isArray(p.arguments)) throw new Error("Unknown, disallowed or invalid tool request");
          const output = await tool.execute(p.arguments); text = output.content.map(part => part.text).join("\n"); error = Boolean(output.isError);
        } catch { text = "Tool execution failed; no result is available"; error = true; }
        text = capResult(text); yield { kind: "echo", id, text, error };
        rpc.send({ id: frame.id, result: { contentItems: [{ type: "inputText", text }], success: !error } });
      } else if (frame.id !== undefined && frame.method) {
        rpc.send({ id: frame.id, error: { code: -32601, message: "Unsupported request; only explicit OptBot tools are permitted" } });
      } else if (frame.method === "item/completed") {
        const item = p.item;
        if (item.type === "agentMessage") { final = String(item.text); yield { kind: "talk", id: String(item.id), text: final }; }
        else if (item.type === "reasoning") { const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n"); if (text) yield { kind: "thought", id: String(item.id), text }; }
        else if (["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall"].includes(item.type)) throw new Error("Codex used an unexpected native tool; upgrade the runtime to support environment-disabled OptBot sessions");
      } else if (frame.method === "turn/completed" && p.turn.id === turnId) {
        if (p.turn.status !== "completed") throw new Error(`Codex turn ${p.turn.status}; check login, limits and model availability`);
        yield { kind: "result", success: true, text: final }; return;
      }
      for (const message of incoming?.() ?? []) {
        // Accepted inputs are emitted only after the native runtime accepts them.
        try { await rpc.request("turn/steer", { threadId: thread, expectedTurnId: turnId, clientUserMessageId: message.id, input: userInput(message.text) }); }
        catch { options.signal.throwIfAborted(); deferred.push(message); continue; }
        yield { kind: "user", ...message };
      }
    }
  } finally { if (tick) clearInterval(tick); }
}
export const codexModel: ModelBoundary = {
  async *stream(prompt, options) {
    const state = await session({ ...options, system: `${MASTER}\n\n${VIEW_DOC}\n\n${options.instructions}` });
    try {
      let input = prompt;
      for (;;) {
        let result: Extract<ModelEvent, { kind: "result" }> | undefined;
        const deferred: { id: string; text: string }[] = [];
        for await (const event of turn(state, input, { ...options, system: options.instructions }, options.incoming, deferred)) { if (event.kind === "result") result = event; else yield event; }
        const messages = [...deferred, ...(options.incoming?.() ?? [])];
        if (!messages.length) { if (!result) throw new Error("Codex exited without a result"); yield result; return; }
        for (const message of messages) yield { kind: "user", ...message }; input = messages.map(message => message.text).join("\n\n");
      }
    } finally { state.rpc.close(); }
  },
  async summarize(prompt, options) {
    const dialogue = codexConversation([{ text: prompt }], { ...options, system: options.instructions });
    try { return (await dialogue.ask()).text; } finally { dialogue.close(); }
  },
};
export function codexConversation(blocks: { text: string }[], options: ApiOptions): ApiConversation & { close(): void } {
  let state: Awaited<ReturnType<typeof session>> | undefined;
  return { addUser() { throw new Error("Use ask(message) for native compactor feedback"); }, addResult() { throw new Error("Native compactor tools are disabled"); },
    close() { state?.rpc.close(); }, async ask(message) {
      state ??= await session({ ...options, tools: [] }); let text = "";
      for await (const event of turn(state, message ?? blocks.map(block => block.text).join("\n\n"), { ...options, tools: [] })) if (event.kind === "result") text = event.text;
      return { text, thoughts: [], calls: [] };
    } };
}
