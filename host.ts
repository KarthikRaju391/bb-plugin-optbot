import { randomUUID } from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {join} from "node:path";
import { z } from "zod";
import {
  experimental_defineProviderBridge, createBridgeIo, bridgeRequestEnvelopeSchema,
  initializeParamsSchema, threadStartParamsSchema, threadResumeParamsSchema,
  turnStartParamsSchema, turnSteerParamsSchema, threadStopParamsSchema, threadDeltaSchema,
  decodeToolCallResponsePayload, sanitizeInheritedChildProcessEnv,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { apiModel } from "./runtime/models";
import { workspaceTools } from "./runtime/workspace";
import { runOptChatTurn, type ModelBoundary, type ModelEvent, type ModelOptions } from "./runtime/turn";

export function createOptBotBridge(deps: { model?: ModelBoundary; write?: (line: string) => void } = {}) {
  const io = createBridgeIo<unknown>({ write: deps.write });
  const sessions = new Map<string, z.infer<typeof threadStartParamsSchema> & { providerThreadId: string }>();
  type State={controller:AbortController;released:boolean;requestId:string;providerTurnId?:string;model:string;promptMode?:"plan";incoming:{id:string;text:string}[];received:Map<string,string>};
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`BB tool ${tool} timed out`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      io.send({ jsonrpc: "2.0", id, method: "item/tool/call", params: { threadId, providerThreadId: session.providerThreadId, turnId: providerTurnId, callId: id, tool, arguments: input } });
    });
  }
  async function memory(threadId: string, input: Record<string, unknown>, turn: string) {
    const result = decodeToolCallResponsePayload(await call(threadId, "optbot_chat", input, turn));
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
      if (params.options.permissionMode !== "full") throw new Error("OptBot executes workspace tools only with explicit Full access; it never silently escalates another mode");
      const instructionFiles:string[]=[];
      if(session.instructionMode==="append")for(const name of ["AGENTS.md","CLAUDE.md"]){
        const path=join(session.cwd,name);
        try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error(`${name} must be a regular instruction file`);instructionFiles.push(`${name}\n${await readFile(path,"utf8")}`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      }
      const options:ModelOptions={
        cwd:session.cwd,model:params.options.model??"sonnet",instructions:[...instructionFiles,params.options.instructions??session.options.instructions??""].join("\n\n"),
        permissionMode:params.options.promptMode==="plan"?"plan":"full",
        env:{...sanitizeInheritedChildProcessEnv({env:process.env}),...session.options.envVars,...params.options.envVars},signal:state.controller.signal,
        incoming:()=>state.incoming.splice(0),
        tools:(session.dynamicTools??[]).filter(tool=>tool.name!=="optbot_chat"&&(params.options.promptMode!=="plan"||["optbot_read_state","optbot_memory"].includes(tool.name))).map(entry=>({...entry,execute:async(input)=>{const response=decodeToolCallResponsePayload(await call(params.threadId,entry.name,input,providerTurnId));return {content:[{type:"text" as const,text:response.content}],isError:response.isError};}})),
      };
      if(!deps.model) {
        const navigation=[{name:"zoom",description:"Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",parameters:z.object({id:z.number().int().nonnegative(),n:z.number().int().positive()}).strict()},
          {name:"date",description:"The date and time of message id.",parameters:z.object({id:z.number().int().nonnegative()}).strict()}].map(entry=>({name:entry.name,description:entry.description,inputSchema:z.toJSONSchema(entry.parameters),execute:async(input:Record<string,unknown>)=>{const parsed=entry.parameters.parse(input);const value=await memory(params.threadId,{action:entry.name,start:parsed.id,...("n" in parsed?{count:parsed.n}:{})},providerTurnId);return {content:[{type:"text" as const,text:String(value)}]};}}));
        options.tools=[...new Map([...workspaceTools(options),...options.tools,...navigation].map(tool=>[tool.name,tool])).values()];
      }
      await runOptChatTurn({
        call: (input) => memory(params.threadId, input, providerTurnId), model,
        requestId: params.clientRequestId,
        background: !deps.model,
        input: params.input.map((block) => block.type === "text" ? block.text : block.type === "localFile" || block.type === "localImage" ? `Attached ${block.type === "localImage" ? "image" : "file"} on this execution machine: ${JSON.stringify({ path: block.path, ...(block.type === "localFile" ? { name: block.name } : {}) })}. Inspect it with your file tools if the current request requires it.` : "").join("\n\n"),
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
      } else if (req.method === "model/list") {
        io.sendResult(req.id, { models: [...["sonnet", "opus", "haiku"].map((id) => ({ id, displayName: `Anthropic ${id}`, isDefault: id === "sonnet" })),{id:"openai/gpt-5.6",displayName:"OpenAI GPT-5.6",isDefault:false}] });
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
        const state:State = { controller: new AbortController(), released: false,requestId:params.clientRequestId,model:params.options.model??"sonnet",promptMode:params.options.promptMode,incoming:[],received:new Map([[params.clientRequestId,params.input.map(block=>block.type==="text"?block.text:"").join("\n\n")]]) };
        active.set(params.threadId, state);
        io.sendResult(req.id, {});
        void run(params, state);
      } else if(req.method==="turn/steer") {
        const params=turnSteerParamsSchema.parse(req.params),state=active.get(params.threadId),session=sessions.get(params.threadId);
        if(!state||!session||session.providerThreadId!==params.providerThreadId||state.providerTurnId!==params.expectedTurnId||state.controller.signal.aborted)throw new Error("The expected OptBot turn is no longer active; queue this input for the next turn");
        if(params.options.permissionMode!=="full"||params.options.promptMode!==state.promptMode||(params.options.model!==undefined&&params.options.model!==state.model))throw new Error("Model and permission changes take effect on a fresh turn, not during steering");
        if(params.input.some(block=>block.type!=="text"))throw new Error("Mid-turn steering currently requires text input");
        const text=params.input.map(block=>block.type==="text"?block.text:"").join("\n\n"),prior=state.received.get(params.clientRequestId);
        if(prior!==undefined&&prior!==text)throw new Error("A client request ID cannot be reused with different input");
        if(prior===undefined){await memory(params.threadId,{action:"enqueue",requestId:params.clientRequestId,parentId:state.requestId,text},state.providerTurnId);state.received.set(params.clientRequestId,text);if(active.get(params.threadId)===state&&!state.controller.signal.aborted)state.incoming.push({id:params.clientRequestId,text});}
        io.sendResult(req.id,{});
      } else if (req.method === "thread/stop") {
        const params = threadStopParamsSchema.parse(req.params);
        const state = active.get(params.threadId);
        if (state) { state.released = params.intent === "release"; state.controller.abort(); }
        io.sendResult(req.id, {});
      } else io.sendError(req.id, -32601, `Unsupported method: ${req.method}`);
    } catch (error) { io.sendError(req.id, error instanceof z.ZodError ? -32602 : -32000, error instanceof Error ? error.message : String(error)); }
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
