import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Archive, Receipt, TreeLine, MainLine } from "./archive";

export const NODE_BYTES = 512;
export const VIEW_BYTES = 128_000;
const LEASE_MS = 60_000;
export type MemoryKind = "user" | "talk" | "tool" | "echo" | "note";
type Part = { start: number; count: number };
type Entry = { idx: number; kind: MemoryKind; text: string; date: string; threadId: string };
type Run = { requestId: string; threadId: string; lease: string; expires: number; status: string; result: string };
export type Compression = { start: number; count: number; source: string; context: string; children?:string[] };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const label = (part: Part) => `${part.start}+${part.count}`;

/** Server-owned store: all hosts share one bot log, with transactional writes. */
export function createOptChat(db: Database.Database, options: { viewBytes?: number; now?: () => number; archive?: Archive } = {}) {
  const budget = options.viewBytes ?? VIEW_BYTES;
  const now = options.now ?? Date.now;
  if (budget < NODE_BYTES + 128) throw new Error("Memory view budget is too small");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS optchat_log (
      bot_id TEXT NOT NULL, idx INTEGER NOT NULL, event_key TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL, thread_id TEXT NOT NULL,
      PRIMARY KEY(bot_id, idx), UNIQUE(bot_id, event_key));
    CREATE TABLE IF NOT EXISTS optchat_nodes (
      bot_id TEXT NOT NULL, start INTEGER NOT NULL, count INTEGER NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY(bot_id, start, count));
    CREATE TABLE IF NOT EXISTS optchat_view (bot_id TEXT PRIMARY KEY, parts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS optchat_runs (
      bot_id TEXT NOT NULL, request_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      lease TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL, answer TEXT,
      PRIMARY KEY(bot_id, request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS optchat_one_active ON optchat_runs(bot_id) WHERE status='active';
  `);
  if (!(db.pragma("table_info(optchat_runs)") as { name: string }[]).some(column => column.name === "answer")) db.exec("ALTER TABLE optchat_runs ADD COLUMN answer TEXT");
  const count = (bot: string) => (db.prepare("SELECT COUNT(*) AS n FROM optchat_log WHERE bot_id=?").get(bot) as { n: number }).n;
  const entry = (bot: string, idx: number) => db.prepare("SELECT idx,kind,text,date,thread_id AS threadId FROM optchat_log WHERE bot_id=? AND idx=?").get(bot, idx) as Entry | undefined;
  const node = (bot: string, part: Part) => (db.prepare("SELECT text FROM optchat_nodes WHERE bot_id=? AND start=? AND count=?").get(bot, part.start, part.count) as { text: string } | undefined)?.text;
  const parts = (bot: string): Part[] => JSON.parse((db.prepare("SELECT parts FROM optchat_view WHERE bot_id=?").get(bot) as { parts: string } | undefined)?.parts ?? "[]");
  const saveParts = (bot: string, view: Part[]) => db.prepare("INSERT INTO optchat_view VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET parts=excluded.parts").run(bot, JSON.stringify(view));
  const loaded = new Set<string>();
  function saveNode(bot: string, start: number, count: number, text: string) {
    options.archive?.appendTree(bot, { l: Math.log2(count), i: start/count, text, size: bytes(text) });
    db.prepare("INSERT INTO optchat_nodes VALUES (?,?,?,?)").run(bot,start,count,text);
  }
  // One transaction: importing a cold cache row by row would fsync every insert.
  function hydrate(bot: string) { db.transaction(() => hydrateNow(bot))(); }
  function hydrateNow(bot: string) {
    if (!options.archive) return;
    const data = options.archive.load(bot);
    if(loaded.has(bot)) {
      const cachedNodes=(db.prepare("SELECT COUNT(*) AS n FROM optchat_nodes WHERE bot_id=?").get(bot) as {n:number}).n;
      if(count(bot)===data.main.length&&cachedNodes===data.tree.size)return;
      loaded.delete(bot);
    }
    // One-time import of this checkout's earlier SQLite implementation only.
    // Another plugin's records are never read implicitly.
    const cached = db.prepare("SELECT idx,kind,text,date,event_key AS eventKey,thread_id AS threadId FROM optchat_log WHERE bot_id=? ORDER BY idx").all(bot) as (Entry & { eventKey: string })[];
    const cachedById=new Map(cached.map(line=>[line.idx,line]));
    if (!data.main.length) for (const line of cached) options.archive.appendMain(bot,{ i: line.idx, kind: line.kind, text: line.text, date: line.date, size: bytes(`${line.kind}: ${line.text}`), eventKey: line.eventKey, threadId: line.threadId });
    for (const line of data.main) {
      const old = cachedById.get(line.i);
      if (old && (old.kind !== line.kind || old.text !== line.text || old.date !== line.date)) throw new Error("SQLite cache disagrees with canonical OptChat history");
      if (!old) db.prepare("INSERT INTO optchat_log VALUES (?,?,?,?,?,?,?)").run(bot,line.i,line.eventKey ?? `import:${line.i}`,line.kind,line.text,line.date,line.threadId ?? "");
    }
    if (cached.length > data.main.length) throw new Error("Canonical OptChat history is incomplete");
    const cachedNodes = db.prepare("SELECT start,count,text FROM optchat_nodes WHERE bot_id=?").all(bot) as (Part & { text: string })[];
    const stored = new Map(cachedNodes.map(row => [label(row), row.text]));
    if (!data.tree.size) for (const line of cachedNodes) options.archive.appendTree(bot,{ l: Math.log2(line.count), i: line.start/line.count, text: line.text, size: bytes(line.text) });
    for (const line of data.tree.values()) {
      const start = line.i*2**line.l, count = 2**line.l, old = stored.get(label({start,count}));
      if (old !== undefined && old !== line.text) throw new Error("SQLite cache disagrees with canonical OptChat tree");
      if (old === undefined) db.prepare("INSERT INTO optchat_nodes VALUES (?,?,?,?)").run(bot,start,count,line.text);
    }
    // The view is reconstructed by the reference append+fit fold, never read
    // from a possibly stale persisted view snapshot.
    // Fold in memory and save once (spec §5.2: 2,300 messages in ~20 ms).
    // Numeric keys: the fold looks nodes up millions of times on a long history.
    const texts=new Map<number,Map<number,string>>();
    for (const row of db.prepare("SELECT start,count,text FROM optchat_nodes WHERE bot_id=?").all(bot) as (Part&{text:string})[]) { let level=texts.get(row.count); if(!level)texts.set(row.count,level=new Map()); level.set(row.start,row.text); }
    const view:Part[]=[];
    const lookup=(part:Part)=>texts.get(part.count)?.get(part.start);let used=0;
    for (let i=0;i<data.main.length;i++) { const leaf={start:i,count:1}; view.push(leaf); used=fold(view,i+1,lookup,used+partBytes(leaf,lookup)); }
    saveParts(bot,view);
    loaded.add(bot);
  }
  function fit(bot: string, total = count(bot)) {
    const view = parts(bot);
    fold(view, total, part => node(bot, part));
    saveParts(bot, view);
  }
  // Merge the most due built pair until the view fits its budget; never split.
  function fold(view: Part[], total: number, text: (part: Part) => string | undefined, used = view.reduce((sum, p) => sum + partBytes(p, text), 0)) {
    const size = (p: Part) => partBytes(p, text);
    while (used > budget) {
      let best = -1, due = -1;
      for (let i = 0; i + 1 < view.length; i++) {
        const a = view[i], b = view[i + 1];
        if (a.count !== b.count || a.start % (a.count * 2) !== 0 || b.start !== a.start + a.count) continue;
        if (text({ start: a.start, count: a.count * 2 }) === undefined) continue;
        const weight = (total - a.start) / (a.count * 4);
        if (weight > due) { best = i; due = weight; }
      }
      if (best < 0) break;
      const a = view[best], b = view[best + 1], parent = { start: a.start, count: a.count * 2 };
      used += size(parent) - size(a) - size(b);
      view.splice(best, 2, parent);
    }
    return used;
  }
  function partBytes(part: Part, text: (part: Part) => string | undefined) { return bytes(text(part) ?? "(not summarized yet: zoom it)"); }
  const temporaryInbox=new Map<string,Map<string,Receipt>>();
  function receipts(bot:string){if(options.archive)return options.archive.receipts(bot);let values=temporaryInbox.get(bot);if(!values)temporaryInbox.set(bot,values=new Map());return values;}
  function receive(bot:string,threadId:string,id:string,parentId:string,text:string){const value={id,parentId,threadId,text,date:new Date(now()).toISOString()};if(options.archive)return options.archive.receive(bot,value);const old=receipts(bot).get(id);if(old){if(old.text!==text||old.threadId!==threadId)throw new Error("Conflicting duplicate queued input");return old;}receipts(bot).set(id,value);return value;}
  function flushInbox(bot:string,parentId:string){for(const row of receipts(bot).values())if(row.parentId===parentId)append(bot,row.threadId,`${row.id}:input`,"user",row.text,row.date);}
  function append(bot: string, threadId: string, key: string, kind: MemoryKind, text: string, receivedDate?:string, foldView = true) {
    const old = db.prepare("SELECT idx,kind,text,thread_id AS threadId FROM optchat_log WHERE bot_id=? AND event_key=?").get(bot, key) as Entry | undefined;
    if (old) {
      if (old.kind !== kind || old.text !== text || old.threadId !== threadId) throw new Error("Conflicting duplicate memory event");
      return old.idx;
    }
    const idx = count(bot), date = receivedDate??new Date(now()).toISOString();
    options.archive?.appendMain(bot,{ i: idx, kind, text, size: bytes(`${kind}: ${text}`), date, eventKey: key, threadId });
    db.prepare("INSERT INTO optchat_log VALUES (?,?,?,?,?,?,?)").run(bot, idx, key, kind, text, date, threadId);
    if (foldView) { const view = parts(bot); view.push({ start: idx, count: 1 }); saveParts(bot, view); fit(bot); }
    return idx;
  }
  function requireLease(bot: string, threadId: string, lease: string) {
    const run = db.prepare("SELECT request_id AS requestId,thread_id AS threadId,lease,expires,status,result FROM optchat_runs WHERE bot_id=? AND lease=? AND status='active'").get(bot, lease) as Run | undefined;
    if (!run || run.threadId !== threadId || run.expires <= now()) throw new Error("OptChat lease expired or belongs to another conversation");
    return run;
  }
  function render(bot: string, before = Infinity, ids = true) {
    return parts(bot).filter((p) => p.start < before).map((p) => {
      const text = node(bot, p);
      if (text === undefined) throw new Error("Memory is not settled; finish pending summaries first");
      return `${ids ? `${label(p)}|` : ""}${text.replace(/\r\n|\n|\r/g, " ")}`;
    }).join("\n");
  }
  function pending(bot: string): Compression | null {
    const total = count(bot);
    // Build raw messages in order, interleaving completed binary merges.
    // ponytail: one leased compactor per bot; parallelize independent merges if throughput demands it.
    for (let end = 1; end <= total; end++) {
      const leaf = { start: end - 1, count: 1 };
      if (node(bot, leaf) === undefined) {
        const source = entry(bot, leaf.start)!;
        return { ...leaf, source: `${source.kind}: ${source.text}`, context: contextBefore(bot, leaf.start) };
      }
      for (let size = 2; size <= end && end % size === 0; size *= 2) {
        const parent = { start: end - size, count: size };
        if (node(bot, parent) !== undefined) continue;
        const a = node(bot, { start: parent.start, count: size / 2 });
        const b = node(bot, { start: parent.start + size / 2, count: size / 2 });
        if (a !== undefined && b !== undefined) return { ...parent, source: `${a}\n${b}`, children:[a,b], context: contextBefore(bot, parent.start+parent.count) };
      }
    }
    return null;
  }
  // During rebuilding a persisted view can contain a parent whose end is beyond
  // this node. Tile only the built prefix, never expose future or partial text.
  function contextBefore(bot: string, end: number) {
    const lines: string[] = [];
    function take(part: Part) {
      if(part.start>=end) return;
      if(part.start+part.count>end && part.count>1) {
        take({start:part.start,count:part.count/2});
        take({start:part.start+part.count/2,count:part.count/2}); return;
      }
      const text=node(bot,part);
      if(text===undefined) throw new Error("Compactor context is not summarized");
      lines.push(text.replace(/\r\n|\n|\r/g," "));
    }
    for(const part of parts(bot)) take(part);
    return `<chat>\n${lines.join("\n")}\n</chat>`;
  }
  function drainFree(bot: string) {
    let task: Compression | null;
    while ((task = pending(bot)) && bytes(task.source) <= NODE_BYTES) {
      saveNode(bot, task.start, task.count, task.source);
      fit(bot);
    }
    return task;
  }
  function available(bot:string,busy:ReadonlySet<string>,limit:number) {
    const total=count(bot), built=new Map((db.prepare("SELECT start,count,text FROM optchat_nodes WHERE bot_id=?").all(bot) as (Part&{text:string})[]).map(part=>[label(part),part.text]));
    function candidates() {
      const first=parts(bot).find(part=>!built.has(label(part)))?.start??total;
      const result:Compression[]=[];
      for(let size=1;size<=total;size*=2) for(let start=0;start+size<=total;start+=size) {
        const part={start,count:size};
        if(built.has(label(part))||busy.has(label(part))||(size===1?start:start+size)>first) continue;
        if(size===1) {const raw=entry(bot,start)!;result.push({...part,source:`${raw.kind}: ${raw.text}`,context:""});}
        else {const a=built.get(label({start,count:size/2})),b=built.get(label({start:start+size/2,count:size/2}));if(a!==undefined&&b!==undefined)result.push({...part,source:`${a}\n${b}`,children:[a,b],context:""});}
      }
      return result;
    }
    // Free nodes advance the same readiness frontier without a network slot. Build them smallest level first,
    // then oldest (as a full rescan would), but from a queue of newly eligible nodes, folding the view in memory:
    // rescanning the tree and saving the view per free node froze BB for 15 s after a 150-message import.
    const view=parts(bot), text=(part:Part)=>built.get(label(part));
    const frontier=()=>view.find(part=>!built.has(label(part)))?.start??total;
    const end=(part:Part)=>part.count===1?part.start:part.start+part.count;
    const source=(part:Part)=>{
      if(part.count===1){const raw=entry(bot,part.start)!;return `${raw.kind}: ${raw.text}`;}
      const a=built.get(label({start:part.start,count:part.count/2})),b=built.get(label({start:part.start+part.count/2,count:part.count/2}));
      return a!==undefined&&b!==undefined?`${a}\n${b}`:undefined;
    };
    const queue:{part:Part;source:string}[]=[], queued=new Set<string>();
    const offer=(part:Part,first:number)=>{
      if(part.start+part.count>total||built.has(label(part))||busy.has(label(part))||queued.has(label(part))||end(part)>first)return;
      const value=source(part); if(value===undefined||bytes(value)>NODE_BYTES)return;
      let at=queue.findIndex(item=>item.part.count>part.count||(item.part.count===part.count&&item.part.start>part.start)); if(at<0)at=queue.length;
      queue.splice(at,0,{part,source:value}); queued.add(label(part));
    };
    let first=frontier();
    for(let size=1;size<=total;size*=2) for(let start=0;start+size<=total;start+=size) offer({start,count:size},first);
    let changed=false;
    while(queue.length) {
      const {part,source:nodeText}=queue.shift()!; queued.delete(label(part));
      saveNode(bot,part.start,part.count,nodeText); built.set(label(part),nodeText); changed=true;
      fold(view,total,text);
      const before=first; first=frontier();
      const parent={start:part.start-part.start%(part.count*2),count:part.count*2}; offer(parent,first);
      // A moved frontier makes leaves and parents ending in (before, first] eligible.
      for(let size=1;size<=total&&first>before;size*=2) for(let start=Math.max(0,Math.floor((before-(size===1?0:size))/size)*size);start+size<=total&&end({start,count:size})<=first;start+=size) if(end({start,count:size})>before)offer({start,count:size},first);
    }
    if(changed)saveParts(bot,view);
    return candidates().slice(0,limit).map(task=>({...task,context:contextBefore(bot,task.count===1?task.start:task.start+task.count)}));
  }
  return {
    hydrate,
    importEntries(bot:string, rows:readonly {i?:number;kind:MemoryKind;text:string;date?:string;eventKey?:string;threadId?:string}[], trees:readonly TreeLine[]=[]) {
      hydrate(bot);
      if(db.prepare("SELECT 1 FROM optchat_runs WHERE bot_id=? AND status='active' AND expires>?").get(bot,now()))throw new Error("Pause the bot before importing history");
      let next=count(bot);const planned:{i:number;kind:MemoryKind;text:string;date:string;eventKey:string;threadId:string}[]=[];
      const keys=new Set((db.prepare("SELECT event_key AS key FROM optchat_log WHERE bot_id=?").all(bot) as {key:string}[]).map(row=>row.key));
      for(const row of rows){
        const i=row.i??next,old=entry(bot,i);
        if(old){if(old.kind!==row.kind||old.text!==row.text||(row.date!==undefined&&old.date!==row.date))throw new Error(`Import conflicts with permanent message ${i}`);continue;}
        if(i!==next)throw new Error(`Expected permanent message ${next}; received ${i}`);
        const eventKey=row.eventKey??`import:${i}`;if(keys.has(eventKey))throw new Error("Duplicate imported event key");keys.add(eventKey);
        planned.push({...row,i,date:row.date??new Date(now()).toISOString(),eventKey,threadId:row.threadId??""});next++;
      }
      for(const tree of trees){const n=2**tree.l,start=tree.i*n;if(!Number.isSafeInteger(start)||start+n>next||tree.size!==bytes(tree.text))throw new Error("Invalid imported summary span or byte size");const old=node(bot,{start,count:n});if(old!==undefined&&old!==tree.text)throw new Error("Import would overwrite an immutable summary");}
      const stored=new Set((db.prepare("SELECT start,count FROM optchat_nodes WHERE bot_id=?").all(bot) as Part[]).map(row=>`${Math.log2(row.count)}:${row.start/row.count}`));
      for(const tree of trees)stored.add(`${tree.l}:${tree.i}`);
      for(const tree of trees)if(tree.l>0&&(!stored.has(`${tree.l-1}:${tree.i*2}`)||!stored.has(`${tree.l-1}:${tree.i*2+1}`)))throw new Error("Imported subtree is missing its stored children");
      // Same incremental fold as appending one by one, but in memory with one save: a per-row save froze BB on long imports.
      db.transaction(()=>{
        const view=parts(bot), texts=new Map((db.prepare("SELECT start,count,text FROM optchat_nodes WHERE bot_id=?").all(bot) as (Part&{text:string})[]).map(row=>[label(row),row.text]));
        const lookup=(part:Part)=>texts.get(label(part));let used=view.reduce((sum,part)=>sum+partBytes(part,lookup),0);
        for(const row of planned){const idx=append(bot,row.threadId,row.eventKey,row.kind,row.text,row.date,false);const leaf={start:idx,count:1};view.push(leaf);used=fold(view,idx+1,lookup,used+partBytes(leaf,lookup));}
        saveParts(bot,view);
      })();
      for(const tree of trees){const n=2**tree.l,start=tree.i*n;if(node(bot,{start,count:n})===undefined)saveNode(bot,start,n,tree.text);}
      fit(bot);return {imported:planned.length,entries:count(bot)};
    },
    snapshot(bot:string) {
      hydrate(bot);
      const main:MainLine[]=options.archive?[...options.archive.load(bot).main]:
        (db.prepare("SELECT idx,kind,text,date,event_key AS eventKey,thread_id AS threadId FROM optchat_log WHERE bot_id=? ORDER BY idx").all(bot) as (Entry&{eventKey:string})[]).map(row=>({i:row.idx,kind:row.kind,text:row.text,date:row.date,size:bytes(`${row.kind}: ${row.text}`),eventKey:row.eventKey,threadId:row.threadId}));
      const tree:TreeLine[]=options.archive?[...options.archive.load(bot).tree.values()]:
        (db.prepare("SELECT start,count,text FROM optchat_nodes WHERE bot_id=?").all(bot) as (Part&{text:string})[]).map(row=>({l:Math.log2(row.count),i:row.start/row.count,text:row.text,size:bytes(row.text)}));
      const view=`<chat>\n${parts(bot).map(part=>`${label(part)}|${(node(bot,part)??"(not summarized yet: zoom it)").replace(/\r\n|\n|\r/g," ")}`).join("\n")}\n</chat>`;
      return {version:1 as const,botId:bot,main,tree,view,inbox:[...receipts(bot).values()]};
    },
    recoverQueued(bot:string){const running=db.prepare("SELECT 1 FROM optchat_runs WHERE bot_id=? AND status='active' AND expires>?").get(bot,now());const parents=new Set([...receipts(bot).values()].map(row=>row.parentId));for(const id of parents){const run=db.prepare("SELECT status,expires FROM optchat_runs WHERE bot_id=? AND request_id=?").get(bot,id) as {status:string;expires:number}|undefined;if((!run&&!running)||(run&&(run.status!=="active"||run.expires<=now())))flushInbox(bot,id);}},
    enqueue(bot:string,threadId:string,id:string,parentId:string,text:string){const run=db.prepare("SELECT thread_id AS threadId,status,expires FROM optchat_runs WHERE bot_id=? AND request_id=?").get(bot,parentId) as {threadId:string;status:string;expires:number}|undefined;if(!run||run.threadId!==threadId)throw new Error("Queued input does not belong to this conversation's turn");receive(bot,threadId,id,parentId,text);if(run.status!=="active"||run.expires<=now())flushInbox(bot,parentId);return {ok:true};},
    input(bot:string,threadId:string,lease:string,id:string,text:string){requireLease(bot,threadId,lease);const row=receipts(bot).get(id);return {id:append(bot,threadId,`${id}:input`,"user",text,row?.date)};},
    free: drainFree,
    available,
    accept(bot:string,task:Compression,text:string) {
      if(node(bot,task)!==undefined) return;
      if(!text.trim()) throw new Error("Summary must be nonempty");
      const raw=task.count===1?entry(bot,task.start):undefined;
      const a=task.count>1?node(bot,{start:task.start,count:task.count/2}):undefined,b=task.count>1?node(bot,{start:task.start+task.count/2,count:task.count/2}):undefined;
      const source=raw?`${raw.kind}: ${raw.text}`:a!==undefined&&b!==undefined?`${a}\n${b}`:undefined;
      if(source!==task.source) throw new Error("Stale background compression");
      saveNode(bot,task.start,task.count,text); fit(bot);
    },
    settled(bot:string) { const view=parts(bot); return view.every(part=>node(bot,part)!==undefined) && view.reduce((sum,part)=>sum+bytes(node(bot,part)!),0)<=budget; },
    begin: db.transaction((bot: string, threadId: string, requestId: string, input?: string) => {
      const existing = db.prepare("SELECT status,result,answer,thread_id AS threadId FROM optchat_runs WHERE bot_id=? AND request_id=?").get(bot, requestId) as { status: string; result: string; answer: string | null; threadId: string } | undefined;
      if (existing && existing.threadId !== threadId) throw new Error("Request belongs to another conversation");
      if (input !== undefined) {
        const previous = db.prepare("SELECT text FROM optchat_log WHERE bot_id=? AND event_key=?").get(bot, `${requestId}:input`) as { text: string } | undefined;
        if (previous && previous.text !== input) throw new Error("Conflicting duplicate request input");
        receive(bot,threadId,requestId,requestId,input);
      }
      if (existing?.status === "completed") return { status: "completed" as const, result: existing.result };
      const active = db.prepare("SELECT request_id AS requestId,thread_id AS threadId,lease,expires,status,result FROM optchat_runs WHERE bot_id=? AND status='active'").get(bot) as Run | undefined;
      if (active && active.expires > now()) return { status: "busy" as const };
      if (active) {
        flushInbox(bot,active.requestId);
        db.prepare("UPDATE optchat_runs SET status='failed' WHERE bot_id=? AND request_id=?").run(bot, active.requestId);
        append(bot, active.threadId, `recovery:${active.lease}`, "note", "Previous attempt interrupted; its recorded actions may already have changed the world. Inspect durable state before retrying side effects.");
      }
      const lease = randomUUID();
      db.prepare("INSERT INTO optchat_runs(bot_id,request_id,thread_id,lease,expires,status,result,answer) VALUES (?,?,?,?,?,'active','',NULL) ON CONFLICT(bot_id,request_id) DO UPDATE SET lease=excluded.lease,expires=excluded.expires,status='active',result=''").run(bot, requestId, threadId, lease, now() + LEASE_MS);
      return { status: "active" as const, lease, answer: existing?.answer ?? null };
    }),
    heartbeat: db.transaction((bot: string, thread: string, lease: string) => {
      requireLease(bot, thread, lease);
      db.prepare("UPDATE optchat_runs SET expires=? WHERE bot_id=? AND lease=?").run(now() + LEASE_MS, bot, lease);
      return { ok: true };
    }),
    checkpoint: db.transaction((bot: string, thread: string, lease: string, answer: string) => {
      requireLease(bot, thread, lease);
      const changed = db.prepare("UPDATE optchat_runs SET answer=? WHERE bot_id=? AND lease=? AND (answer IS NULL OR answer=?)").run(answer, bot, lease, answer).changes;
      if (!changed) throw new Error("Conflicting answer checkpoint");
      return { ok: true };
    }),
    record: db.transaction((bot: string, thread: string, lease: string, key: string, kind: MemoryKind, text: string) => {
      const run = requireLease(bot, thread, lease);
      return { id: append(bot, thread, `${run.requestId}:${key}`, kind, text) };
    }),
    work: db.transaction((bot: string, thread: string, lease: string) => {
      requireLease(bot, thread, lease); return drainFree(bot);
    }),
    merge: db.transaction((bot: string, thread: string, lease: string, start: number, size: number, text: string) => {
      requireLease(bot, thread, lease);
      if (!text.trim()) throw new Error("Summary must be nonempty");
      const old = node(bot, { start, count: size });
      if (old !== undefined) {
        if (old !== text) throw new Error("Summary already exists; never overwrite a built node");
        return { ok: true };
      }
      const task = pending(bot);
      if (!task || task.start !== start || task.count !== size) throw new Error("Stale or out-of-order compression");
      saveNode(bot, start, size, text);
      fit(bot); return { ok: true };
    }),
    view(bot: string) {
      const text = `<chat>\n${render(bot)}\n</chat>`;
      const summaryBytes=parts(bot).reduce((sum,part)=>sum+bytes(node(bot,part)!),0);
      if (summaryBytes > budget) throw new Error("Memory exceeds its budget; complete pending merges before starting a turn");
      return { text, entries: count(bot), bytes: bytes(text), summaryBytes };
    },
    finish: db.transaction((bot: string, thread: string, lease: string, status: "completed" | "failed", result: string) => {
      const run=requireLease(bot, thread, lease);
      flushInbox(bot,run.requestId);
      if (status === "failed") append(bot, thread, `failure:${lease}`, "note", `Attempt failed: ${result}. Verify prior side effects before retrying.`);
      db.prepare("UPDATE optchat_runs SET status=?,result=?,expires=0 WHERE bot_id=? AND lease=?").run(status, result, bot, lease);
      return { ok: true };
    }),
    zoom(bot: string, start: number, size: number, offset = 0) {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || Math.log2(size) % 1 !== 0 || start % size !== 0 || start + size > count(bot)) throw new Error("Invalid memory node");
      if (size === 1) {
        const raw = entry(bot, start)!;
        return { ...raw, text: raw.text.slice(offset, offset + 30_000), nextOffset: offset + 30_000 < raw.text.length ? offset + 30_000 : null };
      }
      return [start, start + size / 2].map((idx) => {
        const text = node(bot, { start: idx, count: size / 2 });
        if (text === undefined) throw new Error("Node is not built yet");
        return { start: idx, count: size / 2, text };
      });
    },
    zoomText(bot:string,start:number,size:number) {
      if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(size)||size<1||Math.log2(size)%1!==0||start%size!==0||start+size>count(bot))return `No line ${start}+${size}.`;
      if(size===1){const raw=entry(bot,start)!;return `${start}+0|${raw.kind}: ${raw.text}`;}
      return [start,start+size/2].map(idx=>{const value=node(bot,{start:idx,count:size/2});return value===undefined?`No line ${idx}+${size/2}.`:`${idx}+${size/2}|${value.replace(/\r\n|\n|\r/g," ")}`;}).join("\n");
    },
    dateText(bot:string,id:number) {const raw=entry(bot,id);return raw?new Date(raw.date).toString():`No message ${id}.`;},
    search(bot: string, query: string, after = -1) {
      return db.prepare("SELECT idx,kind,date,thread_id AS threadId,substr(text,1,2000) AS text FROM optchat_log WHERE bot_id=? AND idx>? AND instr(lower(text),lower(?))>0 ORDER BY idx LIMIT 50").all(bot, after, query) as Entry[];
    },
    /** Whether a turn in this conversation still holds an unexpired lease (its bridge heartbeats every 10 s). */
    liveTurn(threadId: string) { return db.prepare("SELECT 1 FROM optchat_runs WHERE thread_id=? AND status='active' AND expires>?").get(threadId, now()) !== undefined; },
    stats(bot: string) { return { entries: count(bot), nodes: (db.prepare("SELECT COUNT(*) AS n FROM optchat_nodes WHERE bot_id=?").get(bot) as { n: number }).n, parts: parts(bot) }; },
  };
}
export type OptChat = ReturnType<typeof createOptChat>;
