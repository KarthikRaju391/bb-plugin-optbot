// The view rules of UniiChat §3.2 and §4 (gist revision 2026-10-08).
export type Part = { start: number; count: number };
/** The chat's view: a sawtooth from 64 KB to 128 KB. */
export const VIEW_HIGH = 128_000, VIEW_LOW = 64_000;
/** The compactions' view: the chat's view merged further, a sawtooth from 16 KB to 32 KB. */
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

/**
 * A new message appends its line; nothing else changes the view. Once the view passes `high`, one batch
 * merges down to `low`; a batch that cannot get there yet (unbuilt parents) continues at each new message.
 */
export function appendLine(view: Part[], index: number, size: (part: Part) => number, built: (part: Part) => boolean, draining: boolean, high = VIEW_HIGH, low = VIEW_LOW) {
  view.push({ start: index, count: 1 });
  let used = view.reduce((sum, part) => sum + size(part), 0), merged = 0;
  if (draining || used > high) ({ used, merged } = shrink(view, index + 1, size, built, low, used));
  return { draining: (draining || merged > 0 || used > high) && used > low, merged };
}

/**
 * The compactions' view: merged down to 16 KB once, then the chat's new lines are appended; merged again
 * once it passes 32 KB, or when the chat's view merges.
 */
export function appendCompactionLine(cview: Part[] | null, view: readonly Part[], index: number, size: (part: Part) => number, built: (part: Part) => boolean, chatMerged: boolean) {
  if (!cview || chatMerged) {
    const fresh = view.map(part => ({ ...part }));
    shrink(fresh, index + 1, size, built, CVIEW_LOW);
    return fresh;
  }
  cview.push({ start: index, count: 1 });
  const used = cview.reduce((sum, part) => sum + size(part), 0);
  if (used > CVIEW_HIGH) shrink(cview, index + 1, size, built, CVIEW_LOW, used);
  return cview;
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
