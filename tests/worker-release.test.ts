import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBbWorkers } from "../lib/bb-workers";

/**
 * A hidden worker thread's runtime (its claude process) as BB keeps it, per `bb guide thread-lifecycle` and a live
 * probe on archpad (2026-10-28: after archive the process stayed alive; after archive + stop it was gone): archiving
 * an idle thread keeps its runtime loaded for up to 30 idle minutes; `threads.stop` releases it, and succeeds when
 * none is loaded.
 */
function fakeBb() {
  const db = new Database(":memory:");
  const threads = new Map<string, { id: string; status: string; archivedAt: number | null; deletedAt: number | null; runtime: boolean }>();
  const calls: string[] = [];
  let n = 0;
  const bb = {
    storage: { database: () => db },
    log: { warn() {}, info() {} },
    events: { on() {} },
    onDispose() {},
    sdk: { threads: {
      async spawn() { const id = `thr_w${++n}`; threads.set(id, { id, status: "idle", archivedAt: null, deletedAt: null, runtime: true }); calls.push(`spawn ${id}`); return { id }; },
      async get({ threadId }: { threadId: string }) { return { ...threads.get(threadId)!, queuedMessageCount: 0, updatedAt: 0 }; },
      async archive({ threadId }: { threadId: string }) { calls.push(`archive ${threadId}`); threads.get(threadId)!.archivedAt = Date.now(); return {}; },
      async stop({ threadId }: { threadId: string }) { calls.push(`stop ${threadId}`); const t = threads.get(threadId)!; t.runtime = false; t.status = "idle"; return {}; },
    } },
  };
  return { bb: bb as unknown as BbPluginApi, threads, calls };
}

describe("a turn's hidden worker", () => {
  it("is archived and its runtime released when the turn ends, though it is already idle", async () => {
    const { bb, threads, calls } = fakeBb();
    const workers = createBbWorkers(bb);
    const key = workers.key();
    const { workerId } = await workers.start({ key, model: "bb/claude-code/claude-opus-5-5", prompt: "hi", instructions: "", permissionMode: "full", parent: "thr_conv", bot: "bot_a", environment: { type: "reuse", environmentId: "env_1" } as never, projectId: "proj_1", role: "master" });
    await workers.stop(workerId);
    const thread = threads.get(workerId)!;
    expect(thread.archivedAt).not.toBeNull();
    expect(thread.runtime).toBe(false);
    // Archive first, then stop (the guide's order for a finished hidden worker).
    expect(calls.filter(call => call.endsWith(workerId))).toEqual([`spawn ${workerId}`, `archive ${workerId}`, `stop ${workerId}`]);
  });
});
