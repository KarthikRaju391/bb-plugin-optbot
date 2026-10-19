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
const WORKER_NOTE="You run in a hidden worker thread that nobody watches. Never use interactive question or approval tools such as AskUserQuestion; when you need the user's decision, end your turn and ask in your reply.";
export function bbWorkerModel(call:WorkerCall):ModelBoundary {
 let open:NonNullable<WorkerPage["open"]>=[];
 return {
  unanswered:()=>open,
  async *stream(prompt,options) {
   bbModelRef(options.model); options.signal.throwIfAborted();
   const key=randomUUID();let workerId:string|undefined,cursor:string|undefined;
   try {
    ({workerId}=await call({action:"start",key,model:options.model,prompt,instructions:[SYSTEM,WORKER_NOTE,options.instructions].filter(Boolean).join("\n\n"),permissionMode:options.permissionMode,...(options.reasoningLevel?{reasoningLevel:options.reasoningLevel}:{}),...(options.serviceTier?{serviceTier:options.serviceTier}:{})}) as {workerId:string});
    for(;;) {
     options.signal.throwIfAborted();
     const incoming=options.incoming?.()??[];
     if(incoming.length) {
      await call({action:"steer",workerId,text:incoming.map(message=>message.text).join("\n\n")});
      for(const message of incoming)yield {kind:"user",...message};
     }
     const page=await call({action:"poll",workerId,...(cursor?{cursor}:{})}) as WorkerPage;
     cursor=page.cursor??cursor; open=page.done?[]:page.open??open;
     for(const event of page.events)if(event.kind!=="result")yield event;
     if(page.done) {
      const late=options.incoming?.()??[];
      if(late.length) {
       await call({action:"steer",workerId,text:late.map(message=>message.text).join("\n\n")});
       for(const message of late)yield {kind:"user",...message};
       continue;
      }

      for(const event of page.events)if(event.kind==="result")yield event;
      break;
     }
     await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);reject(options.signal.reason??new Error("Turn cancelled"));};
      const timer=setTimeout(()=>{options.signal.removeEventListener("abort",abort);resolve();},100);
      if(options.signal.aborted)abort();else options.signal.addEventListener("abort",abort,{once:true});
     });
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
