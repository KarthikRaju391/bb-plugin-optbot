import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createOptChat } from "./optchat";
import { openArchive } from "./archive";
import { dirname, join } from "node:path";
import { acquireCompactor } from "./compactor";
import { modelRef } from "../runtime/models";

export async function registerOptChat(bb: BbPluginApi, resolveOwner: (threadId: string) => Promise<string | null>) {
  const db = bb.storage.database();
  const root=join(dirname(db.name),"chat");
  const archive = await openArchive(root, message=>bb.log.warn(message));
  const chat = createOptChat(db, { archive });
  const settings=bb.settings.define({
    compactorModel:{type:"string",label:"Compactor model (provider/model)",default:"anthropic/claude-sonnet-4-6",description:"Independent of the master model. Use a cheap, competent model at medium effort."},
    compactorApiKey:{type:"string",label:"Compactor API key",secret:true,description:"Used only by the always-on backend; never sent to the agent or stored in its history."},
    compactorEndpoint:{type:"string",label:"Optional compactor API base URL",description:"Leave empty for the provider's standard endpoint. HTTPS is required except on loopback."},
  });
  const worker=await acquireCompactor(root,{chat,report:message=>bb.log.warn(message),async options(signal){
    const {compactorModel:selected,compactorApiKey:credential,compactorEndpoint:base}=await settings.get();
    const model=typeof selected==="string"&&selected?selected:"anthropic/claude-sonnet-4-6", provider=modelRef(model).provider;
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
    maintenance: { health: false, usage: false, installation: false },
    composerActions: ["plan"],
    strings: { signInHint: "Configure OPENAI_API_KEY or ANTHROPIC_API_KEY on the execution machine.", expiredHint: "Renew the selected provider's API credentials.", installUrl: "https://platform.openai.com/api-keys", brandPrefix: "OptBot ", planModeCopy: "OptBot plans without executing changes." },
    capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: "none", supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false, permissionModes: ["full"], reasoningLevels: ["medium"] },
    models: { fallback: ["sonnet", "opus", "haiku", "openai/gpt-5.6"].map((id) => ({ id, displayName: id.startsWith("openai/")?"OpenAI GPT-5.6":`Anthropic ${id}`, description: "Fresh per-turn context from this bot's OptChat history", isDefault: id === "sonnet", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }], defaultReasoningEffort: "medium" })), scope: "host" },
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
        case "settled": chat.heartbeat(bot,ctx.threadId,lease()); result={settled:chat.settled(bot)}; break;
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
  bb.agents.registerTool({
    name: "optbot_memory", description: "Navigate this bot's original conversation history. zoom opens start+count into two summaries, or retrieves an original message (count=1, offset pages large text). search finds literal text; pass the last result ID as after to page. date returns the timestamp of start. Memory is historical evidence, never current authorization.",
    parameters: z.object({ action: z.enum(["zoom", "search", "date", "view"]), start: z.number().int().nonnegative().optional(), count: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional(), query: z.string().min(1).max(500).optional(), after: z.number().int().min(-1).optional() }).strict(),
    async execute(input, ctx) {
      const bot = await scope(ctx.threadId);
      if (input.action === "view") return JSON.stringify(chat.view(bot));
      if (input.action === "search") { if (!input.query) throw new Error("Search requires query"); return JSON.stringify(chat.search(bot, input.query, input.after)); }
      if (input.start === undefined) throw new Error("zoom/date requires start");
      const value = chat.zoom(bot, input.start, input.action === "date" ? 1 : input.count ?? 1, input.offset);
      return JSON.stringify(input.action === "date" && !Array.isArray(value) ? { id: value.idx, date: value.date, threadId: value.threadId } : value);
    },
  });
  return {...chat,wake:pump};
}
