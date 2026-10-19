import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentTool, ModelBoundary, ModelEvent, ModelOptions } from "./turn";
import { SPEC_SYSTEM, TURN_HEAD } from "./prompts";
import { cacheBlocks as cacheView, capResult as capToolResult, singleFlight, type TextBlock } from "./cache";
import {providerPayload} from "./response";
import { codexModel } from "./codex";

type JsonObject = Record<string, unknown>;
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter((v): v is JsonObject => Boolean(v) && typeof v === "object" && !Array.isArray(v)) : [];
const text = (value: unknown) => typeof value === "string" ? value : "";
const envelope = z.object({ id: z.string(), output: z.array(z.record(z.string(), z.unknown())).optional(), content: z.array(z.record(z.string(), z.unknown())).optional(), status: z.string().optional(), stop_reason: z.string().nullable().optional(), usage: z.unknown().optional() }).passthrough();
export type ApiOptions = Pick<ModelOptions,"model"|"env"|"signal"|"onUsage"> & { system: string; tools?: AgentTool[]; onThought?:(id:string,text:string)=>void; /** Mark the request's end for the cache (turns); a compaction's task is never marked. */ endMark?: boolean };
export type ApiReply = { text: string; thoughts: {id:string;text:string}[]; calls: {id:string;name:string;input:unknown}[] };
export interface ApiConversation { ask(message?: string): Promise<ApiReply>; addUser(message: string): void; addResult(id: string, result: string, error: boolean): void; close?(): void }
export type ApiFetch = typeof fetch;

/** The model declined: the input's doing, so retrying cannot help (a summary then keeps its source clipped). */
export class Refusal extends Error {}
export function modelRef(value: string):{provider:"openai"|"anthropic";model:string} {
  const aliases:Record<string,string>={sonnet:"anthropic/claude-sonnet-4-6",opus:"anthropic/claude-opus-4-6",haiku:"anthropic/claude-haiku-4-5"};
  const selected=aliases[value]??value, slash=selected.indexOf("/");
  if(slash<1 || slash===selected.length-1 || /\s/.test(selected)) throw new Error("Select provider/model, for example openai/gpt-5.6 or anthropic/claude-sonnet-4-6");
  const provider=selected.slice(0,slash), model=selected.slice(slash+1);
  if(provider!=="openai"&&provider!=="anthropic") throw new Error(`No model adapter registered for ${provider}`);
  return {provider,model};
}
function endpoint(base: string, route: string) {
  const url=new URL(route,base.endsWith("/")?base:base+"/");
  if(url.protocol!=="https:" && !(url.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("Model endpoints must use HTTPS (HTTP is allowed only on loopback)");
  if(url.username||url.password) throw new Error("Configure model credentials separately from the endpoint URL");
  return url.href;
}

/** Each instance is ONE turn or ONE node, never carried into the next turn. */
export function apiConversation(blocks: TextBlock[], options: ApiOptions, network: ApiFetch=(...args)=>fetch(...args)): ApiConversation {
  const {provider,model}=modelRef(options.model);
  const key=options.env[provider==="openai"?"OPENAI_API_KEY":"ANTHROPIC_API_KEY"];
  if(!key) throw new Error(`Configure ${provider==="openai"?"OPENAI_API_KEY":"ANTHROPIC_API_KEY"} on the execution machine; CLI logins are not API credentials`);
  const advanced= /^gpt-(?:[6-9]|5\.(?:[6-9]|\d{2,}))/.test(model);
  const reasoning= /^gpt-[5-9]|^o[134]/.test(model);
  const openBlocks=blocks.map(block=>({type:"input_text",text:block.text,...(block.cache&&advanced?{prompt_cache_breakpoint:{mode:"explicit"}}:{})}));
  const anthropicBlocks=blocks.map(block=>({type:"text",text:block.text,...(block.cache?{cache_control:{type:"ephemeral"}}:{})}));
  const history:JsonObject[]=provider==="openai"?[{role:"developer",content:[{type:"input_text",text:options.system}]},{role:"user",content:openBlocks}]:[{role:"user",content:anthropicBlocks}];
  const tools=options.tools??[];
  function addUser(message:string) { history.push(provider==="openai"?{role:"user",content:[{type:"input_text",text:message}]}:{role:"user",content:[{type:"text",text:message}]}); }
  function addResult(id:string,result:string,error:boolean) {
    if(provider==="openai") history.push({type:"function_call_output",call_id:id,output:result});
    else history.push({role:"user",content:[{type:"tool_result",tool_use_id:id,content:result,is_error:error}]});
  }
  return {addUser,addResult,async ask(message?:string) {
    options.signal.throwIfAborted(); if(message!==undefined) addUser(message);
    const request=provider==="openai"?{
      model,store:false,stream:Boolean(options.onThought)||options.endMark===false,max_output_tokens:16_384,input:history,
      tools:tools.map(tool=>({type:"function",name:tool.name,description:tool.description,parameters:tool.inputSchema,strict:false})),
      ...(reasoning?{reasoning:{effort:"medium",context:"all_turns",summary:"auto"},include:["reasoning.encrypted_content"]}:{}),
      ...(advanced?{prompt_cache_options:{mode:"implicit",ttl:"30m"}}:{}),
    }:{
      // UniiChat Anthropic.ts: the system prompt always marked, the request's end only when its last block is.
      model,stream:Boolean(options.onThought)||options.endMark===false,max_tokens:16_384,system:[{type:"text",text:options.system,cache_control:{type:"ephemeral"}}],messages:history,
      tools:tools.map(tool=>({name:tool.name,description:tool.description,input_schema:tool.inputSchema})),
      ...(options.endMark===false?{}:{cache_control:{type:"ephemeral"}}),
      ...(model.startsWith("claude-sonnet-4-6")||model.startsWith("claude-opus-4-")?{thinking:{type:"adaptive"},output_config:{effort:"medium"}}:{}),
    };
    const url=provider==="openai"?endpoint(options.env.OPTBOT_OPENAI_BASE_URL??"https://api.openai.com/v1/","responses"):endpoint(options.env.OPTBOT_ANTHROPIC_BASE_URL??"https://api.anthropic.com/v1/","messages");
    const response=await singleFlight(model,options.system,blocks,async begun=>{const r=await network(url,{method:"POST",headers:{"content-type":"application/json",...(provider==="openai"?{authorization:`Bearer ${key}`}:{"x-api-key":key,"anthropic-version":"2023-06-01"})},body:JSON.stringify(request),signal:options.signal});begun();return r;});
    // API errors can echo credentials. Never put their raw bodies into memory.
    if(!response.ok) { await response.body?.cancel(); throw new Error(`${provider} model request failed (HTTP ${response.status}); check credentials, model, endpoint and account limits`); }
    const payload=await providerPayload(response,provider,options.signal,options.onThought);
    const decoded=envelope.safeParse(payload.body);if(!decoded.success)throw new Error("Invalid model response envelope; no partial entry is executed or logged");
    const body=decoded.data; options.signal.throwIfAborted(); options.onUsage?.(body.usage);
    if(provider==="openai"&&body.status==="incomplete"&&JSON.stringify(body).includes("content_filter")) throw new Refusal("OpenAI declined the request");
    if(provider==="anthropic"&&body.stop_reason==="refusal") throw new Refusal("Anthropic declined the request");
    if(provider==="openai"&&body.status!=="completed") throw new Error(`OpenAI response is ${body.status??"missing its completion status"}; no partial entry is executed or logged`);
    if(provider==="anthropic" && !["end_turn","tool_use","stop_sequence"].includes(body.stop_reason??"")) throw new Error(`Anthropic response stopped with ${body.stop_reason??"no completion status"}; no partial entry is executed or logged`);
    const items=provider==="openai"?body.output:body.content;
    if(!items) throw new Error("Model response is missing its output entries");
    // Signatures, encrypted reasoning and redacted blocks stay EXACTLY as sent
    // by the provider. Only rendered thoughts are omitted from the ROOT log.
    if(provider==="openai") history.push(...items);
    else history.push({role:"assistant",content:items});
    const reply:ApiReply={text:"",thoughts:[],calls:[]};
    for(const [index,item] of items.entries()) {
      if(provider==="openai") {
        if(item.type==="message"&&objects(item.content).some(part=>part.type==="refusal"||text(part.refusal))) throw new Refusal("OpenAI declined the request");
        if(item.type==="message") reply.text+=objects(item.content).map(part=>text(part.text)).join("\n");
        if(item.type==="reasoning"&&!payload.shown.has(text(item.id))) reply.thoughts.push({id:text(item.id),text:objects(item.summary).map(part=>text(part.text)).join("\n")});
        if(item.type==="function_call") {
          let input:unknown; try {input=JSON.parse(text(item.arguments));} catch { input=item.arguments; }
          reply.calls.push({id:text(item.call_id),name:text(item.name),input});
        }
      } else {
        if(item.type==="text") reply.text+=text(item.text);
        if(item.type==="thinking"&&!payload.shown.has(`${body.id}:${index}`)) reply.thoughts.push({id:`${body.id}:${index}`,text:text(item.thinking)});
        if(item.type==="tool_use") reply.calls.push({id:text(item.id),name:text(item.name),input:item.input});
      }
    }
    return reply;
  }};
}
export function createApiModel(network?:ApiFetch):ModelBoundary {
  return {
    async *stream(prompt,options) {
      if (options.model.startsWith("bb/")) { yield* codexModel.stream(prompt, options); return; }
      // The view's lines hold no newlines, so "</chat>\n" + the turn head first occurs where the view ends.
      const start=prompt.indexOf("<chat>\n"), close=prompt.indexOf("</chat>\n"+TURN_HEAD,start);
      if(start<0||close<start) throw new Error("Invalid OptChat turn layout");
      const split=close+"</chat>\n".length, view=prompt.slice(start,split);let input=prompt.slice(split+TURN_HEAD.length);
    for(const message of options.incoming?.()??[]){yield {kind:"user",id:message.id,text:message.text};input+="\n\n"+message.text;}
      const thoughts:Extract<ModelEvent,{kind:"thought"}>[]=[];let wake:(()=>void)|undefined;
      const conversation=apiConversation([...cacheView(view),{text:input,cache:false}],{...options,system:`${SPEC_SYSTEM}\n\n${options.instructions}`,onThought:(id,text)=>{thoughts.push({kind:"thought",id,text});wake?.();}},network);
      let final="";
      for(;;) {
        let complete:{reply:ApiReply}|{error:unknown}|undefined;
        const query=conversation.ask().then(reply=>{complete={reply};wake?.();},error=>{complete={error};wake?.();});
        while(!complete||thoughts.length){if(thoughts.length)yield thoughts.shift()!;else await new Promise<void>(resolve=>{wake=resolve;});}
        await query;wake=undefined;if("error" in complete)throw complete.error;const reply=complete.reply;
        for(const thought of reply.thoughts) if(thought.text) yield {kind:"thought",...thought};
        if(reply.text) {final=reply.text; yield {kind:"talk",id:randomUUID(),text:reply.text};}
        for(const call of reply.calls) {
          yield {kind:"tool",...call};
          let output:string,error=false;
          try {
            const tool=options.tools.find(tool=>tool.name===call.name);
            if(!tool) throw new Error(`Unknown or disallowed tool: ${call.name}`);
            if(!call.input||typeof call.input!=="object"||Array.isArray(call.input)) throw new Error("Tool input must be a JSON object");
            const result=await tool.execute(call.input as Record<string,unknown>); output=result.content.map(part=>part.text).join("\n"); error=Boolean(result.isError);
          } catch(reason) {output=reason instanceof Error?reason.message:String(reason); error=true;}
          output=capToolResult(output); yield {kind:"echo",id:call.id,text:output,error};
          conversation.addResult(call.id,output,error);
          for(const incoming of options.incoming?.()??[]) {yield {kind:"user",...incoming}; conversation.addUser(incoming.text);}
        }
        if(!reply.calls.length){const pending=options.incoming?.()??[];if(!pending.length)break;for(const incoming of pending){yield {kind:"user",...incoming};conversation.addUser(incoming.text);}}
      }
      yield {kind:"result",success:true,text:final};
    },
    async summarize(prompt,options) {
      if (options.model.startsWith("bb/")) return codexModel.summarize(prompt, options);
      return (await apiConversation([{text:prompt,cache:false}],{...options,system:options.instructions},network).ask()).text;
    },
  };
}
export const apiModel=createApiModel();
