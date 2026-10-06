import {randomUUID} from "node:crypto";
import type {ModelBoundary,ModelEvent,ModelOptions} from "./turn";

export function bbModelRef(value:string) {
 const match=/^bb\/([a-z0-9-]+)(?:\/(.+))?$/.exec(value);
 if(!match || match[1]==="optbot") throw new Error("Choose bb/<installed-provider-id>[/<model>], not OptBot itself");
 return {providerId:match[1]!,...(match[2]?{model:match[2]}:{})};
}
export type WorkerCall=(input:Record<string,unknown>)=>Promise<unknown>;
export type WorkerPage={events:ModelEvent[];cursor?:string;done:boolean};
export function bbWorkerModel(call:WorkerCall):ModelBoundary {
 return {
  async *stream(prompt,options) {
   bbModelRef(options.model); options.signal.throwIfAborted();
   const key=randomUUID();let workerId:string|undefined,cursor:string|undefined;
   try {
    ({workerId}=await call({action:"start",key,model:options.model,prompt,instructions:options.instructions,permissionMode:options.permissionMode,...(options.reasoningLevel?{reasoningLevel:options.reasoningLevel}:{}),...(options.serviceTier?{serviceTier:options.serviceTier}:{})}) as {workerId:string});
    for(;;) {
     options.signal.throwIfAborted();
     const incoming=options.incoming?.()??[];
     if(incoming.length) {
      await call({action:"steer",workerId,text:incoming.map(message=>message.text).join("\n\n")});
      for(const message of incoming)yield {kind:"user",...message};
     }
     const page=await call({action:"poll",workerId,...(cursor?{cursor}:{})}) as WorkerPage;
     cursor=page.cursor??cursor;
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
  async summarize(prompt,options) {
   let text="";
   for await(const event of this.stream(prompt,{...options,tools:[]})) {
    if(event.kind==="echo"&&event.error)throw new Error(event.text);
    if(event.kind==="result"){if(!event.success)throw new Error(event.text);text=event.text;}
   }
   return text;
  },
 };
}
