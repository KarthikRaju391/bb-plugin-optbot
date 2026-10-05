import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {z} from "zod";
const exec=promisify(execFile);
const providers=z.array(z.object({id:z.string(),displayName:z.string(),available:z.boolean()}));
const reasoning=z.enum(["none","minimal","low","medium","high","xhigh","max","ultra"]);
const models=z.array(z.object({id:z.string(),model:z.string(),displayName:z.string(),defaultReasoningEffort:reasoning.optional(),supportedReasoningEfforts:z.array(z.object({reasoningEffort:reasoning,description:z.string()})).optional()}));
/** Catalog discovery goes through BB, never a vendor CLI or credential store. */
export async function bbCatalog(cwd?:string,query?: (args:string[])=>Promise<unknown>) {
 const routing=process.env.BB_ENVIRONMENT_ID?["--environment",process.env.BB_ENVIRONMENT_ID]:[];
 const read=query??(async(args:string[])=>{
  const {stdout}=await exec(process.env.BB_CLI||"bb",[...args,...routing,"--json"],{cwd,timeout:20_000,maxBuffer:2*1024*1024});
  return JSON.parse(stdout) as unknown;
 });
 const available=providers.parse(await read(["provider","list"])).filter(provider=>provider.available&&provider.id!=="optbot");
 const groups=await Promise.all(available.map(async provider=>{
  const fallback={id:`bb/${provider.id}`,displayName:`BB ${provider.displayName} — configured default`,isDefault:provider.id==="codex",defaultReasoningEffort:"medium" as const,supportedReasoningEfforts:[{reasoningEffort:"medium" as const,description:"BB provider default"}]};
  try {
   const catalog=models.parse(await read(["provider","models",provider.id]));
   return [fallback,...catalog.map(model=>({id:`bb/${provider.id}/${model.model}`,displayName:`BB ${provider.displayName} · ${model.displayName}`,isDefault:false,defaultReasoningEffort:model.defaultReasoningEffort??fallback.defaultReasoningEffort,supportedReasoningEfforts:model.supportedReasoningEfforts?.length?model.supportedReasoningEfforts:fallback.supportedReasoningEfforts}))];
  } catch { return [fallback]; }
 }));
 const result=groups.flat();
 if(result.length&&!result.some(model=>model.isDefault))result[0]!.isDefault=true;
 return result;
}
