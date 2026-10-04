type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue=>value&&typeof value==="object"&&!Array.isArray(value)?value as ObjectValue:{};
/** Decode transport frames, never expose malformed provider bodies in memory. */
export async function providerPayload(response:Response,provider:"openai"|"anthropic",signal:AbortSignal,onThought?:(id:string,text:string)=>void){
 const shown=new Set<string>();
 if(!response.headers.get("content-type")?.includes("text/event-stream")){try{return {body:await response.json(),shown};}catch{signal.throwIfAborted();throw new Error("Invalid model response JSON; no partial entry is executed or logged");}}
 if(!response.body)throw new Error("Model response has no stream");
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="",final:ObjectValue|undefined,anthropic:ObjectValue|undefined;
 const blocks=new Map<number,ObjectValue>(),argumentsText=new Map<number,string>(),emitted=new Set<string>();
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
 function thought(id:string,text:unknown,rawId:string){if(!onThought||typeof text!=="string"||!text||emitted.has(id))return;emitted.add(id);shown.add(rawId);onThought(id,text);}
 function consume(frame:string){
  const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");if(!data||data==="[DONE]")return;
  let value:ObjectValue;try{value=object(JSON.parse(data));}catch{throw new Error("Invalid model stream frame; no partial entry is executed or logged");}
  if(provider==="openai"){
   if(value.type==="response.reasoning_summary_text.done"){const id=String(value.item_id??"");thought(`${id}:${value.summary_index??0}`,value.text,id);}
   if(value.type==="response.completed"||value.type==="response.incomplete")final=object(value.response);
   if(value.type==="response.failed"||value.type==="error")throw new Error("OpenAI stream failed; no partial entry is executed or logged");
   return;
  }
  const index=typeof value.index==="number"?value.index:0;
  if(value.type==="message_start")anthropic={...object(value.message)};
  else if(value.type==="content_block_start")blocks.set(index,{...object(value.content_block)});
  else if(value.type==="content_block_delta"){
   const block=blocks.get(index),delta=object(value.delta);if(!block)throw new Error("Model stream references an unopened block");
   if(delta.type==="input_json_delta")argumentsText.set(index,(argumentsText.get(index)??"")+String(delta.partial_json??""));
   else if(delta.type==="text_delta")block.text=String(block.text??"")+String(delta.text??"");
   else if(delta.type==="thinking_delta")block.thinking=String(block.thinking??"")+String(delta.thinking??"");
   else if(delta.type==="signature_delta")block.signature=String(block.signature??"")+String(delta.signature??"");
   else if(delta.type==="citations_delta")block.citations=[...(Array.isArray(block.citations)?block.citations:[]),delta.citation];
   else throw new Error("Unsupported model content delta; no partial entry is executed or logged");
  }else if(value.type==="content_block_stop"){
   const block=blocks.get(index);if(!block)throw new Error("Model stream closes an unopened block");
   if(argumentsText.has(index)){try{block.input=JSON.parse(argumentsText.get(index)!);}catch{throw new Error("Incomplete streamed tool arguments; no partial tool is executed");}}
   if(block.type==="thinking"){const id=`${String(anthropic?.id??"")}:${index}`;thought(id,block.thinking,id);}
  }else if(value.type==="message_delta"){
   if(!anthropic)throw new Error("Model stream has no message header");Object.assign(anthropic,object(value.delta));anthropic.usage={...object(anthropic.usage),...object(value.usage)};
  }else if(value.type==="message_stop"){
   if(!anthropic)throw new Error("Model stream has no message header");final={...anthropic,content:[...blocks].sort(([a],[b])=>a-b).map(([,block])=>block)};
  }else if(value.type==="error")throw new Error("Anthropic stream failed; no partial entry is executed or logged");
 }
 try{
  for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,"\n");let end:number;while((end=buffer.indexOf("\n\n"))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+2);}}
  buffer+=decoder.decode();if(buffer.trim())consume(buffer);signal.throwIfAborted();if(!final)throw new Error("Model stream ended without a completed response; no partial entry is executed or logged");return {body:final,shown};
 }finally{signal.removeEventListener("abort",abort);reader.releaseLock();}
}
