import {randomUUID} from "node:crypto";
import type {ModelBoundary,ModelEvent,ModelOptions} from "./turn";
import {SYSTEM} from "./prompts";

export function bbModelRef(value:string) {
 const match=/^bb\/([a-z0-9-]+)(?:\/(.+))?$/.exec(value);
 if(!match || match[1]==="optbot") throw new Error("Choose bb/<installed-provider-id>[/<model>], not OptBot itself");
 return {providerId:match[1]!,...(match[2]?{model:match[2]}:{})};
}
export type WorkerCall=(input:Record<string,unknown>)=>Promise<unknown>;
export type WorkerPage={events:ModelEvent[];cursor?:string;done:boolean;open?:{id:string;name:string;input:unknown}[]};
// The worker thread is hidden: an interactive question there would wait forever, so questions go in the reply.
export const STEER_QUIET_MS=8_000;
/** A worker poll goes through BB's server: 250 ms while the worker produces events, up to 2 s while it is quiet. */
export const POLL_MIN_MS=250, POLL_MAX_MS=2_000;
const WORKER_NOTE="You run in a hidden worker thread that nobody watches. Never use interactive question or approval tools such as AskUserQuestion; when you need the user's decision, end your turn and ask in your reply. This thread is closed when your turn ends, which stops anything still running in it: for subagents use optbot_spawn and optbot_tell, which run in their own threads and report back to you, never your built-in agent, task or delegation tools.";
export function bbWorkerModel(call:WorkerCall):ModelBoundary {
 let open:NonNullable<WorkerPage["open"]>=[];
 return {
  unanswered:()=>open,
  async *stream(prompt,options) {
   bbModelRef(options.model); options.signal.throwIfAborted();
   const key=randomUUID();let workerId:string|undefined,cursor:string|undefined,steered=false,idleSince:number|undefined,wait=POLL_MIN_MS;
   const pause=(ms:number)=>new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(options.signal.reason??new Error("Turn cancelled"));};
    const timer=setTimeout(()=>{options.signal.removeEventListener("abort",abort);resolve();},ms);
    if(options.signal.aborted)abort();else options.signal.addEventListener("abort",abort,{once:true});
   });
   try {
    ({workerId}=await call({action:"start",key,model:options.model,prompt,instructions:[SYSTEM,WORKER_NOTE,options.instructions].filter(Boolean).join("\n\n"),permissionMode:options.permissionMode,...(options.reasoningLevel?{reasoningLevel:options.reasoningLevel}:{}),...(options.serviceTier?{serviceTier:options.serviceTier}:{})}) as {workerId:string});
    for(;;) {
     options.signal.throwIfAborted();
     const incoming=options.incoming?.()??[];
     if(incoming.length) {
      await call({action:"steer",workerId,text:incoming.map(message=>message.text).join("\n\n")});
      steered=true;
      for(const message of incoming)yield {kind:"user",...message};
     }
     const page=await call({action:"poll",workerId,...(cursor?{cursor}:{})}) as WorkerPage;
     cursor=page.cursor??cursor; open=page.done?[]:page.open??open;
     for(const event of page.events)if(event.kind!=="result")yield event;
     if(page.done) {
      // A steer the worker accepted may still be waiting inside it: Claude Code answers one that came while it was
      // writing with a follow-up turn a few seconds after going idle (demo: the second subagent report). After a
      // steer, the worker's answer is final only once it has stayed idle for STEER_QUIET_MS.
      if(steered) {
       idleSince??=Date.now();
       if(Date.now()-idleSince<STEER_QUIET_MS){await pause(500);continue;}
      }
      // Messages that came after the worker's last step stay queued: the turn answers them with a new call
      // and a fresh view (UniiChat Server.ts), never by reopening this session.
      for(const event of page.events)if(event.kind==="result")yield event;
      break;
     }
     idleSince=undefined;
     // Each poll is a call through BB's server: quick while the worker produces, backing off while it is quiet.
     wait=page.events.length||incoming.length?POLL_MIN_MS:Math.min(POLL_MAX_MS,Math.round(wait*1.5));
     await pause(wait);
    }
   } finally {
    try {await call({action:"stop",key,...(workerId?{workerId}:{})});}
    catch { /* Durable optbot_workers cleanup_pending records retain diagnostics/handles. */ }
   }
  },
  async summarize() {
   // Summaries need a tool-less text call (§4.2); BB worker threads are full agents.
   throw new Error("BB worker threads do not summarize; use the bb/codex text-only compactor");
  },
 };
}
