import { z } from "zod";

// BB's built-in side chat replies to a message in a hidden fork of the thread (plugin "side-chat"). OptBot leaves those
// forks to BB: they are never bound to a bot, so a fork of a normal thread keeps its own provider and never sees bot
// tools. A side chat of an OptBot conversation (BB keeps the source's provider) runs as a side session: native BB
// execution on the conversation's model, with the conversation's recent messages as context, and nothing read from or
// written to the bot's memory. Any other fork of a bot conversation (BB's Fork action) is another conversation of the
// same bot, with its memory.
export const SIDE_CHAT_PLUGIN = "side-chat";
type Forkable = { originKind?: string | null; originPluginId?: string | null };
export function isSideChat(thread: Forkable) {
  return thread.originKind === "fork" && thread.originPluginId === SIDE_CHAT_PLUGIN;
}

export const sideInput = z.object({ action: z.literal("context") }).strict();
export const SIDE_TOOL_DESCRIPTION = "Private OptBot side-chat protocol: the main conversation's recent messages. Never an agent-facing tool.";
/** How much a side-chat turn sees, newest first: the side chat's own history takes up to SIDE_HISTORY_CHARS of the
 * SIDE_CONTEXT_CHARS budget, the main conversation the rest. */
export const SIDE_CONTEXT_CHARS = 60_000;
export const SIDE_HISTORY_CHARS = 30_000;
const NOTICE_CHARS = 2_000;

type Row = { kind: string; role?: string; text?: string | null; createdAt?: number; initiator?: string | null; threadId?: string };
function messages(rows: readonly Row[]) {
  return rows.filter((row) => row.kind === "conversation" && (row.role === "user" || row.role === "assistant") && row.text?.trim())
    .map((row) => row.role === "assistant" ? `Assistant: ${row.text!.trim()}`
      : row.initiator === "system" ? `Notice: ${row.text!.trim().slice(0, NOTICE_CHARS)}` : `User: ${row.text!.trim()}`);
}
/** The newest messages that fit in `budget` characters, oldest first; a single longer one keeps its label and its end. */
function newest(lines: readonly string[], budget: number) {
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let text = lines[i]!;
    if (kept.length && size + text.length > budget) break;
    if (text.length > budget) { const label = text.slice(0, text.indexOf(": ") + 2); text = `${label}…${text.slice(-(budget - label.length - 1))}`; }
    kept.unshift(text);
    size += text.length;
  }
  return kept;
}
/**
 * The prompt context for one side-chat turn, from BB's own timelines: the main conversation's messages up to when the
 * side chat was created (as many of the newest as fit in SIDE_CONTEXT_CHARS), then the side chat's earlier exchanges.
 * The message this turn answers is sent separately, so the side chat's trailing user messages are left out here.
 */
export function sideContext(source: readonly Row[], forkCreatedAt: number, side: readonly Row[]) {
  const earlier = side.filter((row) => row.kind === "conversation" && (row.role === "user" || row.role === "assistant"));
  while (earlier.length && earlier.at(-1)!.role === "user") earlier.pop();
  const history = newest(messages(earlier), SIDE_HISTORY_CHARS);
  const main = messages(source.filter((row) => (row.createdAt ?? 0) <= forkCreatedAt));
  const kept = newest(main, SIDE_CONTEXT_CHARS - history.reduce((sum, text) => sum + text.length, 0));
  return [
    "This is a side chat branching off a conversation. Answer the user's side question directly; the main conversation goes on without you.",
    kept.length ? `The main conversation's most recent messages${kept.length < main.length ? ` (the last ${kept.length} of ${main.length})` : ""}, oldest first:\n\n${kept.join("\n\n")}` : "The main conversation has no messages yet.",
    ...(history.length ? [`The side chat so far:\n\n${history.join("\n\n")}`] : []),
  ].join("\n\n---\n\n");
}
