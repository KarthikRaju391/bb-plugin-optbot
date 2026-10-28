import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { clipPage, createOptChat } from "./optchat";
import { openArchive } from "./archive";
import { localBlock } from "../runtime/prompts";
import { dirname, join } from "node:path";
import { acquireCompactor, compactBatch, compactNode, CLI_JOBS } from "./compactor";
import { modelRef } from "../runtime/models";
import { modelHostContract } from "../runtime/host-contract";
import { codexRef } from "../runtime/codex";
import { cliRef } from "../runtime/cli-summarizer";
import { poolCredentials, poolRef } from "../runtime/pool-summarizer";
// The summarizer is a tool-less text call through a host login: Codex, Claude Code or Pi.
export const SUMMARIZER_PATIENCE_MS = 60_000;
const SUMMARY_CALL_TIMEOUT_MS = 300_000;
const summarizerRef = (model: string) => /^bb\/(claude-code|pi)(\/|$)/.test(model) ? cliRef(model) : codexRef(model);
import type { createBbWorkers } from "./bb-workers";

export async function registerOptChat(bb: BbPluginApi, resolveOwner: (threadId: string) => Promise<string | null>, workers: ReturnType<typeof createBbWorkers>, rules?: (bot: string) => string | undefined, agents?: { chat(bot: string, name: string): Promise<string | null>; name(threadId: string): string | null }) {
  const db = bb.storage.database();
  const root=join(dirname(db.name),"chat");
  const archive = await openArchive(root, message=>bb.log.warn(message));
  // Agents' names straight from their table: startup replays inputs before the agents module is wired.
  const agentName = (threadId: string) => { try { return (db.prepare("SELECT name FROM optbot_agents WHERE thread=?").get(threadId) as { name: string } | undefined)?.name ?? null; } catch { return null; } };
  const chat = createOptChat(db, { archive, agentName: threadId => agents?.name(threadId) ?? agentName(threadId) });
  const settings=bb.settings.define({
    compactorModel:{type:"string",label:"Compactor model",default:"bb/codex",description:"bb/codex[/<model>], bb/claude-code[/<model>], bb/pi[/<provider>/<model>] or, with compactorAccountPooler on, pool/claude/<model> or pool/codex/<model>: a tool-less text call through that CLI's own login on the compactor machine (no API key). Prefer a small model, e.g. bb/codex/gpt-6-luna, bb/claude-code/claude-haiku-4-5-20251001 or bb/pi/openai-codex/gpt-6-luna."},
    compactorHost:{type:"string",label:"Compactor BB machine ID",description:"Enrolled machine where the compactor model's CLI (codex, claude or pi) is signed in. No separate API key is required."},
    compactorExecutable:{type:"string",label:"Optional summarizer CLI path",description:"Absolute path to the codex, claude or pi binary on the compactor machine. Leave empty to find it on PATH; set it when PATH finds a wrapper script (for example a version manager's) that hangs."},
    compactorAccountPooler:{type:"boolean",label:"Summarize through Account Pooler (unsupported by BB)",default:false,description:"Lets OptBot read Account Pooler's machine token from BB's data folder to send summaries through its local proxy, which switches accounts like BB does. Then set compactorModel to pool/claude/<model> (e.g. pool/claude/claude-haiku-4-5) or pool/codex/<model>. Account Pooler does not offer this to plugins officially; it may break in a future BB release."},
    compactorApiKey:{type:"string",label:"Compactor API key",secret:true,description:"Used only by the always-on backend; never sent to the agent or stored in its history."},
    compactorEndpoint:{type:"string",label:"Optional compactor API base URL",description:"Leave empty for the provider's standard endpoint. HTTPS is required except on loopback."},
    compactorJobs:{type:"number",label:"Summarizer processes at once",default:CLI_JOBS,description:"How many summarizer CLI calls (claude, codex, pi) may run at once across all bots, 1 to 8. Each call summarizes up to 32 messages or merges and holds about 230 MB while it runs."},
  });

  const nativeLifetime=new AbortController();
  bb.onDispose(()=>nativeLifetime.abort());
  async function nativeHostId() {
    const {compactorHost}=await settings.get();
    if (typeof compactorHost!=="string" || !compactorHost) throw new Error("Select the BB machine in OptBot's compactorHost setting");
    return compactorHost;
  }
  const modelHost=bb.hosts.experimental_client({contract:modelHostContract});
  async function executable(model:string) {
    const {compactorExecutable:path,compactorAccountPooler:pooled,compactorHost:host}=await settings.get();
    const extra:{executable?:string;poolToken?:string}={};
    if (typeof path==="string" && path.trim()) {
      if (!path.trim().startsWith("/")) throw new Error("OptBot's compactorExecutable setting must be an absolute path");
      extra.executable=path.trim();
    }
    // With Account Pooler on, the Claude Code summarizer runs against the pool like BB's own Claude Code threads.
    if (pooled===true && /^bb\/claude-code(\/|$)/.test(model)) extra.poolToken=(await poolCredentials(bb.server.experimental_dataDir,bb.server.loopbackBaseUrl,typeof host==="string"&&host?host:undefined)).OPTBOT_POOL_TOKEN;
    return extra;
  }
  // The compactorJobs setting as last read (each summary reads the settings; pumps need it synchronously).
  let cliJobs=CLI_JOBS;
  const worker=await acquireCompactor(root,{chat,rules,report:message=>bb.log.warn(message),jobs:()=>cliJobs,async compactBatch(items,context,options){
    if (!options.model.startsWith("bb/")) return compactBatch(items, context, options);
    summarizerRef(options.model);
    // The batch's one context goes once; its items' own contexts (prefixes of it) stay here.
    return modelHost.call("compactBatch",{model:options.model,items:items.map(item=>({task:{...item.task,context:""},...(item.note?{note:item.note}:{})})),context,...(options.system?{rules:options.system}:{}),...await executable(options.model)},{hostId:await nativeHostId(),signal:options.signal,timeoutMs:SUMMARY_CALL_TIMEOUT_MS});
  },async compact(task,options){
    if (!options.model.startsWith("bb/")) return compactNode(task, options);
    summarizerRef(options.model);
    // One summary can take several model attempts; BB's default 30 s host-call deadline cut them off.
    return modelHost.call("compact",{task,model:options.model,...(options.system?{rules:options.system}:{}),...await executable(options.model)},{hostId:await nativeHostId(),signal:options.signal,timeoutMs:SUMMARY_CALL_TIMEOUT_MS});
  },async options(signal){
    const {compactorModel:selected,compactorApiKey:credential,compactorEndpoint:base,compactorJobs:jobs}=await settings.get();
    if(typeof jobs==="number"&&Number.isFinite(jobs))cliJobs=Math.max(1,Math.min(8,Math.floor(jobs)));
    const model=typeof selected==="string"&&selected?selected:"bb/codex";
    if(model.startsWith("bb/")) {summarizerRef(model);return {model,env:{},signal,system:""};}
    if(model.startsWith("pool/")) return {model,env:await poolEnv(model),signal,system:""};
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
    id: "optbot", displayName: "OptBot", icon: "./assets/optbot.svg", family: "optbot",
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
    action: z.enum(["begin", "heartbeat", "checkpoint", "record", "work", "merge", "view", "finish", "settled", "zoom", "date", "input", "enqueue", "unacknowledged"]),
    requestId: z.string().min(1).max(128).optional(), lease: z.string().uuid().optional(),
    parentId:z.string().min(1).max(128).optional(),
    key: z.string().min(1).max(256).optional(), kind: z.enum(["user", "talk", "tool", "echo", "work", "note"]).optional(),
    text: z.string().optional(), start: z.number().int().nonnegative().optional(),
    count: z.number().int().positive().optional(), at: z.number().int().nonnegative().optional(), status: z.enum(["completed", "failed", "stopped"]).optional(),
  }).strict();
  /**
   * Steers BB still shows as pending: sent as a steer, never accepted (an acceptance sent before its turn opened was
   * dropped), though a turn took them, as the memory shows. The bridge acknowledges them in its next open turn.
   */
  async function unacknowledged(bot: string, threadId: string) {
    type Row = { type: string; data: { requestId?: string; clientRequestId?: string; target?: { kind?: string } } };
    const rows: Row[] = [];
    for (let after: string | undefined; ;) {
      const page = await bb.sdk.threads.events.list({ threadId, afterSeq: after, order: "asc", limit: "100", types: ["client/turn/requested", "turn/input/accepted"] } as unknown as Parameters<typeof bb.sdk.threads.events.list>[0]) as (Row & { seq: number })[];
      rows.push(...page);
      if (page.length < 100) break;
      after = String(page.at(-1)!.seq);
    }
    const accepted = new Set(rows.flatMap(row => row.type === "turn/input/accepted" && row.data.clientRequestId ? [row.data.clientRequestId] : []));
    const taken = db.prepare("SELECT 1 FROM optchat_log WHERE bot_id=? AND event_key=?");
    return rows.flatMap(row => row.type === "client/turn/requested" && row.data.target?.kind === "steer" && row.data.requestId && !accepted.has(row.data.requestId) && taken.get(bot, `${row.data.requestId}:input`) ? [row.data.requestId] : []);
  }
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
          const settled=chat.settled(bot), problem=settled?undefined:worker.problem(bot);
          // A turn waits for summaries (spec §6) but must not wait silently on a summarizer that keeps failing.
          result={settled,...(problem&&Date.now()-problem.since>=SUMMARIZER_PATIENCE_MS?{blocked:problem.message}:{})}; break;
        }
        case "checkpoint": result = chat.checkpoint(bot, ctx.threadId, lease(), required(input.text, "text")); break;
        case "record": result = chat.record(bot, ctx.threadId, lease(), required(input.key, "key"), required(input.kind, "kind"), required(input.text, "text")); break;
        case "input": result=chat.input(bot,ctx.threadId,lease(),required(input.requestId,"requestId"),required(input.text,"text"));break;
        case "enqueue": result=chat.enqueue(bot,ctx.threadId,required(input.requestId,"requestId"),required(input.parentId,"parentId"),required(input.text,"text"));break;
        case "work": result = chat.work(bot, ctx.threadId, lease()); break;
        case "unacknowledged": result = await unacknowledged(bot, ctx.threadId); break;
        case "merge": result = chat.merge(bot, ctx.threadId, lease(), required(input.start, "start"), required(input.count, "count"), required(input.text, "text")); break;
        case "view": result = { ...chat.view(bot), local: localBlock(chat.local(bot, ctx.threadId)) }; break;
        case "zoom": result=chat.zoomText(bot,required(input.start,"start"),required(input.count,"count"),input.at??0); break;
        case "date": result=chat.dateText(bot,required(input.start,"start")); break;
        case "finish": result = chat.finish(bot, ctx.threadId, lease(), required(input.status, "status"), required(input.text, "text")); break;
      }
      pump(bot);
      return JSON.stringify(result);
    },
  });
  // Spec §7.1: the agent's only memory tools are zoom and date, with the reference descriptions and output.
  bb.agents.registerTool({
    name: "optbot_memory", description: "zoom: Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. With an agent's thread id, give that agent's whole chat. A long text comes in pages from character at, saying where to go on. date: The date and time of message id.",
    parameters: z.object({ action: z.enum(["zoom", "date"]), start: z.number().int().nonnegative().optional(), count: z.number().int().positive().optional(), agent: z.string().min(1).max(64).optional(), name: z.string().min(1).max(64).optional(), at: z.number().int().nonnegative().optional() }).strict(),
    async execute(input, ctx) {
      const bot = await scope(ctx.threadId);
      // UniiChat Tools.ts: zoom with an agent's name gives its whole chat, in pages.
      // `name` is the older form, from reports logged when agents had two-word names.
      const agent = input.agent ?? input.name;
      if (input.action === "zoom" && agent !== undefined) { const text = await agents?.chat(bot, agent); return text ? clipPage(text, Math.min(input.at ?? 0, text.length)) : `No agent ${agent}.`; }
      if (input.start === undefined) return "Give start (a message id), or agent (a thread id) for an agent's chat.";
      return input.action === "date" ? chat.dateText(bot, input.start) : chat.zoomText(bot, input.start, input.count ?? 1, input.at ?? 0);
    },
  });
  async function poolEnv(model:string) {
    poolRef(model);
    const {compactorAccountPooler:allowed,compactorHost:host}=await settings.get();
    if(allowed!==true)throw new Error("Turn on OptBot's compactorAccountPooler setting to summarize through Account Pooler");
    return poolCredentials(bb.server.experimental_dataDir,bb.server.loopbackBaseUrl,typeof host==="string"&&host?host:undefined);
  }
  async function checkModel() {
    const {compactorModel}=await settings.get(), model=compactorModel || "bb/codex";
    if(model.startsWith("pool/")) {
      const signal=AbortSignal.any([nativeLifetime.signal,AbortSignal.timeout(120_000)]);
      const summary=await compactNode({start:0,count:1,context:"<chat>\n\n</chat>",source:"user: This is an OptBot readiness check. Preserve OPTBOT_NATIVE_CHECK_OK."},{model,env:await poolEnv(model),signal,system:""});
      return {model,via:"Account Pooler",summary};
    }
    summarizerRef(model); const hostId=await nativeHostId();
    const summary=await modelHost.call("compact",{model,...await executable(model),task:{start:0,count:1,context:"<chat>\n\n</chat>",source:"user: This is an OptBot readiness check. Preserve OPTBOT_NATIVE_CHECK_OK."}},{hostId,signal:AbortSignal.any([nativeLifetime.signal,AbortSignal.timeout(120_000)]),timeoutMs:120_000});
    const {compactorAccountPooler:pooled}=await settings.get();
    return {model,hostId,...(pooled===true&&/^bb\/claude-code(\/|$)/.test(model)?{via:"Account Pooler"}:{}),summary};
  }
  return {...chat,wake:pump,checkModel};
}
