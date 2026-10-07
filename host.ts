import { randomUUID } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { modelHostContract } from "./runtime/host-contract";
import { compactNode } from "./lib/compactor";
import {lstat,readFile} from "node:fs/promises";
import {join} from "node:path";
import { z } from "zod";
import {
  experimental_defineProviderBridge, createBridgeIo, bridgeRequestEnvelopeSchema,
  initializeParamsSchema, modelListParamsSchema, threadStartParamsSchema, threadResumeParamsSchema,
  turnStartParamsSchema, turnSteerParamsSchema, threadStopParamsSchema, threadDeltaSchema,
  decodeToolCallResponsePayload, sanitizeInheritedChildProcessEnv, BRIDGE_JSON_RPC_ERRORS,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { apiModel } from "./runtime/models";
import { bbWorkerModel } from "./runtime/bb";
import { cachedCatalog, type Catalog } from "./runtime/bb-catalog";
import { workspaceTools } from "./runtime/workspace";
import { runOptChatTurn, type ModelBoundary, type ModelEvent, type ModelOptions } from "./runtime/turn";

// Ownership proof stays in BB input for server dispatch/configuration, not user memory.
function memoryInput<T extends { type: string; text?: string; visibility?: string }>(input: T[]): T[] {
  return input.filter(block => !(block.type === "text" && block.visibility === "agent-only" && /^\[bb-bot-start:([a-f0-9-]{36})\]/.test(block.text ?? "")));
}

// Memory actions that are safe to repeat after a lost reply: keyed, idempotent or read-only.
// begin and finish are excluded: repeating them after a lost success would misreport the turn.
const RETRYABLE_MEMORY = new Set(["heartbeat", "record", "input", "checkpoint", "view", "settled", "work", "merge", "zoom", "date", "enqueue"]);
class ToolTimeout extends Error {}
class NoActiveTurn extends Error {}
type InputBlock = { type: string; text?: string; path?: string; name?: string; visibility?: string };
// The user's input as text: attachments become a note the worker can act on with its file tools.
function describeInput(blocks: readonly InputBlock[]) {
  return memoryInput([...blocks]).map(block => block.type === "text" ? block.text ?? ""
    : block.type === "localFile" || block.type === "localImage" ? `Attached ${block.type === "localImage" ? "image" : "file"} on this execution machine: ${JSON.stringify({ path: block.path, ...(block.type === "localFile" ? { name: block.name } : {}) })}. Inspect it with your file tools if the current request requires it.`
    : `[An attachment of type ${block.type} was sent; OptBot can only pass text and local files to the worker.]`).join("\n\n");
}

export function createOptBotBridge(deps: { model?: ModelBoundary; write?: (line: string) => void; toolTimeoutMs?: number; catalog?: () => Promise<Catalog> } = {}) {
  const catalog = deps.catalog ?? cachedCatalog();
  const io = createBridgeIo<unknown>({ write: deps.write });
  const sessions = new Map<string, z.infer<typeof threadStartParamsSchema> & { providerThreadId: string }>();
  type State={controller:AbortController;released:boolean;requestId:string;providerTurnId?:string;model:string;permissionMode:ModelOptions["permissionMode"];promptMode?:"plan";incoming:{id:string;text:string}[];received:Map<string,string>};
  const active = new Map<string, State>();
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const model = deps.model ?? apiModel;
  function notify(method: string, params: unknown) { io.send({ jsonrpc: "2.0", method, params }); }
  function delta(threadId: string, deltas: ThreadDelta[]) {
    for (const item of deltas) threadDeltaSchema.parse(item);
    notify("thread/delta", { threadId, deltas });
  }
  function call(threadId: string, tool: string, input: Record<string, unknown>, providerTurnId: string) {
    const session = sessions.get(threadId)!;
    const id = `optbot-${randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new ToolTimeout(`BB tool ${tool} timed out`)); }, deps.toolTimeoutMs ?? 30_000);
      pending.set(id, { resolve, reject, timer });
      io.send({ jsonrpc: "2.0", id, method: "item/tool/call", params: { threadId, providerThreadId: session.providerThreadId, turnId: providerTurnId, callId: id, tool, arguments: input } });
    });
  }
  // A slow or lost reply should not fail the whole turn when the request is safe to repeat.
  async function callRetrying(threadId: string, tool: string, input: Record<string, unknown>, turn: string, retryable: boolean) {
    for (let attempt = 1; ; attempt++) {
      try { return await call(threadId, tool, input, turn); }
      catch (error) { if (!(error instanceof ToolTimeout) || !retryable || attempt === 3) throw error; }
    }
  }
  async function memory(threadId: string, input: Record<string, unknown>, turn: string) {
    const result = decodeToolCallResponsePayload(await callRetrying(threadId, "optbot_chat", input, turn, RETRYABLE_MEMORY.has(String(input.action))));
    if (result.isError) throw new Error(result.content);
    return JSON.parse(result.content) as unknown;
  }
  async function run(params: z.infer<typeof turnStartParamsSchema>, state: State) {
    const session = sessions.get(params.threadId)!;
    const providerTurnId = randomUUID();
    state.providerTurnId=providerTurnId;
    const tools = new Map<string, Extract<ModelEvent, { kind: "tool" }>>();
    delta(params.threadId, [{ kind: "input.accepted", clientRequestId: params.clientRequestId, providerTurnId }, { kind: "turn.open", providerTurnId }]);
    const onEvent = (event: ModelEvent) => {
      if (state.released) return;
      if (event.kind === "result") return;
      const key = { providerItemId: `${providerTurnId}:${event.id}` };
      if (event.kind === "user") {
        delta(params.threadId, [{kind:"input.accepted",clientRequestId:event.id,providerTurnId}]);
      } else if (event.kind === "thought") {
        const item = { type: "reasoning" as const, content: [event.text], summary: [] };
        delta(params.threadId, [{kind:"item.open",key,item,providerTurnId},{kind:"item.close",key,item,status:"completed",providerTurnId}]);
      } else if (event.kind === "talk") {
        const item = { type: "agentMessage" as const, text: event.text };
        delta(params.threadId, [{ kind: "item.open", key, item, providerTurnId }, { kind: "item.close", key, item, status: "completed", providerTurnId }]);
      } else if (event.kind === "tool") {
        tools.set(event.id, event);
        delta(params.threadId, [{ kind: "item.open", key, item: { type: "tool", tool: event.name, args: event.input }, providerTurnId }]);
      } else if (event.kind === "echo") {
        const tool = tools.get(event.id);
        if (tool) delta(params.threadId, [{ kind: "item.close", key, item: { type: "tool", tool: tool.name, args: tool.input, result: event.text }, resultText: event.text, status: event.error ? "failed" : "completed", providerTurnId }]);
      }
    };
    try {
      if (params.input.some((block) => block.type === "image")) throw new Error("OptBot currently supports text and local attachments; use a local image path instead of an inline/remote image");
      if (!params.options.model?.startsWith("bb/") && params.options.permissionMode !== "full") throw new Error("Direct API OptBot tools require explicit Full access; OptBot never silently escalates permissions. Choose a BB provider for native permissions");
      if (!params.options.model?.startsWith("bb/") && (params.options.serviceTier==="fast" || (params.options.reasoningLevel && params.options.reasoningLevel!=="medium"))) throw new Error("These execution controls require a native BB provider; direct API transports only support standard tier and medium reasoning.");
      const instructionFiles:string[]=[];
      if(session.instructionMode==="append")for(const name of ["AGENTS.md","CLAUDE.md"]){
        const path=join(session.cwd,name);
        try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error(`${name} must be a regular instruction file`);instructionFiles.push(`${name}\n${await readFile(path,"utf8")}`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      }
      const options:ModelOptions={
        cwd:session.cwd,model:params.options.model??"bb/codex",instructions:[...instructionFiles,params.options.instructions??session.options.instructions??""].join("\n\n"),
        permissionMode:params.options.promptMode==="plan"?"plan":params.options.permissionMode,
        reasoningLevel:params.options.reasoningLevel,serviceTier:params.options.serviceTier,
        env:{...sanitizeInheritedChildProcessEnv({env:process.env}),...session.options.envVars,...params.options.envVars},signal:state.controller.signal,
        incoming:()=>state.incoming.splice(0),
        tools:(session.dynamicTools??[]).filter(tool=>!["optbot_chat","optbot_worker"].includes(tool.name)&&(params.options.promptMode!=="plan"||["optbot_read_state","optbot_memory"].includes(tool.name))).map(entry=>({...entry,execute:async(input)=>{const response=decodeToolCallResponsePayload(await call(params.threadId,entry.name,input,providerTurnId));return {content:[{type:"text" as const,text:response.content}],isError:response.isError};}})),
      };
      if(!deps.model && !options.model.startsWith("bb/")) {
        const navigation=[{name:"zoom",description:"Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",parameters:z.object({id:z.number().int().nonnegative(),n:z.number().int().positive()}).strict()},
          {name:"date",description:"The date and time of message id.",parameters:z.object({id:z.number().int().nonnegative()}).strict()}].map(entry=>({name:entry.name,description:entry.description,inputSchema:z.toJSONSchema(entry.parameters),execute:async(input:Record<string,unknown>)=>{const parsed=entry.parameters.parse(input);const value=await memory(params.threadId,{action:entry.name,start:parsed.id,...("n" in parsed?{count:parsed.n}:{})},providerTurnId);return {content:[{type:"text" as const,text:String(value)}]};}}));
        options.tools=[...new Map([...workspaceTools(options),...options.tools,...navigation].map(tool=>[tool.name,tool])).values()];
      }
      await runOptChatTurn({
        call: (input) => memory(params.threadId, input, providerTurnId), model: !deps.model && options.model.startsWith("bb/") ? bbWorkerModel(async(input)=>{
          const result=decodeToolCallResponsePayload(await callRetrying(params.threadId,"optbot_worker",input,providerTurnId,input.action==="poll"));
          if(result.isError)throw new Error(result.content);
          return JSON.parse(result.content);
        }) : model,
        requestId: params.clientRequestId,
        background: !deps.model,
        input: describeInput(params.input),
        options, onEvent,
      });
      if (!state.released) delta(params.threadId, [{ kind: "turn.boundary", providerTurnId, status: "completed" }]);
    } catch (error) {
      if (!state.released) delta(params.threadId, [{ kind: "turn.boundary", providerTurnId, status: state.controller.signal.aborted ? "interrupted" : "failed", error: { message: error instanceof Error ? error.message : String(error) } }]);
    } finally { if (active.get(params.threadId) === state) active.delete(params.threadId); }
  }
  async function request(raw: unknown) {
    const parsed = bridgeRequestEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      const id = raw && typeof raw === "object" && "id" in raw ? (raw as { id: string }).id : null;
      if (id !== null) io.sendError(id, -32602, "Invalid request envelope");
      return;
    }
    const req = parsed.data;
    try {
      if (req.method === "initialize") {
        const params = initializeParamsSchema.parse(req.params);
        if (params.protocolVersion !== 2) throw new Error("OptBot requires provider bridge protocol 2");
        io.sendResult(req.id, { protocolVersion: 2, capabilities: { sessionRestore: true, fork: "none", grammarVersions: [2, 3], approvalEnforcedBy: "provider", steerMode: "inject", skills: { configure: false } } });
        void catalog().catch(() => {}); // warm: building it queries every installed provider
      } else if (req.method === "model/list") {
        modelListParamsSchema.parse(req.params);
        // The composer picker in OptBot conversations lists these: installed BB providers' models as bb/<provider>/<model>.
        io.sendResult(req.id, await catalog());
      } else if (req.method === "provider/health") {
        // With experimental_visibility "installed", not_installed keeps OptBot out of BB's global new-thread
        // picker and other threads' handoff tabs. OptBot conversations still run; they start from its sidebar.
        io.sendResult(req.id, { supported: true, health: { status: "not_installed", statusMessage: "OptBot conversations start from the OptBot sidebar.", accountEmail: null, canInstall: false, canUpdate: false, installedVersion: null, loginCommand: null, minimumSupportedVersion: null, planLabel: null } });
      } else if (req.method === "thread/start" || req.method === "thread/resume") {
        const params = req.method === "thread/start" ? threadStartParamsSchema.parse(req.params) : threadResumeParamsSchema.parse(req.params);
        if (active.has(params.threadId)) throw new Error("Cannot reconstruct an active OptBot conversation");
        const providerThreadId = "providerThreadId" in params ? params.providerThreadId as string : `optbot:${params.threadId}`;
        sessions.set(params.threadId, { ...params, providerThreadId });
        notify("thread/identity", { threadId: params.threadId, providerThreadId });
        delta(params.threadId, [{ kind: "session.reset" }]);
        io.sendResult(req.id, { providerThreadId });
      } else if (req.method === "turn/start") {
        const params = turnStartParamsSchema.parse(req.params);
        const session = sessions.get(params.threadId);
        if (!session || session.providerThreadId !== params.providerThreadId) throw new Error("Start or resume this OptBot conversation first");
        if (active.has(params.threadId)) throw new Error("Conversation already has an active turn");
        const state:State = { controller: new AbortController(), released: false,requestId:params.clientRequestId,model:params.options.model??"bb/codex",permissionMode:params.options.permissionMode,promptMode:params.options.promptMode,incoming:[],received:new Map([[params.clientRequestId,memoryInput(params.input).map(block=>block.type==="text"?block.text:"").join("\n\n")]]) };
        active.set(params.threadId, state);
        io.sendResult(req.id, {});
        void run(params, state);
      } else if(req.method==="turn/steer") {
        const params=turnSteerParamsSchema.parse(req.params),state=active.get(params.threadId),session=sessions.get(params.threadId);
        // A finished turn answers NO_ACTIVE_TURN so BB starts a new turn with the message instead of failing the thread.
        if(!state||!session||session.providerThreadId!==params.providerThreadId||state.providerTurnId!==params.expectedTurnId||state.controller.signal.aborted)throw new NoActiveTurn("The OptBot turn already ended; this message starts the next turn");
        // A different model or permission in the composer applies from the next turn; the message itself is delivered now.
        const text=describeInput(params.input),prior=state.received.get(params.clientRequestId);
        if(prior!==undefined&&prior!==text)throw new Error("A client request ID cannot be reused with different input");
        if(prior===undefined){await memory(params.threadId,{action:"enqueue",requestId:params.clientRequestId,parentId:state.requestId,text},state.providerTurnId);state.received.set(params.clientRequestId,text);if(active.get(params.threadId)===state&&!state.controller.signal.aborted)state.incoming.push({id:params.clientRequestId,text});}
        io.sendResult(req.id,{});
      } else if (req.method === "thread/stop") {
        const params = threadStopParamsSchema.parse(req.params);
        const state = active.get(params.threadId);
        if (state) {
          state.released = params.intent === "release";
          state.controller.abort();
          // BB may reconstruct immediately after releasing the runtime. The
          // detached turn still unwinds its lease/worker cleanup, but cannot
          // publish stale deltas or delete a newer turn's state in finally.
          if (state.released) active.delete(params.threadId);
        }
        io.sendResult(req.id, {});
      } else io.sendError(req.id, -32601, `Unsupported method: ${req.method}`);
    } catch (error) { io.sendError(req.id, error instanceof z.ZodError ? -32602 : error instanceof NoActiveTurn ? BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN : -32000, error instanceof Error ? error.message : String(error)); }
  }
  function close() {
    for (const state of active.values()) { state.released = true; state.controller.abort(); }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Bridge closed")); }
    pending.clear();
  }
  return experimental_defineProviderBridge({
    handleLine(line) {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { io.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
      if (raw && typeof raw === "object" && "id" in raw && !("method" in raw)) {
        const response = raw as { id: string; result?: unknown; error?: { message?: string } };
        const item = pending.get(response.id);
        if (item) { clearTimeout(item.timer); pending.delete(response.id); if (response.error) item.reject(new Error(response.error.message ?? "BB tool failed")); else item.resolve(response.result); }
        return;
      }
      void request(raw);
    }, onClose: close, onSigterm: close, onSigint: close,
  });
}
export const experimental_providerBridge = createOptBotBridge();
export default experimental_defineHostEntry({
  contract: modelHostContract,
  handlers: {
    async compact({ task, model }, context) {
      return compactNode(task, { model, system: "", env: sanitizeInheritedChildProcessEnv({ env: process.env }), signal: AbortSignal.any([context.signal, context.lifecycle.signal]) });
    },
  },
});
