import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOptChat, NODE_BYTES } from "../lib/optchat";
import { acquireCompactor } from "../lib/compactor";

/**
 * The compactor against a fake `claude` binary at the process boundary: it reads the prompt on stdin and prints its
 * answer as `claude --print --output-format text` does (the answer text on stdout, exit 0). A single-node prompt
 * ("Compaction: compress message N" / "merge lines") gets one line; a batch prompt (`<task id="id+n">` blocks) gets one
 * `id+n|line` line per task. Each line names the MSG-i markers of its <input>, so a node's text shows exactly which
 * messages it covers. FAKE_PLAN scripts failures by task id; calls.jsonl records every call.
 */
const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const dir = process.env.FAKE_DIR, plan = JSON.parse(process.env.FAKE_PLAN || "{}");
let input = "";
process.stdin.on("data", c => { input += c; });
process.stdin.on("end", async () => {
  const run = dir + "/running/" + process.pid; fs.writeFileSync(run, "");
  const running = fs.readdirSync(dir + "/running").length;
  const blocks = [...input.matchAll(/<task id="(\\d+\\+\\d+)">([\\s\\S]*?)<\\/task>/g)].map(m => ({ id: m[1], body: m[2] }));
  const single = !blocks.length;
  const once = (kind, id) => { const f = dir + "/" + kind + "-" + id; if (fs.existsSync(f)) return false; fs.writeFileSync(f, ""); return true; };
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ pid: process.pid, running, start: Date.now(), single, ids: blocks.map(b => b.id), notes: blocks.filter(b => b.body.includes("Too long")).map(b => b.id) }) + "\\n");
  const hang = blocks.some(b => (plan.hangOnce || []).includes(b.id) && once("hang", b.id));
  if (hang) { setInterval(() => {}, 1000); return; }
  await new Promise(r => setTimeout(r, Number(process.env.FAKE_DELAY_MS || 60)));
  const line = body => { const inp = body.slice(body.lastIndexOf("<input>")); const marks = [...new Set(inp.match(/MSG-\\d+/g) || [])].join(" "); const head = "summary " + marks + " "; return head + "x".repeat(Math.max(0, 300 - head.length)); };
  let out = "";
  if (single) out = line(input);
  else for (const b of blocks) {
    if ((plan.missingOnce || []).includes(b.id) && once("missing", b.id)) continue;
    if ((plan.tooLongOnce || []).includes(b.id) && once("long", b.id)) { out += b.id + "|" + "y".repeat(700) + "\\n"; continue; }
    out += b.id + "|" + line(b.body) + "\\n";
  }
  fs.rmSync(run);
  process.stdout.write(out);
});
`;
type Call = { pid: number; running: number; start: number; single: boolean; ids: string[]; notes: string[] };
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(plan: object = {}, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "optbot-batch-")); dirs.push(dir);
  mkdirSync(join(dir, "running"));
  const bin = join(dir, "claude"); writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  const env = { OPTBOT_CLAUDE_EXECUTABLE: bin, FAKE_DIR: dir, FAKE_PLAN: JSON.stringify(plan), ...extraEnv };
  const calls = () => existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Call) : [];
  return { dir, env, calls };
}
/** Messages too long to be their own line (> 512 bytes), each tagged MSG-i. */
function messages(n: number, from = 0) { return Array.from({ length: n }, (_, k) => ({ kind: "user" as const, text: `MSG-${from + k} ${"filler ".repeat(100)}` })); }
/** The ids of a full tree's nodes over n messages that need a model (leaves and merges; every merge source > 512 bytes here). */
function expectedNodes(n: number) {
  const ids: { start: number; count: number }[] = [];
  for (let size = 1; size <= n; size *= 2) for (let start = 0; start + size <= n; start += size) ids.push({ start, count: size });
  return ids;
}
function nodeRows(db: Database.Database, bot: string) { return db.prepare("SELECT start,count,text FROM optchat_nodes WHERE bot_id=? ORDER BY count,start").all(bot) as { start: number; count: number; text: string }[]; }
async function until(check: () => boolean, ms = 30_000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise(r => setTimeout(r, 50)); } }
/** Every node exists once, fits 512 bytes, and names exactly the messages of its span. */
function expectTree(db: Database.Database, bot: string, n: number) {
  const rows = nodeRows(db, bot), byId = new Map(rows.map(row => [`${row.start}+${row.count}`, row.text]));
  expect(rows.length).toBe(expectedNodes(n).length);
  for (const { start, count } of expectedNodes(n)) {
    const text = byId.get(`${start}+${count}`);
    expect(text, `${start}+${count}`).toBeDefined();
    expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(NODE_BYTES);
    const marks = [...text!.matchAll(/MSG-(\d+)/g)].map(m => Number(m[1])).sort((a, b) => a - b);
    expect(marks, `${start}+${count}`).toEqual(Array.from({ length: count }, (_, k) => start + k));
  }
}
async function compactor(root: string, db: Database.Database, chat: ReturnType<typeof createOptChat>, env: Record<string, string>, reports: string[] = []) {
  const worker = await acquireCompactor(root, { chat, report: message => { reports.push(message); }, retryMs: 200, options: async signal => ({ model: "bb/claude-code/fake", env, signal, system: "" }) } as Parameters<typeof acquireCompactor>[1]);
  closers.push(() => worker.close());
  return worker;
}
function seed(chat: ReturnType<typeof createOptChat>, bot: string, n: number) { chat.importEntries(bot, messages(n)); }

describe("CLI compactor batches summaries", () => {
  it("compresses a 40-message backlog in a few calls, at most 2 at once, each node mapped to its own messages", async () => {
    const { env, calls } = setup();
    const db = new Database(":memory:"), chat = createOptChat(db);
    seed(chat, "bot_a", 40);
    const worker = await compactor(`batch-basic-${Date.now()}`, db, chat, env);
    worker.pump("bot_a");
    await until(() => nodeRows(db, "bot_a").length === expectedNodes(40).length);
    expectTree(db, "bot_a", 40);
    const log = calls();
    // 78 nodes need a model; one call per node would be 78 calls.
    expect(log.length).toBeLessThanOrEqual(16);
    expect(Math.max(...log.map(call => call.running))).toBeLessThanOrEqual(2);
    expect(log.every(call => !call.single && call.ids.length <= 32)).toBe(true);
    // No node is asked twice when every line is good.
    const asked = log.flatMap(call => call.ids);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("re-asks only the item whose line was too long or missing, with the too-long note for that item alone", async () => {
    const { env, calls } = setup({ tooLongOnce: ["5+1"], missingOnce: ["9+1"] });
    const db = new Database(":memory:"), chat = createOptChat(db);
    seed(chat, "bot_a", 16);
    const worker = await compactor(`batch-bad-${Date.now()}`, db, chat, env);
    worker.pump("bot_a");
    await until(() => nodeRows(db, "bot_a").length === expectedNodes(16).length);
    expectTree(db, "bot_a", 16);
    const log = calls(), asked = log.flatMap(call => call.ids);
    const times = (id: string) => asked.filter(x => x === id).length;
    expect(times("5+1")).toBe(2);
    expect(times("9+1")).toBe(2);
    for (let i = 0; i < 16; i++) if (i !== 5 && i !== 9) expect(times(`${i}+1`), `${i}+1`).toBe(1);
    expect(log.flatMap(call => call.notes)).toEqual(["5+1"]);
  });

  it("retries the items of a batch whose CLI call timed out, keeping the other batch's lines", async () => {
    const { env, calls } = setup({ hangOnce: ["12+1"] }, { OPTBOT_SUMMARY_TIMEOUT_MS: "1500" });
    const db = new Database(":memory:"), chat = createOptChat(db), reports: string[] = [];
    seed(chat, "bot_a", 24);
    const worker = await compactor(`batch-timeout-${Date.now()}`, db, chat, env, reports);
    worker.pump("bot_a");
    await until(() => nodeRows(db, "bot_a").length === expectedNodes(24).length);
    expectTree(db, "bot_a", 24);
    const log = calls(), hung = log.find(call => call.ids.includes("12+1"))!;
    const asked = log.flatMap(call => call.ids);
    for (const id of hung.ids) expect(asked.filter(x => x === id).length, id).toBe(2);
    for (const id of new Set(asked)) if (!hung.ids.includes(id)) expect(asked.filter(x => x === id).length, id).toBe(1);
    expect(reports.some(message => /timed out/.test(message))).toBe(true);
    expect(reports.some(message => /Stale/.test(message))).toBe(false);
  });

  it("after a restart mid-batch, keeps the lines already saved and builds the rest once", async () => {
    const { dir, env, calls } = setup({ hangOnce: ["20+1"] });
    const file = join(dir, "data.db");
    let db = new Database(file), chat = createOptChat(db);
    seed(chat, "bot_a", 40);
    const first = await compactor(`batch-restart-a-${Date.now()}`, db, chat, env);
    first.pump("bot_a");
    // Wait until the batch holding 20+1 hangs and the other batch's leaves are saved, then stop as a restart would.
    await until(() => calls().some(call => call.ids.includes("20+1")) && Array.from({ length: 20 }, (_, i) => i).every(i => nodeRows(db, "bot_a").some(row => row.count === 1 && row.start === i)));
    await first.close(); closers.length = 0;
    const before = new Map(nodeRows(db, "bot_a").map(row => [`${row.start}+${row.count}`, row.text]));
    expect(before.has("20+1")).toBe(false);
    db.close();
    db = new Database(file); chat = createOptChat(db);
    const second = await compactor(`batch-restart-b-${Date.now()}`, db, chat, env);
    second.pump("bot_a");
    await until(() => nodeRows(db, "bot_a").length === expectedNodes(40).length);
    expectTree(db, "bot_a", 40);
    const after = new Map(nodeRows(db, "bot_a").map(row => [`${row.start}+${row.count}`, row.text]));
    for (const [id, text] of before) expect(after.get(id), id).toBe(text);
    const asked = calls().flatMap(call => call.ids);
    for (const id of before.keys()) expect(asked.filter(x => x === id).length, id).toBe(1);
    db.close();
  });

  it("two bots compacting at once share the 2 CLI slots and both make progress", async () => {
    const { env, calls } = setup({}, { FAKE_DELAY_MS: "150" });
    const db = new Database(":memory:"), chat = createOptChat(db);
    seed(chat, "bot_a", 40); seed(chat, "bot_b", 40);
    const worker = await compactor(`batch-two-${Date.now()}`, db, chat, env);
    worker.pump("bot_a"); worker.pump("bot_b");
    let firstB: number | undefined, doneA: number | undefined;
    await until(() => {
      firstB ??= nodeRows(db, "bot_b").length ? Date.now() : undefined;
      doneA ??= nodeRows(db, "bot_a").length === expectedNodes(40).length ? Date.now() : undefined;
      return nodeRows(db, "bot_a").length === expectedNodes(40).length && nodeRows(db, "bot_b").length === expectedNodes(40).length;
    });
    // bot_b is not starved until bot_a is done.
    expect(firstB!).toBeLessThan(doneA!);
    expectTree(db, "bot_a", 40); expectTree(db, "bot_b", 40);
    const log = calls();
    expect(Math.max(...log.map(call => call.running))).toBeLessThanOrEqual(2);
    expect(log.length).toBeLessThanOrEqual(32);
  });
});
