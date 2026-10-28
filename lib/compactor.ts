import type { Compression, OptChat } from "./optchat";
import { NODE_BYTES } from "./optchat";
import { apiConversation, Refusal, type ApiOptions, type ApiConversation } from "../runtime/models";
import { cacheBlocks, joinBlocks, utf8Prefix } from "../runtime/cache";
import { SYSTEM, batchTask, compactionTask, tooLong } from "../runtime/prompts";
import { codexConversation } from "../runtime/codex";
import { CLI_CALL_TIMEOUT_MS, cliConversation } from "../runtime/cli-summarizer";
import { poolConversation } from "../runtime/pool-summarizer";
/**
 * Summaries at once. UniiChat runs 64 per chat (Memory.JOBS), as cheap HTTP calls. A CLI summarizer starts a whole
 * process per call (claude, codex, pi; about 230 MB each), so it gets many nodes per call (a batch) and runs
 * CLI_JOBS batches at once across all bots (the compactorJobs setting).
 */
export const JOBS=64, CLI_JOBS=2, TRIES=5, RETRY_MS=10_000;
/** A batch: at most BATCH_ITEMS nodes and about BATCH_BYTES of their inputs; split over free slots, MIN_BATCH at least. */
export const BATCH_ITEMS=32, BATCH_BYTES=60_000, MIN_BATCH=8;
/** A batch call's deadline: a single call's, plus time for each line, within the host call's 300 s. */
export function batchTimeout(items:number) { return Math.min(280_000,CLI_CALL_TIMEOUT_MS+5_000*items); }
export type BatchItem={task:Compression;note?:string};
/** A batch's lines in its items' order: null where the answer had none for that id (or two different ones). */
export type BatchResult={lines:(string|null)[];refused?:boolean};
export type CompactorConfig={chat:OptChat; options:(signal:AbortSignal)=>Promise<ApiOptions>; report:(message:string)=>void; compact?:(task:Compression,options:ApiOptions)=>Promise<string>; compactBatch?:(items:BatchItem[],context:string,options:ApiOptions)=>Promise<BatchResult>; rules?:(bot:string)=>string|undefined; jobs?:()=>number; retryMs?:number};

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
/** A summarizer call through the model's transport, with the same system prompt as turns and the bot's rules after it. */
function summarizer(options:ApiOptions,native?: (prompt:string,options:ApiOptions)=>ApiConversation) {
  // UniiChat Tools.system: MASTER + rules.
  const settings={...options,system:options.system?`${SYSTEM}\n\n${options.system}`:SYSTEM,tools:[],endMark:false};
  return (parts:{text:string;cache:boolean}[]):ApiConversation=>native?native(joinBlocks(parts),settings):options.model.startsWith("pool/")?poolConversation(parts,settings):/^bb\/(claude-code|pi)(\/|$)/.test(options.model)?cliConversation(parts,settings):options.model.startsWith("bb/")?codexConversation(parts,settings):apiConversation(parts,settings);
}
export async function compactNode(task:Compression,options:ApiOptions,native?: (prompt:string,options:ApiOptions)=>ApiConversation) {
  const blocks=[...cacheBlocks(task.context),{text:compactionTask(task),cache:false}];
  const open=summarizer(options,native);
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
const shortest=(lines:readonly string[])=>lines.reduce((best,line)=>Buffer.byteLength(line)<Buffer.byteLength(best)?line:best);
/** A batch answer's lines by id: each `id+n|line` whose id was asked; an id answered twice with different lines has none. */
export function parseBatch(text:string,ids:readonly string[]):(string|null)[] {
  const wanted=new Set(ids), found=new Map<string,string|null>();
  for(const raw of text.split(/\r?\n/)) {
    const match=/^\s*(\d+\+\d+)\|(.*)$/.exec(raw);
    if(!match||!wanted.has(match[1]!)) continue;
    const line=match[2]!.trim();
    if(!line) continue;
    found.set(match[1]!,found.has(match[1]!)&&found.get(match[1]!)!==line?null:line);
  }
  return ids.map(id=>found.get(id)??null);
}
/**
 * Many nodes' summaries in one call: [system prompt] [<chat> compaction view </chat>] [batch task]. The view is the
 * longest of the nodes' own (each is a prefix of the compactions' view). One try: the compactor re-asks a node whose
 * line is missing or too long in a later batch, with that node's note. A refusal answers no node.
 */
export async function compactBatch(items:readonly BatchItem[],context:string,options:ApiOptions,native?: (prompt:string,options:ApiOptions)=>ApiConversation):Promise<BatchResult> {
  options.signal.throwIfAborted();
  const conversation=summarizer(options,native)([...cacheBlocks(context),{text:batchTask(items),cache:false}]);
  let text:string;
  try { text=(await conversation.ask()).text; }
  catch(error) { if(error instanceof Refusal) return {lines:items.map(()=>null),refused:true}; throw error; }
  finally { conversation.close?.(); }
  return {lines:parseBatch(text,items.map(item=>`${item.task.start}+${item.task.count}`))};
}
function createCompactor(initial:CompactorConfig) {
  let config=initial,closed=false;
  const controller=new AbortController(), known=new Set<string>(),queued=new Set<string>(),failures=new Set<string>();
  const active=new Map<string,{bot:string;task:Compression;work:Promise<void>}>(), retry=new Map<string,NodeJS.Timeout>();
  // Per bot: since when summaries have failed with no success in between (cleared on the next success).
  const problems=new Map<string,{message:string;since:number}>();
  // The summarizer's transport, learned from its settings at each call (a CLI until the first one says otherwise).
  let cli=true;
  // CLI batches running, and per node the lines earlier batches gave and the note for its next try (in memory: after
  // a restart a node not saved is simply asked again). A node whose batch was refused is asked alone.
  let batches=0;
  const attempts=new Map<string,{tries:number;lines:string[];note?:string}>(), alone=new Set<string>();
  const jobs=()=>Math.max(1,Math.min(8,Math.floor(config.jobs?.()??CLI_JOBS)||CLI_JOBS));
  const monitor=setInterval(()=>pumpAll(),1000);monitor.unref();
  /** Every bot, starting after `after`: a freed CLI slot goes to the other bots first, so none starves. */
  function pumpAll(after?:string) {
    const bots=[...known], at=after===undefined?-1:bots.indexOf(after);
    for(const bot of [...bots.slice(at+1),...bots.slice(0,at+1)])pump(bot);
  }
  function problem(bot:string,error:unknown) {
    const message=error instanceof Error?error.message:String(error);
    problems.set(bot,{message,since:problems.get(bot)?.since??Date.now()});
    return message;
  }
  function save(bot:string,task:Compression,line:string) {
    if(closed) return;
    try { config.chat.accept(bot,task,line); failures.delete(`${bot}:${task.start}:${task.count}`); }
    catch(error) { config.report(`Compactor ${bot}:${task.start}:${task.count}: ${error instanceof Error?error.message:String(error)}`); }
  }
  function later(keys:readonly string[]) {
    for(const key of keys)retry.set(key,setTimeout(()=>{retry.delete(key);active.delete(key);pumpAll();},config.retryMs??RETRY_MS));
  }
  function pump(bot:string) {
    known.add(bot); if(closed||queued.has(bot)) return;
    queued.add(bot);
    queueMicrotask(()=>{
      queued.delete(bot);
      const cap=cli?(jobs()-batches)*BATCH_ITEMS:JOBS-[...active.values()].filter(job=>job.bot===bot).length;
      if(closed||cap<=0) return;
      // This runs outside any request: an error thrown here would be uncaught and take down BB's whole server.
      // Report it and let waiting turns end with it instead; the monitor tries again in a second.
      let tasks:ReturnType<OptChat["available"]>;
      try {
        config.chat.hydrate(bot);config.chat.recoverQueued(bot);
        const busy=new Set([...active.values()].filter(job=>job.bot===bot).map(job=>`${job.task.start}+${job.task.count}`));
        tasks=config.chat.available(bot,busy,cap);
      } catch(error) {
        const old=problems.get(bot)?.message, message=problem(bot,error);
        if(old!==message)config.report(`Memory of ${bot} could not be prepared: ${message}`);
        return;
      }
      if(!cli) { for(const task of tasks) single(bot,task); return; }
      // The ready nodes split evenly over the free slots, so a short backlog is not one slow call.
      const size=Math.min(BATCH_ITEMS,Math.max(MIN_BATCH,Math.ceil(tasks.length/Math.max(1,jobs()-batches))));
      let group:Compression[]=[], bytes=0;
      for(const task of tasks) {
        if(batches>=jobs()) break;
        if(alone.has(`${bot}:${task.start}:${task.count}`)) { batch(bot,[task]); continue; }
        const n=Buffer.byteLength(task.source);
        if(group.length&&(group.length>=size||bytes+n>BATCH_BYTES)) { batch(bot,group); group=[]; bytes=0; if(batches>=jobs()) break; }
        group.push(task); bytes+=n;
      }
      if(group.length&&batches<jobs()) batch(bot,group);
    });
  }
  /** One node, one summary (compactNode): API and pool models, cheap HTTP calls. */
  function single(bot:string,task:Compression) {
    const key=`${bot}:${task.start}:${task.count}`;let failed=false;
    const work=Promise.resolve().then(async()=>{const options={...await config.options(controller.signal),system:config.rules?.(bot)??""};cli=isCli(options.model);return (config.compact??compactNode)(task,options);}).then(line=>{
      if(!closed) config.chat.accept(bot,task,line); failures.delete(key); problems.delete(bot);
    }).catch(error=>{
      if(closed) return;failed=true;
      const message=problem(bot,error);
      if(!failures.has(key)) {failures.add(key);config.report(`Compactor ${key}: ${message}; retrying in 10 seconds`);}
      later([key]);
    }).finally(()=>{if(!failed)active.delete(key);if(!closed)pumpAll(bot);});
    active.set(key,{bot,task,work});
  }
  /**
   * Many nodes in one CLI call. Each node keeps compactNode's rules across batches: a line within 512 bytes is saved;
   * one too long is asked again with its note, TRIES lines at most, the shortest kept; no line after TRIES tries keeps
   * the source clipped. A failed call keeps the lines nodes already had and retries the rest in 10 seconds.
   */
  function batch(bot:string,group:Compression[]) {
    batches++;
    const keys=group.map(task=>`${bot}:${task.start}:${task.count}`), failed:string[]=[];
    const work=Promise.resolve().then(async()=>{
      const options={...await config.options(controller.signal),system:config.rules?.(bot)??""};
      cli=isCli(options.model);
      if(!cli) return; // not a CLI after all: the next pump asks these nodes one by one
      const items=group.map((task,i)=>{const note=attempts.get(keys[i]!)?.note;return note?{task,note}:{task};});
      const context=group.reduce((longest,task)=>task.context.length>longest.length?task.context:longest,"");
      let result:BatchResult;
      try { result=await (config.compactBatch??compactBatch)(items,context,{...options,timeoutMs:batchTimeout(items.length)}); }
      catch(error) {
        // An error after a line keeps it (compactNode): a node with a line from an earlier batch keeps its shortest.
        group.forEach((task,i)=>{const state=attempts.get(keys[i]!);if(state?.lines.length){save(bot,task,shortest(state.lines));attempts.delete(keys[i]!);}else failed.push(keys[i]!);});
        if(failed.length) throw error;
        return;
      }
      // One input refused poisons its batch: each node is asked alone, so only the refused one keeps its source.
      if(result.refused&&group.length>1) { for(const key of keys) alone.add(key); return; }
      group.forEach((task,i)=>{
        const key=keys[i]!, line=result.lines[i]?.trim(), state=attempts.get(key)??{tries:0,lines:[]};
        state.tries++;
        if(line) {
          state.lines.push(line); const size=Buffer.byteLength(line);
          if(size<=NODE_BYTES) { save(bot,task,line); attempts.delete(key); alone.delete(key); return; }
          state.note=tooLong(size,utf8Prefix(line,NODE_BYTES));
        }
        if(result.refused||state.tries>=TRIES) { save(bot,task,state.lines.length?shortest(state.lines):clippedSource(task)); attempts.delete(key); alone.delete(key); return; }
        attempts.set(key,state);
      });
      problems.delete(bot);
    }).catch(error=>{
      if(closed) return;
      const message=problem(bot,error);
      const fresh=failed.filter(key=>!failures.has(key));
      if(fresh.length) { for(const key of fresh)failures.add(key); config.report(`Compactor ${bot} batch of ${group.length} (${fresh.length} to retry, from ${group[0]!.start}+${group[0]!.count}): ${message}; retrying in ${Math.round((config.retryMs??RETRY_MS)/1000)} seconds`); }
      later(failed);
    }).finally(()=>{batches--;for(const key of keys)if(!retry.has(key))active.delete(key);if(!closed)pumpAll(bot);});
    group.forEach((task,i)=>active.set(keys[i]!,{bot,task,work}));
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
