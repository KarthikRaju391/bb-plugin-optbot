import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const mainSchema = z.object({ i: z.number().int().nonnegative(), kind: z.enum(["user", "talk", "tool", "echo", "work", "note"]), text: z.string(), size: z.number().int().nonnegative(), date: z.string().datetime(), eventKey: z.string().optional(), threadId: z.string().optional() });
const viewSchema = z.array(z.tuple([z.number().int().nonnegative().max(52), z.number().int().nonnegative()]));
const treeSchema = z.object({ l: z.number().int().nonnegative().max(52), i: z.number().int().nonnegative(), text: z.string(), size: z.number().int().nonnegative() });
export type MainLine = z.infer<typeof mainSchema>;
const receiptSchema=z.object({id:z.string().min(1),parentId:z.string().min(1),threadId:z.string(),text:z.string(),date:z.string().datetime()}).strict();
export type Receipt=z.infer<typeof receiptSchema>;
export type TreeLine = z.infer<typeof treeSchema>;
const bytes = (s: string) => Buffer.byteLength(s);
function localDay(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
function directory(path: string) {
  if (existsSync(path)) { if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("Unsafe OptChat directory"); return; }
  directory(dirname(path)); mkdirSync(path, { mode: 0o700 });
  const fd = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeLine(path: string, value: unknown) {
  directory(dirname(path));
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("Unsafe OptChat stream");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const data = Buffer.from(JSON.stringify(value)+"\n");
    if (writeSync(fd, data) !== data.length) throw new Error("Incomplete OptChat write");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const dir = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** One process owns all per-bot streams. The socket is an OS-lifetime lock, not a PID/TTL lock. */
async function createArchive(rootPath: string, warn: (message: string) => void = () => {}) {
  directory(resolve(rootPath)); const root = realpathSync(resolve(rootPath));
  // Unix socket paths have a small platform limit. Hash only the lock address;
  // canonical data still lives under the plugin's private chat directory.
  const socketPath = bytes(join(root,"lock")) < 100 ? join(root,"lock") : join(tmpdir(), `optbot-${createHash("sha256").update(root).digest("hex").slice(0,24)}.sock`);
  // A short OS-held SQLite lock serializes probe/remove/bind. Without it two
  // delayed ECONNREFUSED callbacks can unlink a newly live writer's socket.
  // There is no PID file, lease or expiry: process death releases both locks.
  const gatePath=join(root,".writer-gate.sqlite3");
  const gateFd=openSync(gatePath,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);closeSync(gateFd);
  const gate=new Database(gatePath,{timeout:1000});let locked=false;
  const server = createServer(socket => socket.end());
  try {
  gate.exec("BEGIN IMMEDIATE");locked=true;
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error("Unsafe OptChat lock path");
    await new Promise<void>((resolveProbe, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); reject(new Error("OptChat already has a writer")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNREFUSED" && error.code !== "ENOENT") { reject(error); return; }
        if (existsSync(socketPath)) unlinkSync(socketPath); resolveProbe();
      });
    });
  }
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.removeListener("error", reject); resolveListen(); }); });
  } finally {if(locked)gate.exec("ROLLBACK");gate.close();}
  server.unref();
  let closed = false;
  const bots = new Map<string,{ main: MainLine[]; tree: Map<string,TreeLine> }>();
  const inbox=new Map<string,Map<string,Receipt>>();
  function read<T>(path: string, schema: z.ZodType<T>): T[] {
    if (!existsSync(path)) return [];
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Unsafe OptChat stream directory");
    const result: T[] = [];
    for (const file of readdirSync(path).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
      const full = join(path,file);
      if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error("Unsafe OptChat stream file");
      const raw = readFileSync(full,"utf8"); let line = 0;
      for (const text of raw.split("\n")) {
        line++; if (!text) continue;
        try { result.push(schema.parse(JSON.parse(text))); } catch { warn(`Skipped invalid ${file} line ${line}`); }
      }
      if (raw && !raw.endsWith("\n")) {
        const fd = openSync(full,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);
        try { writeSync(fd,"\n"); fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    return result;
  }
  function load(bot: string) {
    if (closed) throw new Error("OptChat archive is closed");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bot)) throw new Error("Invalid bot ID");
    let data = bots.get(bot);
    if (!data) {
      const dir = join(root,bot); directory(dir);
      const main = read(join(dir,"main"),mainSchema).sort((a,b)=>a.i-b.i);
      for (let i=0;i<main.length;i++) {
        if (main[i].i !== i || main[i].size !== bytes(`${main[i].kind}: ${main[i].text}`)) throw new Error("OptChat history has an index gap, duplicate or invalid size; restore its backup before writing");
      }
      const tree = new Map<string,TreeLine>();
      for (const line of read(join(dir,"tree"),treeSchema)) {
        if (line.size !== bytes(line.text) || (line.i+1)*2**line.l > main.length) throw new Error("Invalid OptChat tree range or size");
        const key = `${line.l}:${line.i}`, old = tree.get(key);
        if (old && old.text !== line.text) throw new Error("Conflicting immutable OptChat node");
        tree.set(key,line);
      }
      data = { main,tree }; bots.set(bot,data);
    }
    return data;
  }
  function receipts(bot:string){load(bot);let values=inbox.get(bot);if(values)return values;values=new Map();for(const row of read(join(root,bot,"inbox"),receiptSchema)){const old=values.get(row.id);if(old&&(old.text!==row.text||old.threadId!==row.threadId))throw new Error(`Conflicting queued input ${row.id}`);if(!old)values.set(row.id,row);}inbox.set(bot,values);return values;}
  return {
    load,
    bots(){if(closed)throw new Error("OptChat archive is closed");return readdirSync(root).filter(name=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)&&lstatSync(join(root,name)).isDirectory());},
    receipts,
    receive(bot:string,row:Receipt){const value=receiptSchema.parse(row),values=receipts(bot),old=values.get(row.id);if(old){if(old.text!==row.text||old.threadId!==row.threadId)throw new Error("Conflicting duplicate queued input");return old;}writeLine(join(root,bot,"inbox",localDay()+".jsonl"),value);values.set(value.id,value);return value;},
    appendMain(bot: string, line: MainLine) {
      const data = load(bot); const valid = mainSchema.parse(line);
      if (valid.i < data.main.length) {
        if (JSON.stringify(data.main[valid.i]) !== JSON.stringify(valid)) throw new Error("Conflicting immutable OptChat message");
        return;
      }
      if (valid.i !== data.main.length || valid.size !== bytes(`${valid.kind}: ${valid.text}`)) throw new Error("Invalid OptChat message sequence");
      writeLine(join(root,bot,"main",localDay()+".jsonl"),valid); data.main.push(valid);
    },
    appendTree(bot: string, line: TreeLine) {
      const data = load(bot), valid = treeSchema.parse(line), key = `${valid.l}:${valid.i}`;
      const old = data.tree.get(key);
      if (old) { if (old.text !== valid.text) throw new Error("Conflicting immutable OptChat node"); return; }
      if (valid.size !== bytes(valid.text) || (valid.i+1)*2**valid.l > data.main.length) throw new Error("Invalid OptChat node range or size");
      writeLine(join(root,bot,"tree",localDay()+".jsonl"),valid); data.tree.set(key,valid);
    },
    /** view.json: the view as [l, i] pairs (spec §1). Saved on every change, loaded at start, never rebuilt. */
    loadView(bot: string): [number, number][] | null {
      load(bot); const path = join(root, bot, "view.json");
      if (!existsSync(path)) return null;
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Unsafe OptChat view file");
      try { return viewSchema.parse(JSON.parse(readFileSync(path, "utf8"))); } catch { warn("Skipped an invalid view.json"); return null; }
    },
    saveView(bot: string, pairs: [number, number][]) {
      load(bot); const dir = join(root, bot), path = join(dir, "view.json"), temp = join(dir, ".view.json.tmp");
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      // Atomic, not synced: data.db holds the durable copy, and a torn or stale file falls back to it.
      try { const data = Buffer.from(JSON.stringify(pairs)); if (writeSync(fd, data) !== data.length) throw new Error("Incomplete OptChat view write"); } finally { closeSync(fd); }
      renameSync(temp, path);
    },
    async close() { if (closed) return; closed=true; await new Promise<void>((resolveClose,reject)=>server.close(error=>error?reject(error):resolveClose())); },
  };
}
export type Archive = Awaited<ReturnType<typeof createArchive>>;
type Shared = { value: Promise<Archive>; refs: number; closing?: Promise<void> };
const registryKey = Symbol.for("bb.optbot.archives.v1");
const processRegistry = globalThis as unknown as Record<symbol,Map<string,Shared>>;
const registry = processRegistry[registryKey] ??= new Map();

/** Reload candidates in the SAME process share its one physical writer. */
export async function openArchive(rootPath: string, warn: (message: string) => void = () => {}): Promise<Archive> {
  const root = resolve(rootPath);
  let shared = registry.get(root);
  if (shared?.closing) { await shared.closing; return openArchive(root,warn); }
  if (!shared) {
    shared={ value:createArchive(root,warn),refs:0 }; registry.set(root,shared);
    void shared.value.catch(()=>{ if(registry.get(root)===shared) registry.delete(root); });
  }
  shared.refs++;
  const value = await shared.value;
  let released = false;
  const live = () => { if(released) throw new Error("OptChat archive handle is closed"); };
  return {
    load(bot) { live(); return value.load(bot); },
    bots(){live();return value.bots();},
    receipts(bot){live();return value.receipts(bot);},
    receive(bot,row){live();return value.receive(bot,row);},
    appendMain(bot,line) { live(); return value.appendMain(bot,line); },
    appendTree(bot,line) { live(); return value.appendTree(bot,line); },
    loadView(bot) { live(); return value.loadView(bot); },
    saveView(bot,pairs) { live(); return value.saveView(bot,pairs); },
    async close() {
      if(released) return; released=true;
      if(--shared.refs===0) {
        shared.closing=value.close();
        await shared.closing;
        if(registry.get(root)===shared) registry.delete(root);
      }
    },
  };
}
