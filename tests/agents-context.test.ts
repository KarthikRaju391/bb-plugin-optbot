import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createAgents, SUB_PROMPT, SUB_TASK_PROMPT } from "../lib/agents";

// Thread shapes: the fields lib/agents.ts reads from bb.sdk.threads.get/spawn (providerId, projectId, environmentId, id).
const VIEW = "<chat>\n0+1|user: Whatfix CEO emails, Vara calendar, Sonicu reruns\n</chat>\n";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function host(seed?: (db: ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]>) => void) {
  const spawned: { prompt: string; pluginMetadata: Record<string, unknown> }[] = [];
  const fake = createFakePluginHost({ pluginId: "optbot", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, providerId: "codex", projectId: "personal", environmentId: "env_1", status: "idle" }),
    spawn: async (request: { prompt: string; pluginMetadata: Record<string, unknown> }) => { spawned.push(request); return { id: `thr_child${spawned.length}` }; },
  } } as never });
  cleanups.push(() => fake.harness.lifecycle.dispose());
  seed?.(fake.bb.storage.database());
  const agents = createAgents(fake.bb, { view: () => VIEW, worker: () => ({ bot: "bot_1", parent: "thr_main", model: null, reasoning: null }), nativeEvents: () => [] });
  return { agents, spawned };
}

it("starts a subagent on its task alone by default: no view, no memory", async () => {
  const { agents, spawned } = host();
  await agents.spawn("thr_worker", { tasks: [{ title: "Trackpad app", task: "Build a trackpad drawing prototype." }] });
  expect(spawned[0]!.prompt).toBe(`${SUB_TASK_PROMPT}\n\n0|note: subagent\n\n1|user: Build a trackpad drawing prototype.`);
  expect(spawned[0]!.prompt).not.toContain("Whatfix");
  expect(spawned[0]!.pluginMetadata).toEqual({ optbotAgent: "subagent", optbotContext: "task" });
  expect(agents.taskOnly("thr_child1")).toBe(true);
});

it("gives the view only when asked", async () => {
  const { agents, spawned } = host();
  await agents.spawn("thr_worker", { tasks: ["Delete Vara's rows"], context: "view" });
  expect(spawned[0]!.prompt).toBe(`${SUB_PROMPT}\n\n${VIEW}\n\n0|note: subagent\n\n1|user: Delete Vara's rows`);
  expect(spawned[0]!.pluginMetadata).toEqual({ optbotAgent: "subagent", optbotContext: "view" });
  expect(agents.taskOnly("thr_child1")).toBe(false);
});

it("keeps agents spawned before contexts on the view", async () => {
  const { agents } = host(db => {
    db.exec("CREATE TABLE optbot_agents (bot TEXT NOT NULL, name TEXT NOT NULL, thread TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL, cursor TEXT, status TEXT NOT NULL, PRIMARY KEY(bot, name));");
    db.prepare("INSERT INTO optbot_agents VALUES (?,?,?,?,NULL,'idle')").run("bot_1", "thr_old", "thr_old", "thr_main");
  });
  expect(agents.isAgent("thr_old")).toBe(true);
  expect(agents.taskOnly("thr_old")).toBe(false);
});
