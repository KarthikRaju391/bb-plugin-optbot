import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../lib/archive";
import { createOptChat } from "../lib/optchat";

// hydrate runs for every bot every second (the compactor) and on every memory call. On the live server it counted every
// message and node with COUNT(*): ~1 s and ~0.3 s for a 21,643-message bot under load (profile, 2026-10-30).
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const bot = "synthetic_bot", thread = "synthetic_thread", date = "2026-01-01T00:00:00.000Z";
const line = (i: number) => { const text = `message ${i}`; return { i, kind: "user", text, size: Buffer.byteLength(`user: ${text}`), date, eventKey: `m${i}:input`, threadId: thread }; };

async function fixture(count: number) {
  const root = mkdtempSync(join(tmpdir(), "optchat-hydrate-perf-"));
  mkdirSync(join(root, bot, "main"), { recursive: true });
  writeFileSync(join(root, bot, "main", "2026-01-01.jsonl"), Array.from({ length: count }, (_, i) => JSON.stringify(line(i)) + "\n").join(""));
  const archive = await openArchive(root);
  const db = new Database(":memory:");
  const chat = createOptChat(db, { archive, now: () => 100_000 });
  chat.hydrate(bot);
  // Every statement the chat runs from here on (the archive's own reads are in memory).
  const statements: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => { statements.push(sql.replace(/\s+/g, " ")); return prepare(sql); }) as typeof db.prepare;
  cleanups.push(async () => { db.close(); await archive.close(); rmSync(root, { recursive: true, force: true }); });
  return { archive, chat, db, statements };
}
const counts = (statements: string[]) => statements.filter((sql) => /COUNT\(\*\)/i.test(sql));
const fullReads = (statements: string[]) => statements.filter((sql) => /SELECT idx,kind,text,date,event_key/.test(sql));

it("hydrates a loaded bot without counting or rereading its history", async () => {
  const { chat, statements } = await fixture(300);
  for (let i = 0; i < 5; i++) chat.hydrate(bot);
  expect(counts(statements)).toEqual([]);
  expect(fullReads(statements)).toEqual([]);
});

it("stays on the fast path after building its own summary nodes", async () => {
  const { archive, chat, db, statements } = await fixture(16);
  chat.available(bot, new Set(), 8); // short messages are their own nodes: saved right here
  expect(archive.load(bot).tree.size).toBeGreaterThan(0);
  statements.length = 0;
  chat.hydrate(bot);
  expect(counts(statements)).toEqual([]);
  expect((db.prepare("SELECT COUNT(*) AS n FROM optchat_nodes WHERE bot_id=?").get(bot) as { n: number }).n).toBe(archive.load(bot).tree.size);
});

it("keeps the fast path exact as messages are recorded", async () => {
  const { archive, chat, db, statements } = await fixture(10);
  archive.receive(bot, { id: "late", parentId: "late-parent", threadId: thread, text: "late", date });
  chat.recoverQueued(bot);
  chat.hydrate(bot);
  expect(fullReads(statements)).toEqual([]);
  // The count used everywhere (append, views, compaction) matches the rows and the archive.
  expect(chat.stats(bot).entries).toBe(11);
  expect((db.prepare("SELECT COUNT(*) AS n FROM optchat_log WHERE bot_id=?").get(bot) as { n: number }).n).toBe(11);
  expect(archive.load(bot).main).toHaveLength(11);
});

it("notices nodes another instance wrote to the shared archive, with one count and no reload", async () => {
  const { archive, chat, db, statements } = await fixture(8);
  // Another OptChat instance on the same database and archive (as during a plugin reload) saves a node.
  archive.appendTree(bot, { l: 0, i: 3, text: "summary of 3", size: Buffer.byteLength("summary of 3") });
  db.prepare("INSERT INTO optchat_nodes VALUES (?,?,?,?)").run(bot, 3, 1, "summary of 3");
  statements.length = 0;
  chat.hydrate(bot);
  chat.hydrate(bot);
  expect(counts(statements).filter((sql) => sql.includes("optchat_nodes"))).toHaveLength(1);
  expect(fullReads(statements)).toEqual([]);
});

it("repairs the cache when the archive has a node SQLite lacks", async () => {
  const { archive, chat, db } = await fixture(8);
  archive.appendTree(bot, { l: 0, i: 5, text: "only in the archive", size: Buffer.byteLength("only in the archive") });
  chat.hydrate(bot);
  expect(db.prepare("SELECT text FROM optchat_nodes WHERE bot_id=? AND start=5 AND count=1").get(bot)).toEqual({ text: "only in the archive" });
});
