import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createAgents, SPAWN_DESCRIPTION, SUB_PROMPT, SUB_TASK_PROMPT } from "../lib/agents";
import { backend, project } from "./backend-fixture";

// Thread shapes: the fields lib/agents.ts reads from bb.sdk.threads.get/spawn (providerId, projectId, environmentId, id).
const VIEW = "<chat>\n0+1|user: Whatfix CEO emails, Vara calendar, Sonicu reruns\n</chat>\n";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function host() {
  const spawned: { prompt: string; pluginMetadata: Record<string, unknown> }[] = [];
  const fake = createFakePluginHost({ pluginId: "optbot", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, providerId: "codex", projectId: "personal", environmentId: "env_1", status: "idle" }),
    spawn: async (request: { prompt: string; pluginMetadata: Record<string, unknown> }) => { spawned.push(request); return { id: `thr_child${spawned.length}` }; },
  } } as never });
  cleanups.push(() => fake.harness.lifecycle.dispose());
  const agents = createAgents(fake.bb, { view: () => VIEW, worker: () => ({ bot: "bot_1", parent: "thr_main", model: null, reasoning: null }), nativeEvents: () => [] });
  return { agents, spawned };
}

it("starts a subagent on its task alone by default, told how to zoom the messages it points to", async () => {
  const { agents, spawned } = host();
  await agents.spawn("thr_worker", { tasks: [{ title: "Trackpad app", task: "Build the trackpad prototype; the spec is message 16437." }] });
  expect(spawned[0]!.prompt).toBe(`${SUB_TASK_PROMPT}\n\n0|note: subagent\n\n1|user: Build the trackpad prototype; the spec is message 16437.`);
  expect(spawned[0]!.prompt).not.toContain("Whatfix");
  expect(SUB_TASK_PROMPT).toContain(`optbot_memory({action: "zoom", start: id, count: 1})`);
  expect(SPAWN_DESCRIPTION).toContain("by id");
  expect(spawned[0]!.pluginMetadata).toEqual({ optbotAgent: "subagent", optbotContext: "task" });
});

it("gives the view only when asked", async () => {
  const { spawned, agents } = host();
  await agents.spawn("thr_worker", { tasks: ["Delete Vara's rows"], context: "view" });
  expect(spawned[0]!.prompt).toBe(`${SUB_PROMPT}\n\n${VIEW}\n\n0|note: subagent\n\n1|user: Delete Vara's rows`);
  expect(spawned[0]!.pluginMetadata).toEqual({ optbotAgent: "subagent", optbotContext: "view" });
});

it("keeps the memory tool for a subagent started on its task alone", async () => {
  const fake = await backend([project()]);
  cleanups.push(() => fake.harness.lifecycle.dispose());
  for (const optbotContext of ["task", "view"]) {
    const config = await fake.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: "codex" }, thread: { id: `thr_${optbotContext}` }, project: { id: "project" }, pluginMetadata: { optbotAgent: "subagent", optbotContext } }));
    expect(config.tools.map(tool => tool.name)).toEqual(["optbot_memory"]);
  }
});
