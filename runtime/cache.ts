import { createHash } from "node:crypto";
export const CAP = 30_000;
export type TextBlock = { text: string; cache: boolean };
/** Lines per cache block (UniiChat Memory.BLOCK). */
export const BLOCK = 4;
/**
 * UniiChat Memory.view's blocks: "<chat>\n", the view's lines in blocks of four, the rest with "</chat>\n". One mark,
 * on the last whole block (else the opening one): the next call finds it and pays only for the lines after it.
 */
export function cacheBlocks(view: string): TextBlock[] {
  if (!view.startsWith("<chat>\n") || !view.endsWith("</chat>\n")) return [{ text: view, cache: false }];
  const body = view.slice("<chat>\n".length, view.length - "</chat>\n".length), lines = body ? body.split(/(?<=\n)/) : [];
  const whole = Math.floor(lines.length / BLOCK), blocks: TextBlock[] = [{ text: "<chat>\n", cache: whole === 0 }];
  for (let k = 0; k < whole; k++) blocks.push({ text: lines.slice(k * BLOCK, (k + 1) * BLOCK).join(""), cache: k === whole - 1 });
  blocks.push({ text: lines.slice(whole * BLOCK).join("") + "</chat>\n", cache: false });
  return blocks;
}
/** Blocks as one text, for transports that take a string: no separators, a newline only where a block lacks one. */
export function joinBlocks(blocks: readonly { text: string }[]) {
  return blocks.reduce((text, block) => text + (text && !text.endsWith("\n") ? "\n" : "") + block.text, "");
}
/**
 * UniiChat AskAI.wait/lead: a call whose marked prefix another call is writing waits until that call's answer
 * starts, so only one pays to write it and the others read it. Keyed by the model, system prompt and the blocks up
 * to the last mark; a prefix with no mark never waits.
 */
const writing = new Map<string, Promise<void>>();
export async function singleFlight<T>(model: string, system: string, blocks: readonly TextBlock[], send: (begun: () => void) => Promise<T>): Promise<T> {
  const last = blocks.map(block => block.cache).lastIndexOf(true);
  if (last < 0) return send(() => {});
  const key = createHash("sha256").update(JSON.stringify([model, system, blocks.slice(0, last + 1).map(block => block.text)])).digest("hex");
  const leader = writing.get(key);
  if (leader) { await leader; return send(() => {}); }
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  writing.set(key, started);
  const begun = () => { begin(); if (writing.get(key) === started) writing.delete(key); };
  try { return await send(begun); } finally { begun(); }
}
export function capResult(text: string, cap=CAP) {
  const chars=Array.from(text);
  if(chars.length<=cap) return text;
  const mark=`\n[...middle omitted; original ${chars.length} characters; head and tail retained...]\n`;
  const keep=cap-Array.from(mark).length;
  if(keep<2) throw new Error("Tool result cap is too small");
  const head=Math.floor(keep/2), tail=keep-head;
  return chars.slice(0,head).join("")+mark+chars.slice(-tail).join("");
}
export function utf8Prefix(text: string, limit: number) {
  let result="",size=0;
  for(const char of text) { const n=Buffer.byteLength(char); if(size+n>limit) break; result+=char; size+=n; }
  return result;
}
