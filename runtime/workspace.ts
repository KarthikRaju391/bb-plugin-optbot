import {spawn} from "node:child_process";
import {readFile,open,stat} from "node:fs/promises";
import {resolve} from "node:path";
import {z} from "zod";
import type {AgentTool,ModelOptions} from "./turn";
import {CAP} from "./cache";
const content=(text:string)=>({content:[{type:"text" as const,text}]});
function capture() {
 let head:string[]=[],tail:string[]=[],total=0;
 return {add(value:string){const chars=Array.from(value);total+=chars.length;if(head.length<CAP)head.push(...chars.slice(0,CAP-head.length));tail=tail.concat(chars).slice(-CAP);},text(){if(total<=CAP)return head.join("");const marker=`\n[...middle omitted; original ${total} characters; head and tail retained...]\n`,keep=CAP-Array.from(marker).length,n=Math.floor(keep/2);return head.slice(0,n).join("")+marker+tail.slice(-(keep-n)).join("");}};
}
export function workspaceTools(options:Pick<ModelOptions,"cwd"|"env"|"signal"|"permissionMode">):AgentTool[] {
 function tool<T extends z.ZodObject>(name:string,description:string,schema:T,run:(input:z.infer<T>)=>Promise<string>):AgentTool {
  return {name,description,inputSchema:z.toJSONSchema(schema),async execute(input){options.signal.throwIfAborted();return content(await run(schema.parse(input)));}};
 }
 const tools=[tool("read_file","Read a text file with line numbers. Use offset and limit for large files. Do not read credential files or secrets without the user's explicit request.",z.object({path:z.string().min(1),offset:z.number().int().positive().optional(),limit:z.number().int().min(1).max(1500).optional()}).strict(),async input=>{
  const path=resolve(options.cwd,input.path),info=await stat(path);if(!info.isFile())throw new Error("Not a regular file");if(info.size>16*1024*1024)throw new Error("File is larger than 16 MiB; use bash to stream the required range");
  const raw=await readFile(path,"utf8");if(raw.includes("\0"))throw new Error("Binary file: use an appropriate inspection command");
  const lines=raw.split("\n"),offset=input.offset??1,end=Math.min(lines.length,offset-1+(input.limit??400));
  return lines.slice(offset-1,end).map((line,i)=>`${i+offset}|${line}`).join("\n")+`\n[${end<lines.length?`Continue at line ${end+1}; `:""}${lines.length} lines total]`;
 })];
 if(options.permissionMode==="plan")return tools;
 tools.push(tool("write_file","Write a complete UTF-8 file and fsync it before acknowledging. Existing content is replaced. Inspect existing files before editing; never put credentials in a file without explicit user authorization.",z.object({path:z.string().min(1),content:z.string()}).strict(),async input=>{
  const file=await open(resolve(options.cwd,input.path),"w",0o600);try{await file.writeFile(input.content,"utf8");await file.sync();}finally{await file.close();}return `Wrote ${Buffer.byteLength(input.content)} UTF-8 bytes.`;
 }));
 tools.push(tool("bash","Run a shell command on the execution machine in the workspace. Output is bounded with its head and tail retained. Use for tests, builds and inspection; do not print secrets. Timeout is in seconds.",z.object({command:z.string().min(1),timeout:z.number().int().min(1).max(600).optional()}).strict(),async input=>new Promise<string>((resolveResult,reject)=>{
  const env=Object.fromEntries(Object.entries(options.env).filter(([name,value])=>value!==undefined && !["OPENAI_API_KEY","ANTHROPIC_API_KEY"].includes(name) && !name.startsWith("OPTBOT_"))) as NodeJS.ProcessEnv;
  const child=spawn(input.command,{cwd:options.cwd,env,shell:true,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]}),output=capture();let stopped=false,killTimer:NodeJS.Timeout|undefined;
  const stop=()=>{if(stopped)return;stopped=true;try{if(child.pid&&process.platform!=="win32")process.kill(-child.pid,"SIGTERM");else child.kill("SIGTERM");}catch{}killTimer=setTimeout(()=>{try{if(child.pid&&process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}},500);killTimer.unref();};
  const timer=setTimeout(stop,(input.timeout??60)*1000);options.signal.addEventListener("abort",stop,{once:true});if(options.signal.aborted)stop();
  child.stdout.setEncoding("utf8").on("data",chunk=>output.add(String(chunk)));child.stderr.setEncoding("utf8").on("data",chunk=>output.add(String(chunk)));
  const cleanup=()=>{clearTimeout(timer);options.signal.removeEventListener("abort",stop);};
  child.once("error",error=>{cleanup();if(killTimer)clearTimeout(killTimer);reject(error);});
  child.once("close",(code,signal)=>{cleanup();resolveResult(`Exit code: ${code}; signal: ${signal??"none"}${stopped?" (stopped or timed out)":""}\n${output.text()}`);});
 })));
 return tools;
}
