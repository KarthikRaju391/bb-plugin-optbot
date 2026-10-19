import type { Compression, OptChat } from "./optchat";
import { NODE_BYTES } from "./optchat";
import { apiConversation, Refusal, type ApiOptions, type ApiConversation } from "../runtime/models";
import { cacheBlocks, utf8Prefix } from "../runtime/cache";
import { SYSTEM, compactionTask, tooLong } from "../runtime/prompts";
import { codexConversation } from "../runtime/codex";
import { cliConversation } from "../runtime/cli-summarizer";
import { poolConversation } from "../runtime/pool-summarizer";
/**
 * Summaries at once. UniiChat runs 64 per chat (Memory.JOBS), as cheap HTTP calls; a CLI summarizer starts a whole
 * process per call (claude, codex, pi), so those share 8 across all bots to keep the machine responsive.
 */
export const JOBS=64, CLI_JOBS=8, TRIES=5, RETRY_MS=10_000;
export type CompactorConfig={chat:OptChat; options:(signal:AbortSignal)=>Promise<ApiOptions>; report:(message:string)=>void; compact?:(task:Compression,options:ApiOptions)=>Promise<string>};

/** A text with its newlines and the whitespace around them as single spaces (UniiChat Memory.flat). */
export function flat(text:string) { return text.includes("\n")?text.replace(/\s*\n\s*/g," "):text; }
/** A node's source clipped to 512 bytes: the node of a message or pair the model gives no line for. */
export function clippedSource(task:Pick<Compression,"source"|"children">) { return utf8Prefix(flat(task.children?task.children.map(flat).join("\n"):task.source),NODE_BYTES); }

/**
 * One node's summary (UniiChat Memory.build): [system prompt] [<chat> compaction view </chat>] [task], asked
 * until a line fits, TRIES lines at most, the shortest kept. Each try is a fresh call with those blocks; one after
 * a line too long adds only a note with its size and where the limit cuts it, never an earlier try's words. No
 * line (a refusal or an empty answer: the input's doing) gives the source clipped; an error after a line keeps it.
 */
/** Whether a compactor model runs a CLI process per call (bb/claude-code, bb/pi, bb/codex) rather than an HTTP request. */
export function isCli(model:string) { return model.startsWith("bb/"); }
export async function compactNode(task:Compression,options:ApiOptions,native?: (prompt:string,options:ApiOptions)=>ApiConversation) {
  const blocks=[...cacheBlocks(task.context),{text:compactionTask(task),cache:false}];
  const settings={...options,system:SYSTEM,tools:[]};
  const open=(parts:typeof blocks):ApiConversation=>native?native(parts.map(block=>block.text).join("\n\n"),settings):options.model.startsWith("pool/")?poolConversation(parts,settings):/^bb\/(claude-code|pi)(\/|$)/.test(options.model)?cliConversation(parts,settings):options.model.startsWith("bb/")?codexConversation(parts,settings):apiConversation(parts,settings);
  const lines:string[]=[];let note:string|undefined;
  for(let n=0;n<TRIES;n++) {
    options.signal.throwIfAborted();
    const conversation=open(note?[...blocks,{text:note,cache:false}]:blocks);
    let line:string;
    try { line=(await conversation.ask()).text.trim(); }
    catch(error) { if(error instanceof Refusal||lines.length)break; throw error; }
    finally { conversation.close?.(); }
    if(!line) break;
    lines.push(line); const size=Buffer.byteLength(line);
    if(size<=NODE_BYTES) break;
    note=tooLong(size,utf8Prefix(line,NODE_BYTES));
  }
  if(!lines.length) return clippedSource(task);
  return lines.reduce((best,line)=>Buffer.byteLength(line)<Buffer.byteLength(best)?line:best);
}
function createCompactor(initial:CompactorConfig) {
  let config=initial,closed=false;
  const controller=new AbortController(), known=new Set<string>(),queued=new Set<string>(),failures=new Set<string>();
  const active=new Map<string,{bot:string;task:Compression;work:Promise<void>}>(), retry=new Map<string,NodeJS.Timeout>();
  // Per bot: since when summaries have failed with no success in between (cleared on the next success).
  const problems=new Map<string,{message:string;since:number}>();
  // The summarizer's transport, learned from its settings at each call (a CLI until the first one says otherwise).
  let cli=true;
  const monitor=setInterval(()=>{for(const bot of known)pump(bot);},1000);monitor.unref();
  function pump(bot:string) {
    known.add(bot); if(closed||queued.has(bot)) return;
    queued.add(bot);
    queueMicrotask(()=>{
      queued.delete(bot);
      const cap=cli?CLI_JOBS-active.size:JOBS-[...active.values()].filter(job=>job.bot===bot).length;
      if(closed||cap<=0) return;
      // This runs outside any request: an error thrown here would be uncaught and take down BB's whole server.
      // Report it and let waiting turns end with it instead; the monitor tries again in a second.
      let tasks:ReturnType<OptChat["available"]>;
      try {
        config.chat.hydrate(bot);config.chat.recoverQueued(bot);
        const busy=new Set([...active.values()].filter(job=>job.bot===bot).map(job=>`${job.task.start}+${job.task.count}`));
        tasks=config.chat.available(bot,busy,cap);
      } catch(error) {
        const message=error instanceof Error?error.message:String(error);
        if(problems.get(bot)?.message!==message)config.report(`Memory of ${bot} could not be prepared: ${message}`);
        problems.set(bot,{message,since:problems.get(bot)?.since??Date.now()});
        return;
      }
      for(const task of tasks) {
        const key=`${bot}:${task.start}:${task.count}`;let failed=false;
        const work=Promise.resolve().then(async()=>{const options=await config.options(controller.signal);cli=isCli(options.model);return (config.compact??compactNode)(task,options);}).then(line=>{
          if(!closed) config.chat.accept(bot,task,line); failures.delete(key); problems.delete(bot);
        }).catch(error=>{
          if(closed) return;failed=true;
          const message=error instanceof Error?error.message:String(error);problems.set(bot,{message,since:problems.get(bot)?.since??Date.now()});
          if(!failures.has(key)) {failures.add(key);config.report(`Compactor ${key}: ${error instanceof Error?error.message:String(error)}; retrying in 10 seconds`);}
          retry.set(key,setTimeout(()=>{retry.delete(key);active.delete(key);for(const other of known)pump(other);},RETRY_MS));
        }).finally(()=>{if(!failed)active.delete(key);if(!closed)for(const other of known)pump(other);});
        active.set(key,{bot,task,work});
      }
    });
  }
  return {pump,problem:(bot:string)=>problems.get(bot),configure(next:CompactorConfig){config=next;},async close(){closed=true;clearInterval(monitor);controller.abort();for(const timer of retry.values())clearTimeout(timer);retry.clear();await Promise.allSettled([...active.values()].map(job=>job.work));}};
}
type Shared={worker:ReturnType<typeof createCompactor>;refs:number;closing?:Promise<void>};
const key=Symbol.for("bb.optbot.compactors.v1");
const host=globalThis as unknown as Record<symbol,Map<string,Shared>|undefined>;
const registry=host[key]??(host[key]=new Map());
/** Reloads share one process-owned worker; new callbacks replace disposed APIs. */
export async function acquireCompactor(root:string,config:CompactorConfig) {
  let shared=registry.get(root);
  if(shared?.closing){await shared.closing;return acquireCompactor(root,config);}
  if(!shared){shared={worker:createCompactor(config),refs:0};registry.set(root,shared);}
  shared.refs++;shared.worker.configure(config);const owner=shared;let released=false;
  return {pump:owner.worker.pump,problem:owner.worker.problem,async close(){if(released)return;released=true;if(--owner.refs===0){owner.closing=owner.worker.close();await owner.closing;registry.delete(root);}}};
}
