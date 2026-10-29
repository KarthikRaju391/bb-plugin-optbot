import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive, type Receipt } from "../lib/archive";
import { createOptChat } from "../lib/optchat";

const cleanups: (() => Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
const bot="synthetic_bot", thread="synthetic_thread", now=100_000;
const date="2026-01-01T00:00:00.000Z";

async function fixture(count:number) {
  const root=mkdtempSync(join(tmpdir(),"optchat-recover-perf-"));
  const folder=join(root,bot);
  mkdirSync(join(folder,"main"),{recursive:true});
  mkdirSync(join(folder,"inbox"),{recursive:true});
  const receipts:Receipt[]=Array.from({length:count},(_,i)=>({id:`old-${i}`,parentId:`parent-${i}`,threadId:thread,text:`message ${i}`,date}));
  const main=receipts.map((r,i)=>({i,kind:"user",text:r.text,size:Buffer.byteLength(`user: ${r.text}`),date,eventKey:`${r.id}:input`,threadId:thread}));
  const mainPath=join(folder,"main","2026-01-01.jsonl");
  writeFileSync(mainPath,main.map(row=>JSON.stringify(row)+"\n").join(""));
  writeFileSync(join(folder,"inbox","2026-01-01.jsonl"),receipts.map(row=>JSON.stringify(row)+"\n").join(""));
  const archive=await openArchive(root);
  const db=new Database(":memory:");
  const chat=createOptChat(db,{archive,now:()=>now});
  chat.hydrate(bot);
  cleanups.push(async()=>{db.close();await archive.close();rmSync(root,{recursive:true,force:true});});
  return {archive,chat,db,mainPath};
}

it("does not rescan all historical receipts once per completed parent",async()=>{
  const {archive,chat,db,mainPath}=await fixture(200);
  const original=readFileSync(mainPath);
  const receipts=archive.receipts(bot), values=receipts.values.bind(receipts);
  let visited=0;
  Object.defineProperty(receipts,"values",{value:function*(){for(const row of values()){visited++;yield row;}}});
  chat.recoverQueued(bot);
  expect(visited).toBeLessThanOrEqual(receipts.size*2);
  expect(db.prepare("SELECT count(*) AS n FROM optchat_log").get()).toEqual({n:200});
  expect(readFileSync(mainPath)).toEqual(original);
});

it("does not look up already acknowledged receipts again on later recoveries",async()=>{
  const {chat,db}=await fixture(200);
  const prepare=db.prepare.bind(db);
  let lookups=0;
  db.prepare=((sql:string)=>{
    const statement=prepare(sql);
    if(!/FROM optchat_log WHERE bot_id=\? AND event_key=\?/.test(sql))return statement;
    const get=statement.get.bind(statement);
    return Object.assign(statement,{get:(...args:unknown[])=>{lookups++;return get(...args);}});
  }) as typeof db.prepare;
  chat.recoverQueued(bot);
  expect(lookups).toBe(200);
  lookups=0;
  chat.recoverQueued(bot);
  expect(lookups).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM optchat_log").get()).toEqual({n:200});
});

it("preserves parent ordering, active leases, unknown waiting parents, and recovery idempotence",async()=>{
  const {archive,chat,db}=await fixture(2);
  // Warm the acknowledged cache first: parents whose first receipt is cached must keep their place in the order.
  chat.recoverQueued(bot);
  const receive=(id:string,parentId:string)=>archive.receive(bot,{id,parentId,threadId:thread,text:id,date});
  receive("new-parent-one","new-parent");
  receive("old-parent-one","parent-0");
  receive("waiting","live");
  receive("unknown-waiting","unknown");
  receive("expired","expired");
  const run=db.prepare("INSERT INTO optchat_runs(bot_id,request_id,thread_id,lease,expires,status,result) VALUES (?,?,?,?,?,?,?)");
  run.run(bot,"parent-0",thread,"old-lease",0,"completed","");
  run.run(bot,"new-parent",thread,"new-lease",0,"completed","");
  run.run(bot,"live",thread,"active-lease",now+1000,"active","");
  run.run(bot,"expired",thread,"expired-lease",now-1,"failed","");
  chat.recoverQueued(bot);
  const keys=()=>db.prepare("SELECT event_key AS key FROM optchat_log ORDER BY idx").all().map(row=>(row as {key:string}).key);
  expect(keys()).toEqual(["old-0:input","old-1:input","old-parent-one:input","new-parent-one:input","expired:input"]);
  chat.recoverQueued(bot);
  expect(keys()).toHaveLength(5);
  db.prepare("UPDATE optchat_runs SET status='completed',expires=0 WHERE bot_id=? AND request_id='live'").run(bot);
  chat.recoverQueued(bot);
  expect(keys().slice(-2)).toEqual(["waiting:input","unknown-waiting:input"]);
  chat.recoverQueued(bot);
  expect(keys()).toHaveLength(7);
});

it("does not treat a matching receipt id in another conversation as acknowledged",async()=>{
  const {chat,db}=await fixture(1);
  db.prepare("UPDATE optchat_log SET thread_id='other_conversation'").run();
  expect(()=>chat.recoverQueued(bot)).toThrow("Conflicting duplicate memory event");
  expect(db.prepare("SELECT count(*) AS n FROM optchat_log").get()).toEqual({n:1});
});

it("recovers a receipt whose turn is still marked active but whose lease has expired",async()=>{
  const {archive,chat,db}=await fixture(1);
  archive.receive(bot,{id:"stale",parentId:"stale-turn",threadId:thread,text:"stale",date});
  db.prepare("INSERT INTO optchat_runs(bot_id,request_id,thread_id,lease,expires,status,result) VALUES (?,?,?,?,?,?,?)")
    .run(bot,"stale-turn",thread,"stale-lease",now-1,"active","");
  chat.recoverQueued(bot);
  expect(db.prepare("SELECT event_key AS key FROM optchat_log WHERE bot_id=? ORDER BY idx").all(bot)).toEqual([{key:"old-0:input"},{key:"stale:input"}]);
});

it("keeps acknowledged receipts separate for each bot",async()=>{
  const {archive,chat,db}=await fixture(1);
  const other="synthetic_bot_two";
  // The same receipt id is already in the first bot's memory, but not yet in the second bot's.
  archive.receive(other,{id:"old-0",parentId:"parent-0",threadId:thread,text:"message 0",date});
  chat.recoverQueued(bot);
  chat.hydrate(other);
  chat.recoverQueued(other);
  expect(db.prepare("SELECT event_key AS key FROM optchat_log WHERE bot_id=?").all(other)).toEqual([{key:"old-0:input"}]);
});
