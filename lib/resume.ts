// UniiChat Chat.wake/resume on BB: a BB restart kills each conversation's bridge mid-turn. Once a turn's lease has run
// out and its thread is no longer active, the turn was cut: the conversation gets a new turn whose message is
// "The server restarted, cutting OptBot's turn; nothing was lost: go on." (logged as a note), and each agent the
// restart cut is told the same. A plugin reload alone cuts nothing: live bridges keep their threads active.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { OptChat } from "./optchat";
import { LEASE_MS, resumeText, TURN_NAME } from "./optchat";
import type { createAgents } from "./agents";

type Agents = Pick<ReturnType<typeof createAgents>, "recover" | "goOn">;

export async function resumeCut(bb: BbPluginApi, chat: Pick<OptChat, "runningTurns" | "abandon" | "note">, agents: Agents, now = Date.now()) {
  const cut = await agents.recover();
  const turns = new Map<string, string>();
  for (const run of chat.runningTurns()) {
    if (run.expires > now) continue;
    const thread = await bb.sdk.threads.get({ threadId: run.threadId }).catch(() => null);
    if (thread && (thread.status === "active" || thread.status === "starting")) continue;
    if (chat.abandon(run.bot, run.requestId) && thread && !thread.archivedAt) turns.set(run.threadId, run.bot);
  }
  const resumed: string[] = [];
  for (const threadId of new Set([...turns.keys(), ...cut.keys()])) {
    const bot = turns.get(threadId) ?? cut.get(threadId)!.bot, names = cut.get(threadId)?.names ?? [];
    const text = resumeText([...(turns.has(threadId) ? [TURN_NAME] : []), ...names]);
    // The turn's message is the note itself; with no turn cut, the note is only logged.
    if (turns.has(threadId)) await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] } as Parameters<typeof bb.sdk.threads.send>[0]);
    else chat.note(bot, threadId, `restart:${now}:${names.join(",")}`, text);
    for (const name of names) await agents.goOn(bot, name, text);
    resumed.push(threadId);
  }
  return resumed;
}

/** Runs once the leases held before the restart have run out; never throws into BB's server. */
export function scheduleResume(bb: BbPluginApi, chat: Pick<OptChat, "runningTurns" | "abandon" | "note">, agents: Agents) {
  const start = Date.now(), until = Math.max(start, ...chat.runningTurns().map(run => Math.min(run.expires, start + LEASE_MS)));
  const timer = setTimeout(() => {
    resumeCut(bb, chat, agents).then(resumed => { if (resumed.length) bb.log.info(`Resumed ${resumed.length} conversation(s) a restart cut`); })
      .catch(error => bb.log.warn(`Resuming after a restart failed: ${error instanceof Error ? error.message : String(error)}`));
  }, until - start + 2000);
  timer.unref?.();
  return () => clearTimeout(timer);
}
