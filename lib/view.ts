// The view rules of UniiChat §3.2 and §4 (gist revision 2026-10-08).
export type Part = { start: number; count: number };
/** The chat's view: a sawtooth from 64 KB to 128 KB. */
export const VIEW_HIGH = 128_000, VIEW_LOW = 64_000;
/** The compactions' view (UniiChat `seen`): its own sawtooth from 16 KB to 32 KB, to the first message not built. */
export const CVIEW_HIGH = 32_000, CVIEW_LOW = 16_000;

/**
 * The most due pair of sibling lines whose parent is built, or -1. For siblings (l, i) and (l, i+1) with T
 * messages, due = (T - last) / 2^l, where last is the pair's last message; ties go to the oldest pair.
 */
export function mostDue(view: readonly Part[], total: number, built: (part: Part) => boolean) {
  let best = -1, due = -Infinity;
  for (let k = 0; k + 1 < view.length; k++) {
    const a = view[k]!, b = view[k + 1]!;
    if (a.count !== b.count || a.start % (2 * a.count) !== 0 || b.start !== a.start + a.count) continue;
    if (!built({ start: a.start, count: 2 * a.count })) continue;
    const value = (total - (a.start + 2 * a.count - 1)) / a.count;
    if (value > due) { best = k; due = value; }
  }
  return best;
}

/** Merge the most due pairs until the view is at most `low` bytes or nothing more can merge. */
export function shrink(view: Part[], total: number, size: (part: Part) => number, built: (part: Part) => boolean, low: number, used = view.reduce((sum, part) => sum + size(part), 0)) {
  let merged = 0;
  while (used > low) {
    const k = mostDue(view, total, built);
    if (k < 0) break;
    const a = view[k]!, b = view[k + 1]!, parent = { start: a.start, count: 2 * a.count };
    used += size(parent) - size(a) - size(b);
    view.splice(k, 2, parent);
    merged++;
  }
  return { used, merged };
}

/** A view and whether its batch is still going (UniiChat Memory.View: parts, batch). */
export type Box = { parts: Part[]; batch: boolean };

/** UniiChat Memory.reach: the view to message `end`; its lines from it dropped, the messages to it appended. */
export function reach(parts: Part[], end: number) {
  let keep = parts.length;
  while (keep > 0 && parts[keep - 1]!.start + parts[keep - 1]!.count > end) keep--;
  parts.length = keep;
  for (let i = keep ? parts[keep - 1]!.start + parts[keep - 1]!.count : 0; i < end; i++) parts.push({ start: i, count: 1 });
}

/**
 * UniiChat Memory.fit for one view, to message `end`: past `high` bytes a batch merges the most due pairs down to
 * half. Between messages it is kept only if it gets there (or as far as size - high); at a message (`next`) it
 * goes as far as it can, and goes on at later messages while the view is over half. Sizes count built lines only.
 */
export function fitBox(box: Box, end: number, high: number, size: (part: Part) => number, built: (part: Part) => boolean, next: boolean) {
  const before = JSON.stringify(box);
  reach(box.parts, end);
  let used = box.parts.reduce((sum, part) => sum + size(part), 0);
  if (used > high || (next && box.batch)) {
    const merged = box.parts.map(part => ({ ...part }));
    const result = shrink(merged, end, size, built, high / 2, used);
    if (next || result.used <= Math.max(high / 2, used - high)) { box.parts = merged; used = result.used; }
    box.batch = used > high / 2;
  }
  return JSON.stringify(box) !== before;
}

/** Whether parts tile [0, n) with aligned power-of-two lines (a saved view that can be kept). */
export function tiles(view: readonly Part[]) {
  let next = 0;
  for (const part of view) {
    if (part.start !== next || part.count < 1 || (part.count & (part.count - 1)) !== 0 || part.start % part.count !== 0) return -1;
    next += part.count;
  }
  return next;
}
