import { turnPrompt } from "./prompts";
import { randomUUID } from "node:crypto";
import type { Compression, MemoryKind } from "../lib/optchat";
import type {PluginProviderReasoningLevel} from "@get-bb/plugin-sdk";
import { compactNode } from "../lib/compactor";

export type ModelEvent =
  | { kind: "talk"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "echo"; id: string; text: string; error?: boolean }
  | { kind: "result"; success: boolean; text: string };
export type AgentTool = { name: string; description: string; inputSchema: unknown; execute: (input: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> };
export type ModelOptions = { cwd: string; model: string; instructions: string; permissionMode: "full" | "plan" | "auto" | "accept-edits"; reasoningLevel?:PluginProviderReasoningLevel;serviceTier?:"default"|"fast";env: NodeJS.ProcessEnv; signal: AbortSignal; tools: AgentTool[]; incoming?: (take?: { final?: boolean; notices?: boolean }) => { id: string; text: string }[]; onUsage?: (usage: unknown) => void };
/** The reason a turn's signal carries when the user stops it (not a bridge restart or a failure). */
export class UserStop extends Error { constructor() { super("Stopped by the user"); } }
export interface ModelBoundary {
  stream(prompt: string, options: ModelOptions): AsyncIterable<ModelEvent>;
  /** Tool calls the model started that have no result yet (logged as they are if the turn ends early). */
  unanswered?(): { id: string; name: string; input: unknown }[];
  summarize(prompt: string, options: Omit<ModelOptions, "tools">): Promise<string>;
}
export type MemoryCall = (input: Record<string, unknown>) => Promise<unknown>;
export function toolText(name: string, input: unknown) { return `${name} ${JSON.stringify(input)}`; }
export async function runOptChatTurn(args: {
  call: MemoryCall; model: ModelBoundary; requestId: string; input: string;
  options: ModelOptions; compactorModel?: string; onEvent: (event: ModelEvent) => void;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  background?: boolean;
}) {
  const { call, model } = args;
  const options = { ...args.options };
  const pause = args.pause ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("Turn cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  }));
  let begin: { status: string; lease?: string; result?: string; answer?: string | null };
  do {
    if (options.signal.aborted) throw new Error("Turn cancelled");
    begin = await call({ action: "begin", requestId: args.requestId, text: args.input }) as typeof begin;
    if (begin.status === "busy") await pause(1000, options.signal);
  } while (begin.status === "busy");
  if (begin.status === "completed") {
    args.onEvent({ kind: "talk", id: `replay:${args.requestId}`, text: begin.result ?? "" });
    return begin.result ?? "";
  }
  if (begin.status !== "active" || !begin.lease) throw new Error("Invalid memory lease response");
  const lease = begin.lease, attempt = randomUUID();
  const parentSignal = options.signal, modelController = new AbortController();
  const parentAbort = () => modelController.abort();
  if (parentSignal.aborted) parentAbort(); else parentSignal.addEventListener("abort", parentAbort, { once: true });
  options.signal = modelController.signal;
  let leaseError: unknown;
  let heartbeatPending = false;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    void call({ action: "heartbeat", lease }).catch((error) => { leaseError = error; modelController.abort(); }).finally(() => { heartbeatPending = false; });
  }, 10_000);
  const check = () => { if (leaseError) throw leaseError; if (options.signal.aborted) throw new Error("Turn cancelled"); };
  async function settle() {
    for (;;) {
      check();
      if(args.background) {
        const state=await call({action:"settled",lease}) as {settled:boolean;blocked?:string};
        if(state.settled) return;
        if(state.blocked) throw new Error(`Memory summaries keep failing, so this turn cannot start: ${state.blocked}. Your message is kept in the history. Fix the summarizer (OptBot settings: Compactor model / machine), then send again.`);
        await pause(100,options.signal); continue;
      }
      const task = await call({ action: "work", lease }) as Compression | null;
      if (!task) return;
      // Each try is its own call (compactNode builds its blocks, a "Too long" note included).
      const summary = await compactNode(task, { model: args.compactorModel ?? "bb/codex", env: options.env, signal: options.signal, system: "" }, (prompt, config) => ({
        async ask() { check(); return { text: await model.summarize(prompt, { ...options, model: config.model, instructions: config.system }), thoughts: [], calls: [] }; },
        addUser() {}, addResult() {},
      }));
      await call({ action: "merge", lease, start: task.start, count: task.count, text: summary });
    }
  }
  try {
    if(!args.background || begin.answer===undefined || begin.answer===null) await settle();
    if (begin.answer !== undefined && begin.answer !== null) {
      await call({ action: "finish", lease, status: "completed", text: begin.answer });
      args.onEvent({ kind: "talk", id: `recovered:${args.requestId}`, text: begin.answer });
      return begin.answer;
    }
    let view = await call({ action: "view", lease }) as { text: string; local?: string };
    await call({ action: "input", lease, requestId:args.requestId, text: args.input });
    let request = args.input, result: string | undefined;
    for (let round = 0; ; round++) {
      result = undefined;
      let lastTalk = "";
      // UniiChat Server.ts: the view, then "Turn: the user's new message:" and the message whole; OptBot puts this
      // conversation's latest messages in between when the view interleaves other conversations.
      for await (const event of model.stream(turnPrompt(view.text, view.local ?? "", request), options)) {
        check();
        if (event.kind === "result") {
          if (!event.success) throw new Error(event.text || "Model turn failed");
          result = event.text; continue;
        }
        if (event.kind === "thought") { args.onEvent(event); continue; }
        if(event.kind==="user"){await call({action:"input",lease,requestId:event.id,text:event.text});args.onEvent(event);continue;}
        const kind: MemoryKind = event.kind === "talk" ? "talk" : event.kind === "tool" ? "tool" : "echo";
        // UniiChat's log text: a call is its name and JSON input; a failed result starts "error: ".
        const text = event.kind === "tool" ? toolText(event.name, event.input) : event.kind === "echo" ? (event.error ? "error: " : "") + (event.text || "(no output)") : event.text;
        await call({ action: "record", lease, key: `${attempt}:${event.kind}:${event.id}`, kind, text });
        if (event.kind === "talk") lastTalk = event.text;
        args.onEvent(event);
      }
      if (result === undefined) throw new Error("Model exited without a completed result");
      if (result && result !== lastTalk) {
        const key = round ? `${attempt}:${round}:final` : `${attempt}:final`;
        await call({ action: "record", lease, key, kind: "talk", text: result });
        args.onEvent({ kind: "talk", id: key, text: result });
      }
      // Messages the call did not take start a new call with a fresh view, rendered before they are logged
      // (UniiChat: a call's leftover messages wait for the next call; nothing carries over but the view).
      // The last check of the turn: it takes agent notices too, and with nothing left the turn closes to new messages.
      const left = options.incoming?.({ final: true, notices: true }) ?? [];
      if (!left.length) break;
      check();
      await settle();
      view = await call({ action: "view", lease }) as { text: string; local?: string };
      for (const message of left) { await call({ action: "input", lease, requestId: message.id, text: message.text }); args.onEvent({ kind: "user", ...message }); }
      request = left.map(message => message.text).join("\n\n");
    }
    await call({ action: "checkpoint", lease, text: result });
    if(!args.background) await settle();
    check();
    await call({ action: "finish", lease, status: "completed", text: result });
    return result;
  } catch (error) {
    try {await call({action:"input",lease,requestId:args.requestId,text:args.input});} catch { /* A takeover's durable record wins. */ }
    // Calls left without a result (a stop, a failure) are logged as they are, like UniiChat's `unanswered`.
    for (const open of model.unanswered?.() ?? []) { try { await call({ action: "record", lease, key: `${attempt}:tool:${open.id}`, kind: "tool", text: toolText(open.name, open.input) }); } catch { /* best effort */ } }
    const stopped = parentSignal.reason instanceof UserStop;
    try { await call({ action: "finish", lease, status: stopped ? "stopped" : "failed", text: error instanceof Error ? error.message : String(error) }); } catch { /* Lease takeover already records interruption; never overwrite its state. */ }
    throw error;
  } finally { clearInterval(heartbeat); parentSignal.removeEventListener("abort", parentAbort); modelController.abort(); }
}
