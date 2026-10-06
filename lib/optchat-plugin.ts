import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createOptChat } from "./optchat";
import { openArchive } from "./archive";
import { dirname, join } from "node:path";
import { acquireCompactor, compactNode } from "./compactor";
import { modelRef } from "../runtime/models";
import { modelHostContract } from "../runtime/host-contract";
import { codexRef } from "../runtime/codex";
import type { createBbWorkers } from "./bb-workers";

export async function registerOptChat(bb: BbPluginApi, resolveOwner: (threadId: string) => Promise<string | null>, workers: ReturnType<typeof createBbWorkers>) {
  const db = bb.storage.database();
  const root=join(dirname(db.name),"chat");
  const archive = await openArchive(root, message=>bb.log.warn(message));
  const chat = createOptChat(db, { archive });
  const settings=bb.settings.define({
    compactorModel:{type:"string",label:"Compactor model",default:"bb/codex",description:"bb/codex or bb/codex/<model>: a tool-less text call through the host's existing Codex login (no API key). Prefer a small model; it runs at medium effort."},
    compactorHost:{type:"string",label:"Compactor BB machine ID",description:"Enrolled machine with an authenticated Codex login. No separate API key is required."},
    compactorApiKey:{type:"string",label:"Compactor API key",secret:true,description:"Used only by the always-on backend; never sent to the agent or stored in its history."},
    compactorEndpoint:{type:"string",label:"Optional compactor API base URL",description:"Leave empty for the provider's standard endpoint. HTTPS is required except on loopback."},
  });

  const nativeLifetime=new AbortController();
  bb.onDispose(()=>nativeLifetime.abort());
  async function nativeHostId() {
    const {compactorHost}=await settings.get();
    if (typeof compactorHost!=="string" || !compactorHost) throw new Error("Select the BB machine in OptBot's compactorHost setting");
    return compactorHost;
  }
  const modelHost=bb.hosts.experimental_client({contract:modelHostContract});
  const worker=await acquireCompactor(root,{chat,report:message=>bb.log.warn(message),async compact(task,options){
    if (!options.model.startsWith("bb/")) return compactNode(task, options);
    codexRef(options.model);
    return modelHost.call("compact",{task,model:options.model},{hostId:await nativeHostId(),signal:options.signal});
  },async options(signal){
    const {compactorModel:selected,compactorApiKey:credential,compactorEndpoint:base}=await settings.get();
    const model=typeof selected==="string"&&selected?selected:"bb/codex";
    if(model.startsWith("bb/")) {codexRef(model);return {model,env:{},signal,system:""};}
    const provider=modelRef(model).provider;
    const env={...process.env};
    if(typeof credential==="string"&&credential) env[provider==="openai"?"OPENAI_API_KEY":"ANTHROPIC_API_KEY"]=credential;
    if(typeof base==="string"&&base) env[provider==="openai"?"OPTBOT_OPENAI_BASE_URL":"OPTBOT_ANTHROPIC_BASE_URL"]=base;
    return {model,env,signal,system:""};
  }});
  const pump=worker.pump;
  bb.onDispose(async()=>{await worker.close();await archive.close();});
  const knownBots=new Set([...archive.bots(),...(db.prepare("SELECT DISTINCT bot_id FROM optchat_log").all() as {bot_id:string}[]).map(row=>row.bot_id)]);
  for(const bot of knownBots) {chat.hydrate(bot);pump(bot);}
  async function scope(threadId: string) {
    const botId = await resolveOwner(threadId);
    if (!botId) throw new Error("This conversation is not assigned to an OptBot");
    chat.hydrate(botId);
    return botId;
  }
  bb.providers.register({
    id: "optbot", displayName: "OptBot", icon: "./assets/bot.svg", family: "optbot",
    // Listed only where "installed"; the bridge always answers not_installed, so OptBot stays out of
    // BB's global picker while its own conversations keep their composer and catalog.
    experimental_visibility: "installed",
    maintenance: { health: true, usage: false, installation: false },
    // No Plan action: turns run as BB worker threads, which do not support Plan mode.
    composerActions: [],
    strings: { signInHint: "Use an installed BB provider with its existing authentication.", expiredHint: "Renew the selected BB provider's authentication.", installUrl: "https://getbb.app", brandPrefix: "OptBot " },
    capabilities: { supportsServiceTier: true, supportsNativeUserQuestion: false, fork: "none", supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ["full"], reasoningLevels: ["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"] },
    models: { scope: "host" },
  });
  const chatSchema = z.object({
    action: z.enum(["begin", "heartbeat", "checkpoint", "record", "work", "merge", "view", "finish", "settled", "zoom", "date", "input", "enqueue"]),
    requestId: z.string().min(1).max(128).optional(), lease: z.string().uuid().optional(),
    parentId:z.string().min(1).max(128).optional(),
    key: z.string().min(1).max(256).optional(), kind: z.enum(["user", "talk", "tool", "echo", "note"]).optional(),
    text: z.string().optional(), start: z.number().int().nonnegative().optional(),
    count: z.number().int().positive().optional(), status: z.enum(["completed", "failed"]).optional(),
  }).strict();
  bb.agents.registerTool({
    name: "optbot_chat", description: "Private OptBot runtime persistence protocol. Managed by the harness; not an agent-facing memory editing tool.",
    parameters: chatSchema,
    async execute(input, ctx) {
      const bot = await scope(ctx.threadId);
      function required<T>(value: T | undefined, field: string): T { if (value === undefined) throw new Error(`Missing ${field} for ${input.action}`); return value; }
      const lease = () => required(input.lease, "lease");
      let result: unknown;
      switch (input.action) {
        case "begin": result = chat.begin(bot, ctx.threadId, required(input.requestId, "requestId"), input.text); break;
        case "heartbeat": result = chat.heartbeat(bot, ctx.threadId, lease()); break;
        case "settled": {
          chat.heartbeat(bot,ctx.threadId,lease());
          result={settled:chat.settled(bot)}; break;
        }
        case "checkpoint": result = chat.checkpoint(bot, ctx.threadId, lease(), required(input.text, "text")); break;
        case "record": result = chat.record(bot, ctx.threadId, lease(), required(input.key, "key"), required(input.kind, "kind"), required(input.text, "text")); break;
        case "input": result=chat.input(bot,ctx.threadId,lease(),required(input.requestId,"requestId"),required(input.text,"text"));break;
        case "enqueue": result=chat.enqueue(bot,ctx.threadId,required(input.requestId,"requestId"),required(input.parentId,"parentId"),required(input.text,"text"));break;
        case "work": result = chat.work(bot, ctx.threadId, lease()); break;
        case "merge": result = chat.merge(bot, ctx.threadId, lease(), required(input.start, "start"), required(input.count, "count"), required(input.text, "text")); break;
        case "view": result = chat.view(bot); break;
        case "zoom": result=chat.zoomText(bot,required(input.start,"start"),required(input.count,"count")); break;
        case "date": result=chat.dateText(bot,required(input.start,"start")); break;
        case "finish": result = chat.finish(bot, ctx.threadId, lease(), required(input.status, "status"), required(input.text, "text")); break;
      }
      pump(bot);
      return JSON.stringify(result);
    },
  });
  // Spec §7.1: the agent's only memory tools are zoom and date, with the reference descriptions and output.
  bb.agents.registerTool({
    name: "optbot_memory", description: "zoom: Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. date: The date and time of message id.",
    parameters: z.object({ action: z.enum(["zoom", "date"]), start: z.number().int().nonnegative(), count: z.number().int().positive().optional() }).strict(),
    async execute(input, ctx) {
      const bot = await scope(ctx.threadId);
      return input.action === "date" ? chat.dateText(bot, input.start) : chat.zoomText(bot, input.start, input.count ?? 1);
    },
  });
  async function checkModel() {
    const {compactorModel}=await settings.get(), model=compactorModel || "bb/codex";
    codexRef(model); const hostId=await nativeHostId();
    const summary=await modelHost.call("compact",{model,task:{start:0,count:1,context:"<chat>\n\n</chat>",source:"user: This is an OptBot readiness check. Preserve OPTBOT_NATIVE_CHECK_OK."}},{hostId,signal:AbortSignal.any([nativeLifetime.signal,AbortSignal.timeout(120_000)])});
    return {model,hostId,summary};
  }
  return {...chat,wake:pump,checkModel};
}
