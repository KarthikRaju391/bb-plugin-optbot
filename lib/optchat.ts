import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Archive, Receipt, TreeLine, MainLine } from "./archive";
import { CVIEW_HIGH, fitBox, tiles, VIEW_HIGH, type Box } from "./view";
import { REPORT, reportText } from "./agents";

export const NODE_BYTES = 512;
export const VIEW_BYTES = VIEW_HIGH;
export const LEASE_MS = 60_000;
export type MemoryKind = "user" | "talk" | "tool" | "echo" | "work" | "note";
/** A line as views show it: newlines and the whitespace around them as one space (UniiChat Memory.flat). */
export function flatLine(text: string) { return text.includes("\n") ? text.replace(/\s*\n\s*/g, " ") : text; }
/** A merge's source: its halves as lines, one per line (UniiChat Memory.source). */
export function mergeSource(a: string, b: string) { return `${flatLine(a)}\n${flatLine(b)}`; }
/** A page: command output is clipped to this many characters; any longer text is logged over several messages (§1). */
export const MESSAGE_CHARS = 30_000;
/**
 * An incoming message as the log records it (§1): a report from another BB thread or bot is `work`, starting
 * "[Name]" (the bot's name, else the thread's id; a subagent by its thread id); anything else is the user's words.
 */
export function inputEntry(text: string, agentName?: (threadId: string) => string | null): { kind: MemoryKind; text: string } {
  if (RESUME.test(text)) return { kind: "note", text }; // OptBot's own word after a restart (UniiChat Chat.resume)
  if (REPORT.test(text)) return { kind: "work", text }; // a subagent's report: "[thr_…]\n...\n\nFull chat: ..."
  // BB's own word that a child thread completed, failed or was interrupted: a subagent's report (UniiChat Call.ts).
  const notice = /^\[bb system\]\n\n@thread:(thr_[A-Za-z0-9]+) ([a-z][a-z -]*):\n\n([\s\S]*)$/.exec(text);
  if (notice) {
    const [, thread, outcome, body] = notice as unknown as [string, string, string, string];
    const said = outcome === "completed" ? body : `${outcome}: ${body}`, name = agentName?.(thread);
    return { kind: "work", text: name ? reportText(name, said) : `[${thread}] ${said}` };
  }
  if (text.startsWith("[bb system]")) return { kind: "work", text }; // other BB notices are never the user's words
  const message = /^\[bb message from thread:(thr_[A-Za-z0-9]+)\][ \t]*\r?\n+([\s\S]*)$/.exec(text);
  if (!message) return { kind: "user", text };
  let name = message[1]!, body = message[2]!;
  const bot = /^\*\*🤖 Bot message · ([^*\n]+)\*\*[ \t]*\r?\n+([\s\S]*)$/.exec(body);
  if (bot) { if (bot[1]!.trim() !== "BB agent") name = bot[1]!.trim(); body = bot[2]!; }
  return { kind: "work", text: `[${name}] ${body}` };
}
/** UniiChat Server.ts TURN and Chat.resume: what a restart cut goes on, told so. */
export const TURN_NAME = "OptBot's turn";
export function resumeText(work: string[]) { return `The server restarted, cutting ${work.join(", ")}; nothing was lost: go on.`; }
export const RESUME = /^The server restarted, cutting [^\n]+; nothing was lost: go on\.$/;
/** Where the page of a text from `at` ends: MESSAGE_CHARS on, after its last newline if it has one (UniiChat clip_end). */
export function pageEnd(text: string, at: number) {
  if (text.length - at <= MESSAGE_CHARS) return text.length;
  const newline = text.lastIndexOf("\n", at + MESSAGE_CHARS - 1);
  if (newline >= at) return newline + 1;
  return at + MESSAGE_CHARS - (/[\uDC00-\uDFFF]/.test(text[at + MESSAGE_CHARS]!) ? 1 : 0); // never split a surrogate pair
}
/** A text's page from `at`, and where to go on (UniiChat clip_page). */
export function clipPage(text: string, at: number) {
  const end = pageEnd(text, at);
  return text.slice(at, end) + (end < text.length ? `\n[characters ${at + 1}-${end} of ${text.length}; go on with at ${end}]` : "");
}
/** The tree's roots over `total` messages: the largest aligned lines, oldest first. */
function roots(total: number) {
  const result: string[] = [];
  for (let start = 0, size = 2 ** Math.floor(Math.log2(Math.max(1, total))); start < total; size /= 2) if (start + size <= total) { result.push(`${start}+${size}`); start += size; }
  return result;
}
function chunks(text: string) {
  const result: string[] = [];
  for (let at = 0; at < text.length;) { const end = pageEnd(text, at); result.push(text.slice(at, end)); at = end; }
  return result;
}
type Part = { start: number; count: number };
type Entry = { idx: number; kind: MemoryKind; text: string; date: string; threadId: string };
type Run = { requestId: string; threadId: string; lease: string; expires: number; status: string; result: string };
export type Compression = { start: number; count: number; source: string; context: string; children?:string[] };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const label = (part: Part) => `${part.start}+${part.count}`;
const PLACEHOLDER_BYTES = Buffer.byteLength("(not summarized yet: zoom it)");

/** Server-owned store: all hosts share one bot log, with transactional writes. */
export function createOptChat(db: Database.Database, options: { viewBytes?: number; now?: () => number; archive?: Archive; agentName?: (threadId: string) => string | null } = {}) {
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
  const viewColumns = (db.pragma("table_info(optchat_view)") as { name: string }[]).map(column => column.name);
  if (!viewColumns.includes("draining")) db.exec("ALTER TABLE optchat_view ADD COLUMN draining INTEGER NOT NULL DEFAULT 0");
  if (!viewColumns.includes("cparts")) db.exec("ALTER TABLE optchat_view ADD COLUMN cparts TEXT");
  if (!viewColumns.includes("seen_batch")) db.exec("ALTER TABLE optchat_view ADD COLUMN seen_batch INTEGER NOT NULL DEFAULT 0");
  /** How many unbuilt messages ahead a compaction may start (UniiChat Memory.JOBS: its window, by message). */
  const WINDOW = 64;
  const count = (bot: string) => (db.prepare("SELECT COUNT(*) AS n FROM optchat_log WHERE bot_id=?").get(bot) as { n: number }).n;
  const entry = (bot: string, idx: number) => db.prepare("SELECT idx,kind,text,date,thread_id AS threadId FROM optchat_log WHERE bot_id=? AND idx=?").get(bot, idx) as Entry | undefined;
  const node = (bot: string, part: Part) => (db.prepare("SELECT text FROM optchat_nodes WHERE bot_id=? AND start=? AND count=?").get(bot, part.start, part.count) as { text: string } | undefined)?.text;
  const parts = (bot: string): Part[] => JSON.parse((db.prepare("SELECT parts FROM optchat_view WHERE bot_id=?").get(bot) as { parts: string } | undefined)?.parts ?? "[]");
  // The chat's view (turns) and the compactions' view (`seen`), each with its batch flag (UniiChat view.json).
  type ViewState = { view: Box; seen: Box };
  function viewState(bot: string): ViewState {
    const row = db.prepare("SELECT parts,draining,cparts,seen_batch FROM optchat_view WHERE bot_id=?").get(bot) as { parts: string; draining: number; cparts: string | null; seen_batch: number } | undefined;
    const view = { parts: JSON.parse(row?.parts ?? "[]") as Part[], batch: row?.draining === 1 };
    // An older OptBot kept no compactions' view: it opens as the chat's, as UniiChat opens `seen` from `saved`.
    const seen = row?.cparts ? { parts: JSON.parse(row.cparts) as Part[], batch: row.seen_batch === 1 } : { parts: view.parts.map(part => ({ ...part })), batch: false };
    return { view, seen };
  }
  // Saved when it changes, to data.db and to the chat's view.json; loaded at start, never rebuilt (§3.2).
  function saveState(bot: string, state: ViewState) {
    db.prepare("INSERT INTO optchat_view(bot_id,parts,draining,cparts,seen_batch) VALUES (?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET parts=excluded.parts,draining=excluded.draining,cparts=excluded.cparts,seen_batch=excluded.seen_batch")
      .run(bot, JSON.stringify(state.view.parts), state.view.batch ? 1 : 0, JSON.stringify(state.seen.parts), state.seen.batch ? 1 : 0);
    const pairs = (parts: Part[]) => parts.map(part => [Math.log2(part.count), part.start / part.count] as [number, number]);
    options.archive?.saveView(bot, { parts: pairs(state.view.parts), batch: state.view.batch, seen: { parts: pairs(state.seen.parts), batch: state.seen.batch } });
  }
  // Built nodes never change, so their sizes are cached; only unbuilt lines (a few recent ones) hit the DB.
  const known = new Map<string, Map<string, number>>();
  function nodeBytes(bot: string, part: Part) {
    let sizes = known.get(bot); if (!sizes) known.set(bot, sizes = new Map());
    const key = label(part), cached = sizes.get(key);
    if (cached !== undefined) return cached;
    const text = node(bot, part);
    if (text === undefined) return undefined;
    sizes.set(key, bytes(text)); return bytes(text);
  }
  const built = (bot: string) => (part: Part) => nodeBytes(bot, part) !== undefined;
  /** A line's bytes as calls get it: none until built (UniiChat Memory.size). */
  const sized = (bot: string) => (part: Part) => nodeBytes(bot, part) ?? 0;
  /**
   * UniiChat Memory.fit: the chat's view to the last message and the compactions' view to the first message not
   * built, each batching past its high mark. `next`: a new message (a stopped batch goes on); else after builds.
   */
  function refit(bot: string, next: boolean) {
    const state = viewState(bot), total = count(bot), first = queue(bot).leaves[0] ?? total;
    const a = fitBox(state.view, total, budget, sized(bot), built(bot), next);
    const b = fitBox(state.seen, Math.min(total, first), CVIEW_HIGH, sized(bot), built(bot), next);
    if (a || b) saveState(bot, state);
  }
  /** The largest built nodes covering [0, total): a view kept from the tree when none was saved (UniiChat open). */
  function tileBuilt(bot: string, total: number) {
    const parts: Part[] = [];
    for (let start = 0; start < total;) {
      let size = 1;
      while (start % (size * 2) === 0 && start + size * 2 <= total && nodeBytes(bot, { start, count: size * 2 }) !== undefined) size *= 2;
      parts.push({ start, count: size }); start += size;
    }
    return parts;
  }
  // Ready work in queues, never a tree scan (§4): unbuilt leaves in order, and merges whose halves are built.
  const queues = new Map<string, { leaves: number[]; merges: Map<string, Part> }>();
  function queue(bot: string) {
    let q = queues.get(bot);
    if (q) return q;
    q = { leaves: [], merges: new Map() }; queues.set(bot, q);
    const total = count(bot), done = new Set((db.prepare("SELECT start,count FROM optchat_nodes WHERE bot_id=?").all(bot) as Part[]).map(label));
    for (let i = 0; i < total; i++) if (!done.has(`${i}+1`)) q.leaves.push(i);
    for (const key of done) {
      const [start, size] = key.split("+").map(Number) as [number, number], parent = { start: start - start % (2 * size), count: 2 * size };
      const other = parent.start === start ? start + size : parent.start;
      if (parent.start + parent.count <= total && !done.has(label(parent)) && done.has(`${other}+${size}`)) q.merges.set(label(parent), parent);
    }
    return q;
  }
  const loaded = new Set<string>();
  function saveNode(bot: string, start: number, size: number, text: string) {
    options.archive?.appendTree(bot, { l: Math.log2(size), i: start/size, text, size: bytes(text) });
    db.prepare("INSERT INTO optchat_nodes VALUES (?,?,?,?)").run(bot,start,size,text);
    const q = queues.get(bot), part = { start, count: size };
    if (q) { if (size === 1) { const at = q.leaves.indexOf(start); if (at >= 0) q.leaves.splice(at, 1); } q.merges.delete(label(part)); }
    // Its parent is ready once both halves are built (UniiChat Memory.store).
    const parent = { start: start - start % (2 * size), count: 2 * size };
    if (!q || entry(bot, parent.start + parent.count - 1) === undefined || node(bot, parent) !== undefined) return;
    const other = { start: parent.start === start ? start + size : parent.start, count: size };
    if (node(bot, other) !== undefined) q.merges.set(label(parent), parent);
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
    // Keep the saved view (view.json, else data.db); fit extends it to the messages it lacks. With none (a restored
    // backup), keep the largest built nodes, as UniiChat opens a chat with no view.json: never refold the log.
    queues.delete(bot); known.delete(bot);
    const state = viewState(bot), saved = options.archive.loadView(bot);
    const toParts = (pairs: [number, number][]) => pairs.map(([l, i]) => ({ start: i * 2 ** l, count: 2 ** l }));
    if (saved) {
      state.view = { parts: toParts(saved.parts), batch: saved.batch };
      if (saved.seen) state.seen = { parts: toParts(saved.seen.parts), batch: saved.seen.batch };
    }
    const valid = (parts: Part[]) => { const n = tiles(parts); return n >= 0 && n <= data.main.length && parts.every(part => part.count === 1 || node(bot, part) !== undefined); };
    if (!valid(state.view.parts) || (!saved && !db.prepare("SELECT 1 FROM optchat_view WHERE bot_id=?").get(bot) && data.main.length)) state.view = { parts: tileBuilt(bot, data.main.length), batch: false };
    if (!valid(state.seen.parts)) state.seen = { parts: state.view.parts.map(part => ({ ...part })), batch: false };
    saveState(bot, state);
    refit(bot, false);
    loaded.add(bot);
  }
  function partBytes(part: Part, text: (part: Part) => string | undefined) { return bytes(text(part) ?? "(not summarized yet: zoom it)"); }
  const temporaryInbox=new Map<string,Map<string,Receipt>>();
  function receipts(bot:string){if(options.archive)return options.archive.receipts(bot);let values=temporaryInbox.get(bot);if(!values)temporaryInbox.set(bot,values=new Map());return values;}
  function receive(bot:string,threadId:string,id:string,parentId:string,text:string){const value={id,parentId,threadId,text,date:new Date(now()).toISOString()};if(options.archive)return options.archive.receive(bot,value);const old=receipts(bot).get(id);if(old){if(old.text!==text||old.threadId!==threadId)throw new Error("Conflicting duplicate queued input");return old;}receipts(bot).set(id,value);return value;}
  // An input logged before reports became `work` stays as it was: the log is permanent, so a replay of its
  // receipt (startup recovery, a retried delivery) must match the old entry, not log it again differently.
  function appendInput(bot:string,threadId:string,key:string,raw:string,date?:string) {
    const old=db.prepare("SELECT idx,kind,text,thread_id AS threadId FROM optchat_log WHERE bot_id=? AND event_key=?").get(bot,key) as Entry|undefined;
    // Whatever OptBot would log for it today (a newer kind, an agent's name), the entry already logged stays.
    if(old&&old.threadId===threadId)return old.idx;
    const value=inputEntry(raw,options.agentName);return append(bot,threadId,key,value.kind,value.text,date);
  }
  function flushInbox(bot:string,parentId:string){for(const row of receipts(bot).values())if(row.parentId===parentId)appendInput(bot,row.threadId,`${row.id}:input`,row.text,row.date);}
  function append(bot: string, threadId: string, key: string, kind: MemoryKind, text: string, receivedDate?:string, foldView = true): number {
    // A long text is never cut: it is logged as several messages in a row, keyed key, key#2, ... (§1).
    if (text.length > MESSAGE_CHARS) {
      // Logged whole by an earlier OptBot: keep it.
      const whole = db.prepare("SELECT idx,kind,text FROM optchat_log WHERE bot_id=? AND event_key=?").get(bot, key) as { idx: number; kind: string; text: string } | undefined;
      if (whole && whole.kind === kind && whole.text === text) return whole.idx;
    }
    if (text.length > MESSAGE_CHARS) return chunks(text).map((part, n) => append(bot, threadId, n ? `${key}#${n + 1}` : key, kind, part, receivedDate, foldView))[0]!;
    const old = db.prepare("SELECT idx,kind,text,thread_id AS threadId FROM optchat_log WHERE bot_id=? AND event_key=?").get(bot, key) as Entry | undefined;
    if (old) {
      if (old.kind !== kind || old.text !== text || old.threadId !== threadId) throw new Error("Conflicting duplicate memory event");
      return old.idx;
    }
    const idx = count(bot), date = receivedDate??new Date(now()).toISOString();
    options.archive?.appendMain(bot,{ i: idx, kind, text, size: bytes(`${kind}: ${text}`), date, eventKey: key, threadId });
    db.prepare("INSERT INTO optchat_log VALUES (?,?,?,?,?,?,?)").run(bot, idx, key, kind, text, date, threadId);
    queues.get(bot)?.leaves.push(idx);
    if (foldView) refit(bot, true);
    return idx;
  }
  function requireLease(bot: string, threadId: string, lease: string) {
    const run = db.prepare("SELECT request_id AS requestId,thread_id AS threadId,lease,expires,status,result FROM optchat_runs WHERE bot_id=? AND lease=? AND status='active'").get(bot, lease) as Run | undefined;
    if (!run || run.threadId !== threadId || run.expires <= now()) throw new Error("OptChat lease expired or belongs to another conversation");
    return run;
  }
  /** UniiChat Memory.view: the built lines of `parts` before message `end`, as `<chat>\n` + `id+n|line\n`... + `</chat>\n`. */
  function chatText(bot: string, parts: Part[], end = Infinity) {
    const lines = parts.filter(part => part.start + part.count <= end).flatMap(part => { const text = node(bot, part); return text === undefined ? [] : [`${label(part)}|${flatLine(text)}\n`]; });
    return `<chat>\n${lines.join("")}</chat>\n`;
  }
  function pending(bot: string): Compression | null {
    const total = count(bot);
    // Build raw messages in order, interleaving completed binary merges.
    // ponytail: one leased compactor per bot; parallelize independent merges if throughput demands it.
    for (let end = 1; end <= total; end++) {
      const leaf = { start: end - 1, count: 1 };
      if (node(bot, leaf) === undefined) {
        const source = entry(bot, leaf.start)!;
        return { ...leaf, source: `${source.kind}: ${source.text}`, context: compactionView(bot, leaf.start) };
      }
      for (let size = 2; size <= end && end % size === 0; size *= 2) {
        const parent = { start: end - size, count: size };
        if (node(bot, parent) !== undefined) continue;
        const a = node(bot, { start: parent.start, count: size / 2 });
        const b = node(bot, { start: parent.start + size / 2, count: size / 2 });
        if (a !== undefined && b !== undefined) return { ...parent, source: mergeSource(a, b), children:[a,b], context: compactionView(bot, parent.start+parent.count) };
      }
    }
    return null;
  }
  // A compaction's view: the compactions' view's built lines before min(the node's end, the first message not
  // built), whole lines only (UniiChat Memory.build: Memory.view(mem, upto, mem.seen.parts)).
  function compactionView(bot: string, end: number) {
    const total = count(bot), first = queue(bot).leaves[0] ?? total;
    return chatText(bot, viewState(bot).seen.parts, Math.min(end, first));
  }
  function drainFree(bot: string) {
    let task: Compression | null;
    let builtAny = false;
    while ((task = pending(bot)) && bytes(task.source) <= NODE_BYTES) { saveNode(bot, task.start, task.count, task.source); builtAny = true; }
    if (builtAny) { refit(bot, false); if (task) task = pending(bot); }
    return task;
  }
  /**
   * UniiChat Memory.starts: the nodes ready up to the WINDOW-th message not built, in the order the messages came
   * (a node's ctx: a message's index, a merge's end; a merge first on a tie). Those whose source fits are built at
   * once, together, until none is left; the others are returned as jobs, `limit` at most.
   */
  function available(bot:string,busy:ReadonlySet<string>,limit:number) {
    const q=queue(bot), total=count(bot);
    const ctx=(part:Part)=>part.count===1?part.start:part.start+part.count;
    let builtAny=false, tasks:(Part&{source:string;children?:string[]})[]=[];
    for(;;) {
      const end=q.leaves[WINDOW-1]??total;
      const ready=[...q.leaves.filter(start=>start<=end).map(start=>({start,count:1})),...[...q.merges.values()].filter(part=>ctx(part)<=end)];
      ready.sort((x,y)=>ctx(x)-ctx(y)||y.count-x.count);
      const free:(Part&{source:string})[]=[];tasks=[];
      for(const part of ready) {
        if(tasks.length>=limit) break;
        if(busy.has(label(part))) continue;
        let source:string, children:string[]|undefined;
        if(part.count===1){const raw=entry(bot,part.start)!;source=`${raw.kind}: ${raw.text}`;}
        else{const a=node(bot,{start:part.start,count:part.count/2}),b=node(bot,{start:part.start+part.count/2,count:part.count/2});if(a===undefined||b===undefined)continue;children=[a,b];source=mergeSource(a,b);}
        if(bytes(source)<=NODE_BYTES) free.push({...part,source});
        else tasks.push({...part,source,...(children?{children}:{})});
      }
      if(!free.length) break;
      for(const part of free) saveNode(bot,part.start,part.count,part.source);
      builtAny=true;
    }
    if(builtAny) refit(bot,false);
    return tasks.map(task=>({...task,context:compactionView(bot,ctx(task))}));
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
      // Messages and their summaries first, then the view's appends in memory with one save: with summaries
      // missing the view could not merge and every append rescanned it, and a per-row save froze BB.
      db.transaction(()=>{
        const indexes=planned.map(row=>append(bot,row.threadId,row.eventKey,row.kind,row.text,row.date,false));
        for(const tree of [...trees].sort((x,y)=>x.l-y.l)){const n=2**tree.l,start=tree.i*n;if(node(bot,{start,count:n})===undefined)saveNode(bot,start,n,tree.text);}
        void indexes;
      })();
      queues.delete(bot); refit(bot,true); return {imported:planned.length,entries:count(bot)};
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
    enqueue(bot:string,threadId:string,id:string,parentId:string,text:string){const run=db.prepare("SELECT thread_id AS threadId,status,expires FROM optchat_runs WHERE bot_id=? AND request_id=?").get(bot,parentId) as {threadId:string;status:string;expires:number}|undefined;
      // A turn that has not begun yet (its begin still waiting, e.g. on another conversation's turn) takes the message too:
      // the receipt waits for it, and recoverQueued logs it if that turn never begins (live: a second subagent report
      // arriving as the first one's turn started was rejected, and lost).
      if(run&&run.threadId!==threadId)throw new Error("Queued input does not belong to this conversation's turn");receive(bot,threadId,id,parentId,text);if(run&&(run.status!=="active"||run.expires<=now()))flushInbox(bot,parentId);return {ok:true};},
    input(bot:string,threadId:string,lease:string,id:string,text:string){requireLease(bot,threadId,lease);const row=receipts(bot).get(id);return {id:appendInput(bot,threadId,`${id}:input`,text,row?.date)};},
    free: drainFree,
    available,
    accept(bot:string,task:Compression,text:string) {
      if(node(bot,task)!==undefined) return;
      if(!text.trim()) throw new Error("Summary must be nonempty");
      const raw=task.count===1?entry(bot,task.start):undefined;
      const a=task.count>1?node(bot,{start:task.start,count:task.count/2}):undefined,b=task.count>1?node(bot,{start:task.start+task.count/2,count:task.count/2}):undefined;
      const source=raw?`${raw.kind}: ${raw.text}`:a!==undefined&&b!==undefined?mergeSource(a,b):undefined;
      if(source!==task.source) throw new Error("Stale background compression");
      saveNode(bot,task.start,task.count,text); refit(bot,false);
    },
    // A turn waits until every message before it is summarized (UniiChat Memory.settle: first unbuilt >= from).
    settled(bot:string) { return queue(bot).leaves.length===0; },
    begin: db.transaction((bot: string, threadId: string, requestId: string, input?: string) => {
      const existing = db.prepare("SELECT status,result,answer,thread_id AS threadId FROM optchat_runs WHERE bot_id=? AND request_id=?").get(bot, requestId) as { status: string; result: string; answer: string | null; threadId: string } | undefined;
      if (existing && existing.threadId !== threadId) throw new Error("Request belongs to another conversation");
      if (input !== undefined) {
        const previous = db.prepare("SELECT text FROM optchat_log WHERE bot_id=? AND event_key=?").get(bot, `${requestId}:input`) as { text: string } | undefined;
        // The receipt keeps the raw text (receive refuses a different one); the logged form may have changed since.
        if (previous && receipts(bot).get(requestId)?.text !== input && previous.text !== chunks(inputEntry(input, options.agentName).text)[0] && previous.text !== input) throw new Error("Conflicting duplicate request input");
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
      saveNode(bot, start, size, text); refit(bot, false);
      return { ok: true };
    }),
    /**
     * This conversation's latest messages as "i|kind: text" lines, for a turn whose view interleaves the bot's other
     * conversations: null when nothing interleaves (the view's latest lines are this conversation), [] for a new
     * conversation of a bot with other history.
     */
    local(bot: string, threadId: string, maxEntries = 12, maxChars = 12_000, entryChars = 1_500) {
      const mine = db.prepare("SELECT idx,kind,text FROM optchat_log WHERE bot_id=? AND thread_id=? AND kind IN ('user','talk','work') ORDER BY idx DESC LIMIT ?").all(bot, threadId, maxEntries) as { idx: number; kind: string; text: string }[];
      const since = mine.length ? mine[mine.length - 1]!.idx : -1;
      const others = db.prepare("SELECT 1 FROM optchat_log WHERE bot_id=? AND thread_id<>? AND idx>? LIMIT 1").get(bot, threadId, since);
      if (!others) return null;
      const lines: string[] = []; let used = 0;
      for (const row of mine) {
        const text = flatLine(row.text), clipped = text.length > entryChars ? `${text.slice(0, entryChars)}… (zoom ${row.idx}+1 for the rest)` : text;
        const line = `${row.idx}+1|${row.kind}: ${clipped}`;
        if (lines.length && used + line.length > maxChars) break;
        lines.push(line); used += line.length;
      }
      return lines.reverse();
    },
    view(bot: string) {
      const text = chatText(bot, parts(bot));
      const summaryBytes=parts(bot).reduce((sum,part)=>sum+(nodeBytes(bot,part)??0),0);
      return { text, entries: count(bot), bytes: bytes(text), summaryBytes };
    },
    finish: db.transaction((bot: string, thread: string, lease: string, status: "completed" | "failed" | "stopped", result: string) => {
      const run=requireLease(bot, thread, lease);
      flushInbox(bot,run.requestId);
      if (status === "failed") append(bot, thread, `failure:${lease}`, "note", `Attempt failed: ${result}. Verify prior side effects before retrying.`);
      if (status === "stopped") append(bot, thread, `stopped:${lease}`, "note", `Stopped by the user: ${TURN_NAME}.`);
      db.prepare("UPDATE optchat_runs SET status=?,result=?,expires=0 WHERE bot_id=? AND lease=?").run(status === "stopped" ? "failed" : status, result, bot, lease);
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
    // UniiChat Memory.zoom: a message (n = 1) a page from `at`; else the two lines under id+n, an unbuilt one as the
    // placeholder; a bad line names the tree's roots so the agent can start over from them.
    zoomText(bot:string,start:number,size:number,at=0) {
      const total=count(bot);
      if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(size)||size<1||Math.log2(size)%1!==0||start%size!==0||start+size>total)return `No line ${start}+${size}: n is a power of 2, id a multiple of n. The tree's roots: ${roots(total).join(", ")}.`;
      if(size===1){const raw=entry(bot,start)!;return `${start}+0|${raw.kind}: ${clipPage(raw.text,Math.max(0,Math.min(at,raw.text.length)))}`;}
      return [start,start+size/2].map(idx=>{const value=node(bot,{start:idx,count:size/2});return `${idx}+${size/2}|${value===undefined?"(not summarized yet: zoom it)":value.replace(/\s*(\r\n|\n|\r)\s*/g," ")}`;}).join("\n");
    },
    dateText(bot:string,id:number) {const raw=entry(bot,id);return raw?new Date(raw.date).toLocaleString("sv-SE"):`No message ${id}.`;},
    search(bot: string, query: string, after = -1) {
      return db.prepare("SELECT idx,kind,date,thread_id AS threadId,substr(text,1,2000) AS text FROM optchat_log WHERE bot_id=? AND idx>? AND instr(lower(text),lower(?))>0 ORDER BY idx LIMIT 50").all(bot, after, query) as Entry[];
    },
    /** Turns still marked running: a restart cut those whose lease ran out (their bridge heartbeats every 10 s). */
    runningTurns() { return db.prepare("SELECT bot_id AS bot,thread_id AS threadId,request_id AS requestId,expires FROM optchat_runs WHERE status='active'").all() as { bot: string; threadId: string; requestId: string; expires: number }[]; },
    /** Ends a cut turn, keeping the messages that waited on it; false if it ended or came back meanwhile. */
    abandon: db.transaction((bot: string, requestId: string) => {
      const run = db.prepare("SELECT 1 FROM optchat_runs WHERE bot_id=? AND request_id=? AND status='active' AND expires<=?").get(bot, requestId, now());
      if (!run) return false;
      flushInbox(bot, requestId);
      db.prepare("UPDATE optchat_runs SET status='failed',result='cut by a restart' WHERE bot_id=? AND request_id=?").run(bot, requestId);
      return true;
    }),
    note: db.transaction((bot: string, threadId: string, key: string, text: string) => append(bot, threadId, key, "note", text)),
    /** Whether a turn in this conversation still holds an unexpired lease (its bridge heartbeats every 10 s). */
    liveTurn(threadId: string) { return db.prepare("SELECT 1 FROM optchat_runs WHERE thread_id=? AND status='active' AND expires>?").get(threadId, now()) !== undefined; },
    stats(bot: string) { return { entries: count(bot), nodes: (db.prepare("SELECT COUNT(*) AS n FROM optchat_nodes WHERE bot_id=?").get(bot) as { n: number }).n, parts: parts(bot) }; },
  };
}
export type OptChat = ReturnType<typeof createOptChat>;
