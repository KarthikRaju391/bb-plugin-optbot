// Subagents, as UniiChat's Tools.ts spawn/tell and Call.ts reports, on BB: an agent is a visible BB thread under the
// bot's conversation, on the turn's provider and model. It starts from the bot's view and its own chat; when it goes
// idle its replies come back to the conversation as one `work` message, "[thr_…]\n...\n\nFull chat: ...". The bot
// never waits or polls. An agent's chat is its BB thread: zoom by name reads it from the thread's events, live.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ModelEvent } from "../runtime/turn";
import { bbModelRef } from "../runtime/bb";

export const AGENT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
// A task is its text, or {title, task}: the title names the agent's thread in the sidebar (else its first line).
const spawnTask = z.union([z.string().min(1), z.object({ title: z.string().min(1).max(80), task: z.string().min(1) }).strict()]);
export const spawnInput = z.object({ tasks: z.array(spawnTask).min(1).max(16), effort: z.enum(AGENT_EFFORTS).optional() }).strict();
export const tellInput = z.object({ agent: z.string().min(1).max(64), message: z.string().min(1) }).strict();
export const SPAWN_DESCRIPTION = "Start one subagent per task, in parallel, and return each one's thread id at once; an agent is known by its thread id. Give each task a short title, as {title, task}: it names the agent's thread in the user's sidebar. Each one's report reaches you as a message \"[thread id] report\" when it finishes. A subagent sees the view, but knows what you want only from its task.";
export const TELL_DESCRIPTION = "Send a message to an agent, by its thread id. One at work reads it between its tool calls, and its report answers it; an idle one goes on from its chat, and its reply reaches you as a message \"[thread id] reply\".";

// UniiChat SUB_HEAD and its VIEW_DOC, with Unii renamed OptBot and OptBot's memory tool syntax; no devices. The bot's
// identity (SOUL.md) is left out: it speaks to the bot ("split work into threads"), and the view already carries what
// the user wants, decided and taught.
export const SUB_PROMPT = `You are a subagent of OptBot, an AI agent that works for one user in a
single chat that never ends. OptBot gave you a task. Do it yourself, with
your tools; don't hand it to other threads or agents.

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
"[its thread id]"). A short message is its own line, word for word. Recent lines
cover one message each; the older the messages, the more a line covers.
A message not summarized yet shows as "(not summarized yet: zoom it)".
No message appears in full, not even the last ones. A text too long for
one message is split over several in a row.

Navigating: optbot_memory({action: "zoom", start: id, count: n}) opens line id+n into the two lines of n/2
messages it was made from; count 1 gives message id in full. Zoom whenever a summary
only mentions something you need, such as what your last reply said, a
decision, a past attempt or where a file is, before you act, guess or
ask. optbot_memory({action: "date", start: id}) gives the date and time of message id.
optbot_memory({action: "zoom", agent: "thr_…"}) gives an agent's whole chat.`;

const SUB_NOTE = "subagent", SUB_AT = " at effort ";
/** UniiChat Call.ts report_text, with OptBot's zoom syntax. */
export function reportText(agent: string, text: string) { return `[${agent}]\n${text}\n\nFull chat: optbot_memory({action: "zoom", agent: "${agent}"})`; }
// An agent is known by its thread id; older reports used a two-word name (SteadyCobra) and still match.
export const REPORT = /^\[(thr_[A-Za-z0-9]+|[A-Z][a-z]+[A-Z][a-z]+)\]\n[\s\S]*\n\nFull chat: optbot_memory\(\{action: "zoom", (?:agent|name): "\1"\}\)$/;

type Row = { bot: string; name: string; thread: string; conversation: string; cursor: string | null; status: string };
type Deps = {
  view(bot: string): string;
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
    const view = deps.view(owner.bot);
    const started: string[] = [];
    for (const entry of input.tasks) {
      const task = typeof entry === "string" ? entry : entry.task;
      const title = (typeof entry === "string" ? entry.split("\n")[0]! : entry.title).slice(0, 80);
      const note = SUB_NOTE + (input.effort ? SUB_AT + input.effort : "");
      const first = [SUB_PROMPT, view, `0|note: ${note}\n\n1|user: ${task}`].join("\n\n");
      const thread = await bb.sdk.threads.spawn({
        projectId: conversation.projectId, environment: { type: "reuse", environmentId: conversation.environmentId },
        ...ref, ...(input.effort ? { reasoningLevel: input.effort } : owner.reasoning ? { reasoningLevel: owner.reasoning } : {}),
        prompt: first, title, parentThreadId: owner.parent, permissionMode: "full",
        pluginMetadata: { optbotAgent: "subagent" },
      } as Parameters<typeof bb.sdk.threads.spawn>[0]);
      // An agent is known by its BB thread id: no made-up name.
      db.prepare("INSERT INTO optbot_agents VALUES (?,?,?,?,NULL,'active')").run(owner.bot, thread.id, thread.id, owner.parent);
      started.push(`${thread.id}: ${title}`);
    }
    return `Started:\n${started.join("\n")}\nEach one's report will reach you as a message when it finishes.`;
  }

  async function tell(workerThread: string, input: z.infer<typeof tellInput>) {
    const owner = deps.worker(workerThread);
    const row = owner ? byName(owner.bot, input.agent) : undefined;
    if (!owner || !row) return `No agent ${input.agent} to tell.`;
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
