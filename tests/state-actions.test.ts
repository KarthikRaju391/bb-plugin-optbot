import { afterEach, expect, it, vi } from "vitest";
import { backend, hash, PERSONAL_ID, project, request } from "./backend-fixture";
import { memoryFacts, mutateStateDocument } from "../lib/state-actions";
import { applyState, stateContent } from "../lib/private-state";
import type { BotStore } from "../lib/bot-store";
import type { BotStateFile } from "../contract";

const racing = vi.hoisted(() => ({ update: null as ((store: BotStore, id: string, file: BotStateFile) => void) | null }));
vi.mock("../lib/private-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/private-state")>();
  return { ...actual, createPrivateBotState: (...args: Parameters<typeof actual.createPrivateBotState>) => {
    const state = actual.createPrivateBotState(...args);
    return { ...state, update: (...input: Parameters<typeof state.update>) => {
      racing.update?.(args[1], input[0], input[1]);
      return state.update(...input);
    } };
  } };
});
function concurrentState(store: BotStore, id: string, file: BotStateFile, content: string) {
  store.mutate(id, (bot) => {
    const next = applyState(bot, file, content);
    return { ...next, stateHashes: { ...next.stateHashes, [file]: hash(stateContent(next, file)) }, updatedAt: bot.updatedAt + 1 };
  });
}

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { racing.update = null; await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose())); });
async function scope() {
  const host = await backend([project(), project("other")]); hosts.push(host);
  const bot = await host.create();
  const { threadId } = await host.harness.behavior.callRpc("conversation_create", { botId: bot.id, request: request() }) as { threadId: string };
  const ctx = { threadId, projectId: "project" };
  const read = async (target: string) => JSON.parse(await host.harness.behavior.callAgentTool("optbot_read_state", { target }, ctx) as string);
  const update = async (change: unknown) => JSON.parse(await host.harness.behavior.callAgentTool("optbot_update_state", change, ctx) as string);
  return { host, bot, read, update };
}

it("exposes object-root native schemas with target/action required", async () => {
  const { host } = await scope();
  const tools = host.harness.inspection.registrations.agentTools;
  expect(tools.map((tool) => tool.name)).toEqual(["optbot_chat", "optbot_memory", "optbot_worker", "optbot_side", "optbot_spawn", "optbot_tell", "optbot_read_state", "optbot_update_state"]);
  for (const tool of tools) expect((tool.inputSchema as { type: string }).type).toBe("object");
  expect((tools.find(tool => tool.name === "optbot_update_state")!.inputSchema as { required: string[] }).required).toEqual(expect.arrayContaining(["target", "action"]));
  expect((tools[0]!.inputSchema as { properties: object }).properties).not.toHaveProperty("file");
});

it("accepts provider-supplied nulls for unused fields without treating them as edits", async () => {
  const { update, read } = await scope();
  const unused = { expectedRevision: null, name: null, role: null, soul: null, content: null, expectedSha256: null, values: null, keys: null, projectId: null };
  await update({ ...unused, target: "settings", action: "set", fact: null, values: { nullablePreference: null } });
  expect((await read("settings")).state.values).toEqual({ nullablePreference: null });
});

it("preserves freeform notes and original line endings when forgetting facts", () => {
  const text = "# Memory\r\n\r\nA freeform note.\r\n- One fact.\r\n- One fact. More detail.\r\n";
  const next = mutateStateDocument(text, { target: "memory", action: "forget", fact: "One fact." });
  expect(next).toBe("# Memory\r\n\r\nA freeform note.\r\n- One fact. More detail.\r\n");
  expect(memoryFacts(next)).toEqual(["One fact. More detail."]);
});

it("sets/unsets only selected settings and preserves concurrent keys", async () => {
  const { host, bot, read, update } = await scope();
  await update({ target: "settings", action: "set", values: { style: "concise", timezone: "UTC", nested: { enabled: true } } });
  let raced = false;
  racing.update = (store, id, file) => {
    if (!raced && file === "settings.json") {
      raced = true;
      concurrentState(store, id, file, JSON.stringify({ style: "concise", timezone: "UTC", nested: { enabled: true }, concurrent: 42 }));
    }
  };
  const changed = await update({ target: "settings", action: "set", values: { style: "detailed", optional: null } });
  expect(changed.state.values).toEqual({ style: "detailed", timezone: "UTC", nested: { enabled: true }, concurrent: 42, optional: null });
  const removed = await update({ target: "settings", action: "unset", keys: ["style", "absent"] });
  expect(removed.state.values).toEqual({ timezone: "UTC", nested: { enabled: true }, concurrent: 42, optional: null });
  expect((await update({ target: "settings", action: "unset", keys: ["absent"] })).changed).toBe(false);
  expect((await read("settings")).state.values).toEqual(host.store.require(bot.id).settings);
});

it("requires a fresh revision for identity and never renames linked projects", async () => {
  const { host, bot, read, update } = await scope();
  const identity = await read("identity");
  const result = await update({ target: "identity", action: "set", expectedRevision: identity.revision, name: "Orion", soul: "A careful collaborator." });
  expect(result.state).toMatchObject({ name: "Orion", soul: "A careful collaborator.", role: "Research" });
  expect(host.store.require(bot.id).soul).toBe("A careful collaborator.");
  expect(host.harness.inspection.sdk.callsTo("projects.update")).toEqual([]);
  await expect(update({ target: "identity", action: "set", expectedRevision: identity.revision, role: "Stale edit" })).rejects.toThrow(/Identity changed/);
  const latest = await read("identity");
  expect((await update({ target: "identity", action: "set", expectedRevision: latest.revision, name: "Orion" })).changed).toBe(false);
});

it("joins/leaves projects without moving projects, files, or existing conversations", async () => {
  const { host, bot, read, update } = await scope();
  const initial = await read("project");
  expect(initial.state.available.map((project: { id: string }) => project.id)).toEqual(["project", "other"]);
  const joined = await update({ target: "project", action: "join", projectId: "other" });
  expect(joined.state.linked.map((project: { id: string }) => project.id)).toEqual(["project", "other"]);
  expect((await update({ target: "project", action: "join", projectId: "other" })).changed).toBe(false);
  const left = await update({ target: "project", action: "leave", projectId: "project" });
  expect(left.state.linked.map((project: { id: string }) => project.id)).toEqual(["other"]);
  expect((await update({ target: "project", action: "leave", projectId: "project" })).changed).toBe(false);
  expect(host.harness.inspection.sdk.callsTo("projects.create")).toHaveLength(0);
  expect(host.harness.inspection.sdk.callsTo("projects.update")).toEqual([]);
  expect((await read("identity")).botId).toBe(bot.id); // Existing conversation keeps its bot.
  await expect(update({ target: "project", action: "join", projectId: PERSONAL_ID })).rejects.toThrow(/existing work project/);
});

it("limits mutations to the current bot and rejects invalid target/action shapes", async () => {
  const { host, bot, update } = await scope(); const other = await host.create("Nova");
  for (const change of [
    { action: "append", fact: "x" },
    { target: "routine", action: "create" },
    { target: "memory", action: "set", fact: "x" },
    { target: "memory", action: "append", fact: "one\ntwo" },
    { target: "identity", action: "set", name: "No revision" },
    { target: "settings", action: "set", values: {} },
    { target: "settings", action: "set", values: JSON.parse('{"__proto__": {"polluted":true}}') },
    { target: "project", action: "join" },
    { target: "settings", action: "set", values: { a: 1 }, botId: other.id },
  ]) await expect(update(change)).rejects.toThrow();
  await update({ target: "settings", action: "set", values: { onlyAtlas: true } });
  expect(host.store.require(bot.id).settings).toMatchObject({ onlyAtlas: true });
  expect(host.store.require(other.id).settings).not.toHaveProperty("onlyAtlas");
});


it("retires pinned context for agents: the conversation history is the memory", async () => {
  const { host, read, update } = await scope();
  await expect(read("memory")).rejects.toThrow(/history is your memory/);
  await expect(update({ target: "memory", action: "append", fact: "Remember this." })).rejects.toThrow(/history is your memory/);
  for (const tool of host.harness.inspection.registrations.agentTools) expect(tool.description).not.toMatch(/pinned context/i);
});
