export const CAP = 30_000;
export const MARKS = [50_000, 80_000, 100_000] as const;
export type TextBlock = { text: string; cache: boolean };
/** Constant mark positions, cut only at complete line endings, not arbitrary bytes. */
export function cacheBlocks(view: string): TextBlock[] {
  const blocks: TextBlock[] = []; let start=0;
  for (const mark of MARKS) {
    if(mark>=view.length) continue;
    const end=view.lastIndexOf("\n",mark)+1;
    if(end<=start) continue;
    blocks.push({text:view.slice(start,end),cache:true}); start=end;
  }
  if(start<view.length) blocks.push({text:view.slice(start),cache:false});
  return blocks;
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
