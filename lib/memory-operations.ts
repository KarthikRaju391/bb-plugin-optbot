import type {PluginCliContext} from "@get-bb/plugin-sdk";
import type {BotStore} from "./bot-store";
import type {OptChat} from "./optchat";
import {z} from "zod";
const row=z.object({i:z.number().int().nonnegative().optional(),kind:z.enum(["user","talk","tool","echo","note"]),text:z.string(),date:z.string().datetime({offset:true}).optional(),eventKey:z.string().optional(),threadId:z.string().optional()});
const tree=z.object({l:z.number().int().min(0).max(52),i:z.number().int().nonnegative(),text:z.string().min(1),size:z.number().int().nonnegative()});
export const IMPORT_SCHEMA=z.union([z.array(row),z.object({version:z.literal(1),main:z.array(row),tree:z.array(tree).optional()}).passthrough()]);
const escape=(value:unknown)=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
export function memoryCommands(store:BotStore,chat:OptChat&{wake:(bot:string)=>void},resolveOwner:(thread:string)=>Promise<string|null>){
 return async(argv:string[],ctx:PluginCliContext)=>{
  const [action,selector,data,...extra]=argv;if(!action||!selector||extra.length||!["import","backup","browse","view"].includes(action)||(action==="import"?!data:data!==undefined))throw new Error("Usage: bb optbot memory <view|browse|backup> <bot-id>, or memory import <bot-id> '<JSON array or backup>'. Import in modest sequential chunks; supplied IDs must match permanent IDs.");
  const bot=store.require(selector);if(ctx.threadId&&await resolveOwner(ctx.threadId)!==bot.id)throw new Error("This conversation cannot access another bot's private history");
  if(action==="import"&&ctx.threadId)throw new Error("Memory imports are operator-only; agents do not edit their history");
  ctx.signal?.throwIfAborted();chat.hydrate(bot.id);
  if(action==="import") {const parsed=IMPORT_SCHEMA.parse(JSON.parse(data!));const entries=Array.isArray(parsed)?parsed:parsed.main,nodes=Array.isArray(parsed)?[]:parsed.tree??[];const result=chat.importEntries(bot.id,entries,nodes);chat.wake(bot.id);return {exitCode:0,stdout:JSON.stringify(result)};}
  const snapshot=chat.snapshot(bot.id);
  if(action==="backup")return {exitCode:0,stdout:JSON.stringify(snapshot)};
  if(action==="view")return {exitCode:0,stdout:snapshot.view};
  const levels=new Map<number,typeof snapshot.tree>();for(const node of snapshot.tree){const list=levels.get(node.l)??[];list.push(node);levels.set(node.l,list);}
  const sections=[...levels].sort(([a],[b])=>a-b).map(([level,nodes])=>`<section><h2>Level ${level}</h2>${nodes.sort((a,b)=>a.i-b.i).map(node=>{const n=2**level,start=node.i*n,first=snapshot.main[start],last=snapshot.main[start+n-1];return `<details><summary>${start}+${n} · ${escape(first?.date)} – ${escape(last?.date)} · ${node.size} bytes</summary><pre>${escape(node.text)}</pre><a href="#message-${start}">Original span starts here</a></details>`;}).join("")}</section>`).join("");
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(bot.name)} · private OptChat history</title><style>body{font:14px/1.6 system-ui;max-width:90rem;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}details{border:1px solid #8885;padding:.6rem;margin:.5rem 0}summary{cursor:pointer}</style><h1>${escape(bot.name)} · private history</h1><p>This page includes original user and tool content. Keep it private.</p><h2>Current view</h2><pre>${escape(snapshot.view)}</pre><h2>ROOT · ${snapshot.main.length} messages</h2>${snapshot.main.map(message=>`<details id="message-${message.i}"><summary>${message.i}+0 · ${escape(message.kind)} · ${escape(message.date)} · ${message.size} bytes</summary><pre>${escape(message.kind+": "+message.text)}</pre></details>`).join("")}${sections}</html>`;
  return {exitCode:0,stdout:html};
 };
}
