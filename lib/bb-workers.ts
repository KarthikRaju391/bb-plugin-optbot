import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import type {BbPluginApi,PluginAgentConfigurationContext} from "@get-bb/plugin-sdk";
import {bbModelRef,type WorkerPage} from "../runtime/bb";
import type {ModelEvent} from "../runtime/turn";
import {capResult} from "../runtime/cache";
type NativeItem = Extract<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number], {type:"item/completed"}>["data"]["item"];
// SDK canonical items separate invocation fields from execution/result metadata.
function nativeEvents(item:NativeItem):ModelEvent[] {
 const id=item.id;
 const text=(value:unknown)=>typeof value==="string"?value:JSON.stringify(value)??"";
 const echo=(value:unknown,error=false):ModelEvent=>({kind:"echo",id,text:capResult(text(value)),...(error?{error:true}:{})});
 const tool=(name:string,input:unknown,result:unknown,error=false):ModelEvent[]=>[{kind:"tool",id,name,input},echo(result,error)];
 switch(item.type) {
  case "agentMessage":return [{kind:"talk",id,text:item.text}];
  case "reasoning":return [{kind:"thought",id,text:[...item.summary,...item.content].join("\n")}];
  case "userMessage":case "contextCompaction":return [];
  case "plan":return [{kind:"talk",id,text:item.text}];
  case "planSteps":return [{kind:"talk",id,text:text({steps:item.steps,explanation:item.explanation,status:item.status})}];
  case "toolCall":return tool(item.tool,item.arguments??{},item.error??item.result??"",item.status==="failed"||item.status==="interrupted"||!!item.error);
  case "commandExecution":return tool(item.type,{command:item.command,cwd:item.cwd},{output:item.aggregatedOutput??"",exitCode:item.exitCode,status:item.status,approvalStatus:item.approvalStatus},item.status==="failed"||item.status==="interrupted"||(item.exitCode!==undefined&&item.exitCode!==0));
  case "fileChange":return tool(item.type,{changes:item.changes},{status:item.status,approvalStatus:item.approvalStatus},item.status==="failed"||item.status==="interrupted");
  case "webSearch":return tool(item.type,{queries:item.queries},item.resultText??"");
  case "webFetch":return tool(item.type,{url:item.url,prompt:item.prompt,pattern:item.pattern},item.resultText??"");
  case "imageView":return tool(item.type,{path:item.path},"");
  case "imageGeneration":return tool(item.type,{prompt:item.prompt,transparentBackground:item.transparentBackground},item.error??item.result??item.path??"",item.status==="failed"||item.status==="interrupted"||!!item.error);
  case "fileRead":return tool(item.type,{path:item.path,cmd:item.cmd},{status:item.status},item.status==="failed"||item.status==="interrupted");
  case "search":return tool(item.type,{query:item.query,path:item.path,mode:item.mode,cmd:item.cmd},{status:item.status},item.status==="failed"||item.status==="interrupted");
  case "backgroundTask":return item.skipTranscript?[]:tool(item.type,{description:item.description,taskType:item.taskType},{summary:item.summary,error:item.error,outputFile:item.outputFile,status:item.status,taskStatus:item.taskStatus},item.status==="failed"||item.status==="interrupted"||!!item.error);
  case "delegation":return tool(item.type,{label:item.label,childRef:item.childRef,background:item.background},{summary:item.summary,status:item.status},item.status==="failed"||item.status==="interrupted");
  // Extension payloads have no invocation contract; retain evidence, never invent arguments.
  case "extension":return [echo({kind:item.kind,payload:item.payload,status:item.status},item.status==="failed"||item.status==="interrupted")];
 }
}

export const workerInput=z.object({action:z.enum(["start","poll","stop","steer"]),key:z.string().uuid().optional(),workerId:z.string().optional(),model:z.string().optional(),prompt:z.string().optional(),instructions:z.string().optional(),permissionMode:z.enum(["full","plan","auto","accept-edits"]).optional(),reasoningLevel:z.enum(["high","low","max","medium","none","ultra","ultracode","xhigh"]).optional(),serviceTier:z.enum(["default","fast"]).optional(),cursor:z.string().regex(/^\d+$/).optional(),text:z.string().optional()}).strict();
type Row={key:string;parent:string|null;bot:string|null;worker:string|null;fingerprint:string;instructions:string;role:"master"|"summary";status:string;pending_result:string|null};
// BB's server can freeze for seconds (synchronous SQLite) and drop a connection mid-request.
// A running worker is unaffected, so read-only checks retry instead of failing the turn.
const NETWORK=/fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR|other side closed/i;
function transientNetworkError(error:unknown) {
 const cause=(error as {cause?:{code?:string;message?:string}})?.cause;
 return error instanceof Error&&(NETWORK.test(error.message)||NETWORK.test(String(cause?.code??""))||NETWORK.test(String(cause?.message??"")));
}
export async function retryReads<T>(read:()=>Promise<T>,delays:readonly number[]=[250,1000,3000,8000],sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))):Promise<T> {
 for(let attempt=0;;attempt++) {
  try {return await read();}
  catch(error) {if(!transientNetworkError(error)||attempt>=delays.length)throw error;await sleep(delays[attempt]!);}
 }
}
export function createBbWorkers(bb:BbPluginApi,options:{retryDelays?:readonly number[]}={}) {
 const read=<T,>(fn:()=>Promise<T>)=>retryReads(fn,options.retryDelays);
 const db=bb.storage.database();
 db.exec("CREATE TABLE IF NOT EXISTS optbot_workers (key TEXT PRIMARY KEY,parent TEXT,bot TEXT,worker TEXT UNIQUE,fingerprint TEXT NOT NULL,instructions TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL)");
 if(!(db.prepare("PRAGMA table_info(optbot_workers)").all() as {name:string}[]).some(column=>column.name==="pending_result"))db.exec("ALTER TABLE optbot_workers ADD COLUMN pending_result TEXT");
 db.exec("CREATE TABLE IF NOT EXISTS optbot_worker_cancellations (key TEXT PRIMARY KEY,parent TEXT,bot TEXT)");
 const locks=new Map<string,Promise<unknown>>();
 let closed=false;
 async function locked<T>(key:string,operation:()=>Promise<T>):Promise<T> {
  const previous=locks.get(key);const run=(previous??Promise.resolve()).catch(()=>{}).then(operation);
  locks.set(key,run);try{return await run;}finally{if(locks.get(key)===run)locks.delete(key);}
 }
 function find(worker:string){return db.prepare("SELECT * FROM optbot_workers WHERE worker=?").get(worker) as Row|undefined;}
 function configuration(ctx:PluginAgentConfigurationContext) {
  const key=ctx.pluginMetadata.workerKey;
  const row=typeof key==="string"?db.prepare("SELECT * FROM optbot_workers WHERE key=?").get(key) as Row|undefined:undefined;
  if(!row || (row.worker && row.worker!==ctx.thread.id) || ctx.provider.id==="optbot")return null;
  if(!row.worker) {
   // The UUID must match a private, server-issued pending request; metadata alone grants nothing.
   // Track its worker before the spawn RPC returns. This does not adopt a user conversation.
   db.prepare("UPDATE optbot_workers SET worker=? WHERE key=? AND worker IS NULL").run(ctx.thread.id,row.key);
   if(find(ctx.thread.id)?.key!==row.key)return null;
  }
  if(db.prepare("SELECT key FROM optbot_worker_cancellations WHERE key=?").get(row.key))throw new Error("OptBot worker request was cancelled before execution");
  return {botId:row.bot,role:row.role,instructions:row.instructions};
 }
 async function start(args:{key:string;model:string;prompt:string;instructions:string;permissionMode:NonNullable<z.infer<typeof workerInput>["permissionMode"]>;reasoningLevel?:z.infer<typeof workerInput>["reasoningLevel"];serviceTier?:z.infer<typeof workerInput>["serviceTier"];parent:string|null;bot:string|null;environment:Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"];projectId:string;role:"master"|"summary"}) {
  const prior=locks.get(args.key);
  const run=(prior??Promise.resolve()).catch(()=>{}).then(async()=>{
   if(closed)throw new Error("OptBot workers are shutting down");
   if(db.prepare("SELECT key FROM optbot_worker_cancellations WHERE key=?").get(args.key))throw new Error("Worker request was cancelled");
   const ref=bbModelRef(args.model);
   if(args.permissionMode==="plan")throw new Error("BB worker delegation does not yet support Plan mode; no worker was started");
   const fingerprint=createHash("sha256").update(JSON.stringify(args)).digest("hex");
   const row=db.prepare("SELECT * FROM optbot_workers WHERE key=?").get(args.key) as Row|undefined;
   if(row){if(row.fingerprint!==fingerprint)throw new Error("Worker key reused with different input");if(!row.worker)throw new Error("Worker spawn was interrupted; retry with a fresh request");return {workerId:row.worker};}
   db.prepare("INSERT INTO optbot_workers (key,parent,bot,worker,fingerprint,instructions,role,status) VALUES (?,?,?,?,?,?,?,?)").run(args.key,args.parent,args.bot,null,fingerprint,args.instructions,args.role,"starting");
   const worker=await bb.sdk.threads.spawn({projectId:args.projectId,environment:args.environment,...ref,...(args.reasoningLevel?{reasoningLevel:args.reasoningLevel}:{}),...(args.serviceTier?{serviceTier:args.serviceTier}:{}),prompt:`${args.instructions}\n\n${args.prompt}`,title:args.role==="summary"?"OptBot memory summary":"OptBot execution",visibility:"hidden",permissionMode:args.role==="summary"?"auto":args.permissionMode,pluginMetadata:{workerKey:args.key},...(args.parent?{lifecycleOwnerThreadId:args.parent}:{})});
   db.prepare("UPDATE optbot_workers SET worker=?,status='active' WHERE key=?").run(worker.id,args.key);
   if(db.prepare("SELECT key FROM optbot_worker_cancellations WHERE key=?").get(args.key)){await stop(worker.id);throw new Error("Worker request was cancelled");}
   if(closed){await bb.sdk.threads.stop({threadId:worker.id});throw new Error("OptBot workers are shutting down");}
   return {workerId:worker.id};
  });
  locks.set(args.key,run);try{return await run;}finally{if(locks.get(args.key)===run)locks.delete(args.key);}
 }
 async function poll(workerId:string,cursor?:string):Promise<WorkerPage> {return locked(`worker:${workerId}`,async()=>{
  const rows=await read(()=>bb.sdk.threads.events.list({threadId:workerId,afterSeq:cursor,order:"asc",limit:"100",types:["item/completed","turn/completed","system/thread/interrupted"]}));
  const events:ModelEvent[]=[];let done=false;
  for(const row of rows) {
   cursor=String(row.seq);
   if(row.type==="item/completed") {
    const item=row.data.item;
    events.push(...nativeEvents(item));
   } else if(row.type==="turn/completed") {
    const result:ModelEvent={kind:"result",success:row.data.status==="completed",text:row.data.status==="completed"?"":row.data.error?.message??`BB worker ${row.data.status}`};
    db.prepare("UPDATE optbot_workers SET pending_result=? WHERE worker=?").run(JSON.stringify(result),workerId);
   } else if(row.type==="system/thread/interrupted") {
    throw new Error(`Native execution was interrupted: @thread:${workerId}`);
   }
  }
  if(rows.length<100) {
   const thread=await read(()=>bb.sdk.threads.get({threadId:workerId}));
   const queued=thread.queuedMessageCount??(await read(()=>bb.sdk.threads.queuedMessages.list({threadId:workerId}))).length;
   const row=find(workerId);
   const failed=row?.pending_result?JSON.parse(row.pending_result) as Extract<ModelEvent,{kind:"result"}>:null;
   if(failed&&!failed.success&&(thread.status==="idle"||thread.status==="error")&&queued===0){events.push(failed);done=true;}
   if(!done&&(thread.status==="error" || thread.deletedAt!==null))throw new Error("BB worker failed or was deleted; original history is retained");
   if(!done&&thread.status==="idle" && queued===0) {
    if(row?.pending_result) {
     const result=JSON.parse(row.pending_result) as Extract<ModelEvent,{kind:"result"}>;
     if(result.success)result.text=(await read(()=>bb.sdk.threads.output({threadId:workerId}))).output??events.filter(e=>e.kind==="talk").at(-1)?.text??"";
     events.push(result);done=true;
    } else if(Date.now()-thread.updatedAt>2000)throw new Error(`Native worker ended without a completion: @thread:${workerId}`);
   }
  }
  if(done)db.prepare("UPDATE optbot_workers SET status='completed' WHERE worker=?").run(workerId);
  return {events,cursor,done};
 });}
 async function stop(workerId:string) {return locked(`worker:${workerId}`,async()=>{
  const row=find(workerId);if(!row||row.status==="stopped")return;
  db.prepare("UPDATE optbot_workers SET status='cleanup_pending' WHERE worker=?").run(workerId);
  for(let attempt=0;;attempt++)try {
   const thread=await bb.sdk.threads.get({threadId:workerId});
   if(thread.status!=="idle"&&thread.deletedAt===null)await bb.sdk.threads.stop({threadId:workerId});
   if(thread.deletedAt===null)await bb.sdk.threads.archive({threadId:workerId});
   db.prepare("UPDATE optbot_workers SET status='stopped' WHERE worker=?").run(workerId);break;
  } catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));}
 });}
 async function cancelKey(key:string,parent:string|null,bot:string|null) {
  const existing=db.prepare("SELECT * FROM optbot_workers WHERE key=?").get(key) as Row|undefined;
  if(existing&&(existing.parent!==parent||existing.bot!==bot))throw new Error("Worker key does not belong to this conversation");
  db.prepare("INSERT OR IGNORE INTO optbot_worker_cancellations (key,parent,bot) VALUES (?,?,?)").run(key,parent,bot);
  await (locks.get(key)??Promise.resolve()).catch(()=>{});
  const row=db.prepare("SELECT * FROM optbot_workers WHERE key=?").get(key) as Row|undefined;
  if(!row)return;
  if(row.parent!==parent||row.bot!==bot)throw new Error("Worker key does not belong to this conversation");
  if(row.worker)await stop(row.worker);
 }
 async function execute(raw:z.infer<typeof workerInput>,parent:string,bot:string) {
  if(raw.action==="start") {
   if(!raw.key||!raw.model||raw.prompt===undefined)throw new Error("Worker start requires key, model and prompt");
   const {model,reasoningLevel,serviceTier}=raw;
   const thread=await read(()=>bb.sdk.threads.get({threadId:parent}));
   if(!thread.environmentId)throw new Error("Parent conversation has no execution environment");
   return start({key:raw.key,model,prompt:raw.prompt,instructions:raw.instructions??"",// OptBot always runs workers with Full access, whatever the model (user decision).
   permissionMode:raw.permissionMode==="plan"?"plan":"full",...(reasoningLevel?{reasoningLevel}:{}),...(serviceTier?{serviceTier}:{}),parent,bot,projectId:thread.projectId,environment:{type:"reuse",environmentId:thread.environmentId},role:"master"});
  }
  if(raw.action==="stop"&&raw.key){await cancelKey(raw.key,parent,bot);return {};}
  const row=raw.workerId?find(raw.workerId):undefined;
  if(!row||row.parent!==parent||row.bot!==bot)throw new Error("Worker does not belong to this conversation");
  if(raw.action==="poll")return poll(row.worker!,raw.cursor);
  if(raw.action==="stop"){await stop(row.worker!);return {};}
  if(!raw.text)throw new Error("Worker steering needs text");
  if(row.status==="stopped")throw new Error("Worker is already closed");
  return locked(`worker:${row.worker}`,async()=>{
  const current=await bb.sdk.threads.get({threadId:row.worker!});
  let startedNewTurn=current.status==="idle"&&current.queuedMessageCount===0;
  const input=[{type:"text" as const,text:raw.text!,mentions:[]}];
  try { await bb.sdk.threads.send({threadId:row.worker!,mode:startedNewTurn?"start":"steer",input}); }
  catch(error) {
    const thread=await bb.sdk.threads.get({threadId:row.worker!});
    if(startedNewTurn||thread.status!=="idle")throw error;
    await bb.sdk.threads.send({threadId:row.worker!,mode:"start",input});startedNewTurn=true;
  }
  db.prepare("UPDATE optbot_workers SET status='active',pending_result=NULL WHERE worker=?").run(row.worker!);
  return {startedNewTurn};
  });
 }
 async function cancelParent(parent:string) {
  const rows=db.prepare("SELECT * FROM optbot_workers WHERE parent=? AND status!='stopped'").all(parent) as Row[];
  await Promise.all(rows.map(row=>cancelKey(row.key,row.parent,row.bot)));
 }
 for(const event of ["thread.idle","thread.failed","thread.archived","thread.deleted"] as const)bb.events.on(event,async({thread})=>{await cancelParent(thread.id);});
 const oldRows=db.prepare("SELECT * FROM optbot_workers WHERE status!='stopped'").all() as Row[];
 const recovery=Promise.all(oldRows.map(async row=>{
  try {
   if(!row.parent||!(await bb.sdk.threads.get({threadId:row.parent})).status.match(/^(active|starting|pending)$/))await cancelKey(row.key,row.parent,row.bot);
  } catch {bb.log.warn("OptBot worker recovery remains pending; inspect the hidden worker timeline.");}
 }));
 bb.onDispose(async()=>{closed=true;await recovery;await Promise.allSettled([...locks.values()]);const rows=db.prepare("SELECT worker FROM optbot_workers WHERE worker IS NOT NULL AND status!='stopped'").all() as {worker:string}[];await Promise.all(rows.map(row=>stop(row.worker)));});
 return {configuration,owner:(threadId:string)=>{const row=find(threadId);return row?.status==="stopped"?null:row?.bot??null;},execute,start,poll,stop,cancelKey,key:randomUUID};
}
