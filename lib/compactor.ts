import type { Compression, OptChat } from "./optchat";
import { NODE_BYTES } from "./optchat";
import { apiConversation, type ApiOptions, type ApiConversation } from "../runtime/models";
import { cacheBlocks, utf8Prefix } from "../runtime/cache";
import { COMPACT } from "../runtime/prompts";
import { SCALE } from "../runtime/scale";
import { codexConversation } from "../runtime/codex";
import { claudeConversation } from "../runtime/claude-summarizer";
export const JOBS=8, TRIES=5, RETRY_MS=10_000;
export type CompactorConfig={chat:OptChat; options:(signal:AbortSignal)=>Promise<ApiOptions>; report:(message:string)=>void; compact?:(task:Compression,options:ApiOptions)=>Promise<string>};

export async function compactNode(task:Compression,options:ApiOptions,native?: (prompt:string,options:ApiOptions)=>ApiConversation) {
  const source=task.children?.map(line=>line.replace(/\r\n|\n|\r/g," ")).join("\n")??task.source;
  const step=`For scale, this line is exactly 512 bytes:\n${SCALE}\n\n${task.count===1?"Compress this message into one line, in at most 512 bytes:":"Merge these two lines into one, in at most 512 bytes:"}\n${source}`;
  const blocks=[...cacheBlocks(task.context),{text:step,cache:false}];
  const conversation=native?native(blocks.map(block=>block.text).join("\n\n"),{...options,system:COMPACT,tools:[]}):options.model.startsWith("bb/claude-code")?claudeConversation(blocks,{...options,system:COMPACT,tools:[]}):options.model.startsWith("bb/")?codexConversation(blocks,{...options,system:COMPACT,tools:[]}):apiConversation(blocks,{...options,system:COMPACT,tools:[]});
  try {
  const candidates:string[]=[];let feedback:string|undefined;
  for(let n=0;n<TRIES;n++) {
    options.signal.throwIfAborted();
    const reply=await conversation.ask(feedback), line=reply.text.trim();
    if(!line) throw new Error("Compactor returned an empty line");
    candidates.push(line); const size=Buffer.byteLength(line);
    if(size<=NODE_BYTES) break;
    feedback=`That line is ${size} bytes; the limit is 512. It must end where it is cut here:\n${utf8Prefix(line,NODE_BYTES)}| ← LIMIT`;
  }
  return candidates.reduce((best,line)=>Buffer.byteLength(line)<Buffer.byteLength(best)?line:best);
  } finally { conversation.close?.(); }
}
function createCompactor(initial:CompactorConfig) {
  let config=initial,closed=false;
  const controller=new AbortController(), known=new Set<string>(),queued=new Set<string>(),failures=new Set<string>();
  const active=new Map<string,{bot:string;task:Compression;work:Promise<void>}>(), retry=new Map<string,NodeJS.Timeout>();
  // Per bot: since when summaries have failed with no success in between (cleared on the next success).
  const problems=new Map<string,{message:string;since:number}>();
  const monitor=setInterval(()=>{for(const bot of known)pump(bot);},1000);monitor.unref();
  function pump(bot:string) {
    known.add(bot); if(closed||queued.has(bot)) return;
    queued.add(bot);
    queueMicrotask(()=>{
      queued.delete(bot); if(closed||active.size>=JOBS) return;
      config.chat.hydrate(bot);config.chat.recoverQueued(bot);
      const busy=new Set([...active.values()].filter(job=>job.bot===bot).map(job=>`${job.task.start}+${job.task.count}`));
      for(const task of config.chat.available(bot,busy,JOBS-active.size)) {
        const key=`${bot}:${task.start}:${task.count}`;let failed=false;
        const work=Promise.resolve().then(async()=>(config.compact??compactNode)(task,await config.options(controller.signal))).then(line=>{
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
