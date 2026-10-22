// Subagents, as UniiChat's Tools.ts spawn/tell and Call.ts reports, on BB: an agent is a visible BB thread under the
// bot's conversation, on the turn's provider and model. It starts from the bot's view and its own chat; when it goes
// idle its replies come back to the conversation as one `work` message, "[Name]\n...\n\nFull chat: ...". The bot
// never waits or polls. An agent's chat is its BB thread: zoom by name reads it from the thread's events, live.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ModelEvent } from "../runtime/turn";
import { bbModelRef } from "../runtime/bb";

export const AGENT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export const spawnInput = z.object({ tasks: z.array(z.string().min(1)).min(1).max(16), effort: z.enum(AGENT_EFFORTS).optional() }).strict();
export const tellInput = z.object({ name: z.string().min(1).max(64), message: z.string().min(1) }).strict();
export const SPAWN_DESCRIPTION = "Start one subagent per task, in parallel, and return their names at once. Each one's report reaches you as a message \"[Name] report\" when it finishes. A subagent sees the view and the user's instructions, but knows what you want only from its task.";
export const TELL_DESCRIPTION = "Send a message to an agent, by name. One at work reads it between its tool calls, and its report answers it; an idle one goes on from its chat, and its reply reaches you as a message \"[Name] reply\".";

// UniiChat SUB_HEAD and its VIEW_DOC, with Unii renamed OptBot and OptBot's memory tool syntax; no devices.
export const SUB_PROMPT = `You are a subagent of OptBot, an AI agent that works for one user in a
single chat that never ends. OptBot gave you a task. Do it yourself, with
your tools, following the user's instructions at the end of this
prompt: they say who the user is, how their files are organized and how
they want work done.

Your first message holds the view below, then your chat with OptBot so far,
its lines as "i|kind: text": what you are (note), your task (user), and
later all you did and were told. The view shows you what OptBot knows: what the user wants,
decided and taught. Use it as context only, and do what your task says,
not what the user's last message says, since OptBot may have given you
just part of the work. Your final reply is your report to OptBot. OptBot may
send you more messages, even while you work: answer the last.

The view: the whole chat between OptBot and the user, oldest first, inside
<chat> tags, as one-line summaries. Each line is

  id+n|text   the n messages from id on, summarized (newlines shown as spaces)

A summary tags each item with its kind: user (the user's words), talk
(OptBot's replies), tool (OptBot's tool calls), echo (their results), note
(memories from before this chat), or work (the report of an agent, starting
"[Name]"). A short message is its own line, word for word. Recent lines
cover one message each; the older the messages, the more a line covers.
A message not summarized yet shows as "(not summarized yet: zoom it)".
No message appears in full, not even the last ones. A text too long for
one message is split over several in a row.

Navigating: optbot_memory({action: "zoom", start: id, count: n}) opens line id+n into the two lines of n/2
messages it was made from; count 1 gives message id in full. Zoom whenever a summary
only mentions something you need, such as what your last reply said, a
decision, a past attempt or where a file is, before you act, guess or
ask. optbot_memory({action: "date", start: id}) gives the date and time of message id.
optbot_memory({action: "zoom", name: "Name"}) gives an agent's whole chat.`;

const SUB_NOTE = "subagent", SUB_AT = " at effort ";
// Two-word names (UniiChat Names.ts: adjective + noun); OptBot's own word lists.
const ADJECTIVES = "Amber Brave Brisk Calm Clever Copper Crisp Dusky Eager Fancy Fleet Gentle Golden Grand Hardy Hazel Ivory Jolly Keen Kind Lively Lucky Mellow Merry Misty Nimble Noble Olive Plucky Quick Quiet Rapid Rosy Ruby Rusty Sandy Sharp Silent Silver Sleek Smart Snowy Solid Spry Steady Stout Sunny Swift Tidy Topaz Trusty Vivid Wary Witty Zesty Bold Cosy Daring Ember Frosty Hasty Jade Lunar".split(" ");
const NOUNS = "Ant Badger Bat Bear Beaver Bee Bison Boar Buck Camel Cat Cobra Crane Crow Deer Dingo Dove Duck Eagle Eel Elk Falcon Ferret Finch Fox Frog Gecko Goat Goose Hare Hawk Heron Ibis Jay Koala Lark Lemur Lion Llama Lynx Mole Moose Moth Newt Otter Owl Panda Pike Puma Quail Raven Robin Seal Shark Sloth Snail Swan Tiger Toad Trout Viper Wolf Wren Yak".split(" ");
export function agentName(taken: (name: string) => boolean, random = Math.random) {
  for (let tries = 0; tries < 1000; tries++) {
    const name = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)]! + NOUNS[Math.floor(random() * NOUNS.length)]!;
    if (!taken(name)) return name;
  }
  throw new Error("No agent name left");
}
/** UniiChat Call.ts report_text, with OptBot's zoom syntax. */
export function reportText(name: string, text: string) { return `[${name}]\n${text}\n\nFull chat: optbot_memory({action: "zoom", name: "${name}"})`; }
export const REPORT = /^\[([A-Z][a-z]+[A-Z][a-z]+)\]\n[\s\S]*\n\nFull chat: optbot_memory\(\{action: "zoom", name: "\1"\}\)$/;

type Row = { bot: string; name: string; thread: string; conversation: string; cursor: string | null; status: string };
type Deps = {
  view(bot: string): string;
  rules(bot: string): string | undefined;
  worker(threadId: string): { bot: string; parent: string; model: string | null; reasoning: string | null } | null;
  nativeEvents(item: unknown): ModelEvent[];
};

export function createAgents(bb: BbPluginApi, deps: Deps) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS optbot_agents (bot TEXT NOT NULL, name TEXT NOT NULL, thread TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL, cursor TEXT, status TEXT NOT NULL, PRIMARY KEY(bot, name));`);
  const byName = (bot: string, name: string) => db.prepare("SELECT * FROM optbot_agents WHERE bot=? AND name=?").get(bot, name) as Row | undefined;
  const byThread = (thread: string) => db.prepare("SELECT * FROM optbot_agents WHERE thread=?").get(thread) as Row | undefined;
  type Event = { seq: number; type: string; data: { item?: unknown; input?: { type: string; text?: string }[]; status?: string; error?: { message?: string } } };
  async function events(threadId: string, types: string[], after?: string) {
    const all: Event[] = [];
    for (let cursor = after; ;) {
      const rows = await bb.sdk.threads.events.list({ threadId, afterSeq: cursor, order: "asc", limit: "100", types } as unknown as Parameters<typeof bb.sdk.threads.events.list>[0]) as Event[];
      all.push(...rows);
      if (rows.length < 100) return all;
      cursor = String(rows.at(-1)!.seq);
    }
  }
  const entryText = (entry: ModelEvent) => entry.kind === "tool" ? `${entry.name} ${JSON.stringify(entry.input)}` : entry.kind === "echo" ? (entry.error ? "error: " : "") + (entry.text || "(no output)") : entry.kind === "talk" ? entry.text : null;
  /** UniiChat Memory.agent_show: an agent's chat as "i|kind: text" entries, read from its BB thread. */
  async function chat(bot: string, name: string) {
    const row = byName(bot, name);
    if (!row) return null;
    const lines: string[] = [];
    for (const event of await events(row.thread, ["client/turn/requested", "item/completed"])) {
      if (event.type === "client/turn/requested") {
        const text = (event.data.input ?? []).flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n\n");
        // Its first message: the prompt and the view, then its note and task; only those two are its chat.
        const first = lines.length === 0 ? /\n\n0\|note: ([^\n]*)\n\n1\|user: ([\s\S]*)$/.exec(text) : null;
        if (first) lines.push(`note: ${first[1]}`, `user: ${first[2]}`);
        else if (text) lines.push(`user: ${text}`);
        continue;
      }
      for (const entry of deps.nativeEvents(event.data.item)) { const text = entryText(entry); if (text !== null) lines.push(`${entry.kind}: ${text}`); }
    }
    return lines.map((line, i) => `${i}|${line}`).join("\n\n");
  }

  async function spawn(workerThread: string, input: z.infer<typeof spawnInput>) {
    const owner = deps.worker(workerThread);
    if (!owner) throw new Error("Subagents start only from a bot's turn");
    const [worker, conversation] = await Promise.all([bb.sdk.threads.get({ threadId: workerThread }), bb.sdk.threads.get({ threadId: owner.parent })]);
    const ref = owner.model ? bbModelRef(owner.model) : { providerId: worker.providerId };
    if (!conversation.environmentId) throw new Error("The conversation has no environment for agents");
    const view = deps.view(owner.bot), rules = deps.rules(owner.bot);
    const names: string[] = [];
    for (const task of input.tasks) {
      const name = agentName(candidate => byName(owner.bot, candidate) !== undefined || names.includes(candidate));
      names.push(name);
      const note = SUB_NOTE + (input.effort ? SUB_AT + input.effort : "");
      const first = [SUB_PROMPT, rules, view, `0|note: ${note}\n\n1|user: ${task}`].filter(Boolean).join("\n\n");
      const thread = await bb.sdk.threads.spawn({
        projectId: conversation.projectId, environment: { type: "reuse", environmentId: conversation.environmentId },
        ...ref, ...(input.effort ? { reasoningLevel: input.effort } : owner.reasoning ? { reasoningLevel: owner.reasoning } : {}),
        prompt: first, title: `${name}: ${task.split("\n")[0]!.slice(0, 60)}`, parentThreadId: owner.parent, permissionMode: "full",
        pluginMetadata: { optbotAgent: name },
      } as Parameters<typeof bb.sdk.threads.spawn>[0]);
      db.prepare("INSERT INTO optbot_agents VALUES (?,?,?,?,NULL,'active')").run(owner.bot, name, thread.id, owner.parent);
    }
    return `Started ${names.join(", ")}. Each one's report will reach you as a message when it finishes.`;
  }

  async function tell(workerThread: string, input: z.infer<typeof tellInput>) {
    const owner = deps.worker(workerThread);
    const row = owner ? byName(owner.bot, input.name) : undefined;
    if (!owner || !row) return `No agent ${input.name} to tell.`;
    const thread = await bb.sdk.threads.get({ threadId: row.thread });
    const working = thread.status === "active" || thread.status === "starting";
    db.prepare("UPDATE optbot_agents SET status='active' WHERE thread=?").run(row.thread);
    await bb.sdk.threads.send({ threadId: row.thread, mode: working ? "steer" : "start", input: [{ type: "text", text: input.message, mentions: [] }] } as Parameters<typeof bb.sdk.threads.send>[0]);
    return working ? `Sent. ${row.name} reads it between its tool calls, and its report answers it.` : `Sent. ${row.name}'s reply will reach you as a message.`;
  }

  // BB itself tells the parent conversation when a child thread completes, fails or is interrupted ("[bb system]
  // @thread:<id> completed: <its final reply>"); OptBot logs that as the agent's report (optchat inputEntry).
  // Here an agent is only marked done, so a restart knows which agents it cut.
  const settle = (threadId: string) => db.prepare("UPDATE optbot_agents SET status='idle' WHERE thread=?").run(threadId);
  bb.events.on("thread.idle", ({ thread }) => { if (byThread(thread.id)) settle(thread.id); });
  // BB marks a thread failed when one command fails, even while its turn runs on: done only once it stopped.
  bb.events.on("thread.failed", async ({ thread }) => {
    if (!byThread(thread.id)) return;
    const { status } = await bb.sdk.threads.get({ threadId: thread.id });
    if (status !== "active" && status !== "starting") settle(thread.id);
  });
  async function last(threadId: string, type: string) {
    const [event] = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: [type] } as unknown as Parameters<typeof bb.sdk.threads.events.list>[0]) as Event[];
    return event;
  }

  /**
   * After a restart: agents whose last turn was cut (started and never completed, or interrupted) are returned by
   * conversation to go on (UniiChat Chat.resume). Those that finished are done: BB delivers their outcome itself.
   */
  async function recover() {
    const cut = new Map<string, { bot: string; names: string[] }>();
    for (const row of db.prepare("SELECT * FROM optbot_agents WHERE status='active'").all() as Row[]) {
      const thread = await bb.sdk.threads.get({ threadId: row.thread }).catch(() => null);
      if (!thread || thread.archivedAt) { db.prepare("UPDATE optbot_agents SET status='idle' WHERE thread=?").run(row.thread); continue; }
      if (thread.status === "active" || thread.status === "starting") continue;
      const [started, completed] = [await last(row.thread, "turn/started"), await last(row.thread, "turn/completed")];
      const cutShort = !completed || (started !== undefined && started.seq > completed.seq) || completed.data.status === "interrupted";
      if (!cutShort) { settle(row.thread); continue; }
      const entry = cut.get(row.conversation) ?? { bot: row.bot, names: [] };
      entry.names.push(row.name); cut.set(row.conversation, entry);
    }
    return cut;
  }
  async function goOn(bot: string, name: string, text: string) {
    const row = byName(bot, name);
    if (!row) return;
    await bb.sdk.threads.send({ threadId: row.thread, mode: "auto", input: [{ type: "text", text, mentions: [] }] } as Parameters<typeof bb.sdk.threads.send>[0]);
  }

  return { spawn, tell, chat, recover, goOn, isAgent: (threadId: string) => byThread(threadId) !== undefined, name: (threadId: string) => byThread(threadId)?.name ?? null };
}
