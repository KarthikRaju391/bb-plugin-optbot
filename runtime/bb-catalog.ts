import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {z} from "zod";
import {reasoningLevelSchema, type AvailableModel} from "@get-bb/plugin-sdk/provider-bridge";
const exec=promisify(execFile);
const providers=z.array(z.object({id:z.string(),displayName:z.string(),available:z.boolean()}).passthrough());
const nativeModels=z.array(z.object({model:z.string(),displayName:z.string(),routeProviderId:z.string().optional(),isDefault:z.boolean().optional(),defaultReasoningEffort:z.string().optional(),supportedReasoningEfforts:z.array(z.object({reasoningEffort:z.string(),description:z.string()})).optional()}).passthrough());
const efforts=reasoningLevelSchema;
// Above this many models a provider (Pi: hundreds of routes) keeps only its default route in the main list.
const LONG_CATALOG=25;
export type Catalog={models:AvailableModel[];selectedOnlyModels:AvailableModel[]};
export type CatalogQuery=(args:string[])=>Promise<unknown>;

/** OptBot's composer catalog: every installed BB provider's models as bb/<provider>/<model>. */
export async function bbCatalog(query:CatalogQuery=cli):Promise<Catalog> {
 const installed=providers.parse(await query(["provider","list"])).filter(provider=>provider.available&&provider.id!=="optbot");
 const groups=await Promise.all(installed.map(async provider=>{
  let models:z.infer<typeof nativeModels>=[];
  try {models=nativeModels.parse(await query(["provider","models",provider.id]));} catch { /* An unreachable provider keeps only its default entry. */ }
  return {provider,models};
 }));
 const main:AvailableModel[]=[],more:AvailableModel[]=[];
 for(const {provider,models} of groups) {
  const preferred=models.find(model=>model.isDefault)??models[0];
  const long=models.length>LONG_CATALOG;
  for(const model of models) {
   const supported=(model.supportedReasoningEfforts??[]).filter(entry=>efforts.safeParse(entry.reasoningEffort).success) as AvailableModel["supportedReasoningEfforts"];
   const fallback=supported[0]?.reasoningEffort??"medium";
   const entry:AvailableModel={id:`bb/${provider.id}/${model.model}`,model:`bb/${provider.id}/${model.model}`,displayName:model.displayName,
    routeProviderId:model.routeProviderId?`${provider.displayName} · ${model.routeProviderId}`:provider.displayName,
    description:`${provider.displayName}: ${model.displayName}`,isDefault:false,
    defaultReasoningEffort:efforts.safeParse(model.defaultReasoningEffort).success?model.defaultReasoningEffort as AvailableModel["defaultReasoningEffort"]:fallback,
    supportedReasoningEfforts:supported.length?supported:[{reasoningEffort:"medium",description:"Provider default"}]};
   (!long||model===preferred||(preferred?.routeProviderId!==undefined&&model.routeProviderId===preferred.routeProviderId)?main:more).push(entry);
  }
  // Older conversations may store bb/<provider> with no model; keep it selectable so BB never swaps it silently.
  more.push({id:`bb/${provider.id}`,model:`bb/${provider.id}`,displayName:`${provider.displayName} default`,routeProviderId:provider.displayName,description:`${provider.displayName}'s configured default model`,isDefault:false,defaultReasoningEffort:"medium",supportedReasoningEfforts:[{reasoningEffort:"medium",description:"Provider default"}]});
 }
 const preferred=main.find(model=>model.id.startsWith("bb/codex/"))??main[0];
 if(preferred)preferred.isDefault=true;
 return {models:main,selectedOnlyModels:more};
}

async function cli(args:string[]) {
 const {stdout}=await exec("bb",[...args,"--json"],{timeout:20_000,maxBuffer:8*1024*1024});
 return JSON.parse(stdout) as unknown;
}

/** model/list is probed often; reuse a catalog for five minutes and keep the last good one on failure. */
export function cachedCatalog(load:()=>Promise<Catalog>=()=>bbCatalog(),ttlMs=300_000,now=Date.now) {
 let last:{at:number;value:Catalog}|undefined,pending:Promise<Catalog>|undefined;
 return async()=>{
  if(last&&now()-last.at<ttlMs)return last.value;
  pending??=load().then(value=>{last={at:now(),value};return value;}).finally(()=>{pending=undefined;});
  try {return await pending;} catch(error) {if(last)return last.value;throw error;}
 };
}
