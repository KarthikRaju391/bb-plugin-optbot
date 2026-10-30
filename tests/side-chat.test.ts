import { afterEach, expect, it } from "vitest";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { initializeParamsSchema, threadForkParamsSchema, turnStartParamsSchema, turnSteerParamsSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { createOptBotBridge } from "../host";
import { tmpdir } from "node:os";
import { backend, PERSONAL_ID, request } from "./backend-fixture";

// BB's built-in side chat forks the thread (origin { kind: "fork", pluginId: "side-chat" }, hidden, same provider).
// Live failures on 2026-10-29/30: "Provider optbot does not support thread forks" for bot conversations, and
// "The optbot plugin's message.dispatch hook failed: did not decide within 10000ms" while OptBot tried to bind forks.
const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose())); });
async function setup() { const host = await backend(); instances.push(host); return host; }

function sideFork(host: Awaited<ReturnType<typeof backend>>, id: string, source: string, providerId: string, createdAt = 2_000) {
  const fork = makeThreadResponse({ id, projectId: "project", environmentId: "env-1", providerId, sourceThreadId: source, originKind: "fork", originPluginId: "side-chat", visibility: "hidden", status: "pending", createdAt });
  host.threads.set(id, fork);
  return fork;
}
// What BB does for a new fork: thread.created, then message.dispatch with the side chat's seeded first message.
async function create(host: Awaited<ReturnType<typeof backend>>, fork: ReturnType<typeof makeThreadResponse>) {
  await host.harness.behavior.emitThreadEvent("thread.created", { thread: fork });
  await host.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: fork, input: { blocks: [{ type: "text", text: "Replying to this earlier message in the conversation:\n\nShip it?", mentions: [], visibility: "agent-only" }], text: "" } }));
}
const configure = (host: Awaited<ReturnType<typeof backend>>, threadId: string, provider: string) => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: provider }, thread: { id: threadId }, project: { id: "project" }, origin: { kind: "fork", pluginId: "side-chat" } }));

it("declares fork support to BB, which refuses a side chat for a provider without it", async () => {
  const host = await setup();
  const provider = host.harness.inspection.registrations.providerRegistrations.find((entry) => entry.id === "optbot");
  // BB's thread-fork check reads the registered declaration (supportsFork = capabilities.fork !== "none").
  expect(provider?.capabilities.fork).toBe("tip");
});

it("leaves a side chat of a normal thread to BB, even in a project whose default bot claims new threads", async () => {
  const host = await setup();
  await host.harness.behavior.callRpc("bot_create", { name: "Owner", role: "Research", hostId: "host-home", avatar: { color: "#168b75", shape: "round", expression: "curious", motion: "still" }, sectionId: null, linkedProjectIds: ["project"], ownedProjectIds: ["project"], soul: "You are Owner." });
  host.threads.set("normal", makeThreadResponse({ id: "normal", projectId: "project", providerId: "claude-code" }));
  const fork = sideFork(host, "side-normal", "normal", "claude-code", Date.now() + 1_000);
  await create(host, fork);
  expect(host.store.owner("side-normal")).toBeNull();
  const config = await configure(host, "side-normal", "claude-code");
  expect(config.tools).toEqual([]);
  expect(config.instructions ?? null).toBeNull();
});

it("never binds a side chat of a bot conversation to the bot, and gives it only the side-session tools", async () => {
  const host = await setup(); const bot = await host.create();
  const { threadId } = await host.harness.behavior.callRpc("conversation_create", { botId: bot.id, request: request(PERSONAL_ID) }) as { threadId: string };
  const fork = sideFork(host, "side-bot", threadId, "optbot");
  await create(host, fork);
  expect(host.store.owner("side-bot")).toBeNull();
  const config = await configure(host, "side-bot", "optbot");
  expect(config.tools.map((tool) => tool.name).sort()).toEqual(["optbot_side", "optbot_worker"]);
  expect(config.instructions ?? "").not.toContain("You are Atlas.");
  await expect(host.harness.behavior.callAgentTool("optbot_chat", { action: "view" }, { threadId: "side-bot", projectId: "project" })).rejects.toThrow();
});

it("runs a bot side chat end to end on a native worker without reading or writing the bot's memory", async () => {
  const host = await setup(); const bot = await host.create();
  const { threadId } = await host.harness.behavior.callRpc("conversation_create", { botId: bot.id, request: request(PERSONAL_ID) }) as { threadId: string };
  // The main conversation as BB's timeline returns it (row shape from a live 0.48.0 /timeline response).
  host.timelines.set(threadId, [
    { kind: "conversation", role: "user", threadId, createdAt: 1_000, initiator: "user", text: "Should we ship the recovery fix?" },
    { kind: "turn", threadId, createdAt: 1_100, children: [] },
    { kind: "conversation", role: "assistant", threadId, createdAt: 1_200, text: "Ship it after the review passes." },
    { kind: "conversation", role: "user", threadId, createdAt: 9_000, initiator: "user", text: "A message sent after the side chat opened" },
  ]);
  const fork = sideFork(host, "side-1", threadId, "optbot", 2_000);
  await create(host, fork);
  // The side chat's own timeline holds this turn's message only.
  host.timelines.set("side-1", [{ kind: "conversation", role: "user", threadId: "side-1", createdAt: 2_100, text: "Why wait for the review?" }]);
  const memoryBefore = host.bb.storage.database().prepare("SELECT count(*) AS n FROM optchat_log").get();
  const spawned: Record<string, unknown>[] = [];
  host.setOnSpawn((worker, args) => {
    spawned.push(args);
    host.events.set(worker.id, [
      { seq: 1, type: "item/completed", data: { item: { type: "agentMessage", id: "w1", text: "Because the review checks ordering." } } },
      { seq: 2, type: "turn/completed", data: { status: "completed" } },
    ]);
    host.outputs.set(worker.id, "Because the review checks ordering.");
  });

  const messages: { id?: string; method?: string; params?: any; result?: any }[] = [];
  const bridge = createOptBotBridge({ catalog: async () => ({ models: [], selectedOnlyModels: [] }), write: (line) => {
    const message = JSON.parse(line); messages.push(message);
    if (message.method !== "item/tool/call") return;
    void host.harness.behavior.callAgentTool(message.params.tool, message.params.arguments, { threadId: message.params.threadId, projectId: "project" })
      .then((text) => ({ success: true, contentItems: [{ type: "inputText", text }] }), (error) => ({ success: false, contentItems: [{ type: "inputText", text: String(error) }] }))
      .then((result) => bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })));
  } });
  const send = (id: string, method: string, params: unknown) => bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  try {
    send("init", "initialize", initializeParamsSchema.parse({ protocolVersion: 2, client: { name: "side chat test", version: "1" }, grammarVersions: [2, 3] }));
    expect(messages.find((m) => m.id === "init")?.result.capabilities.fork).toBe("tip");
    const config = await configure(host, "side-1", "optbot");
    const options = { model: "bb/claude-code/claude-opus-5-5", envVars: {}, permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null, instructions: config.instructions ?? "" };
    send("fork", "thread/fork", threadForkParamsSchema.parse({ threadId: "side-1", cwd: tmpdir(), instructionMode: "append", options, dynamicTools: config.tools.map(({ presentation, ...tool }) => presentation ? { ...tool, presentation } : tool), sourceProviderThreadId: `optbot:${threadId}` }));
    const providerThreadId = messages.find((m) => m.id === "fork")?.result.providerThreadId;
    expect(providerThreadId).toBe("optbot-side:side-1");
    send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "side-1", providerThreadId, clientRequestId: "creq_sidechat22", input: [
      { type: "text", text: "Replying to this earlier message in the conversation:\n\nShip it after the review passes.", mentions: [], visibility: "agent-only" },
      { type: "text", text: "Why wait for the review?", mentions: [] },
    ], options }));
    await expect.poll(() => messages.some((m) => m.method === "thread/delta" && m.params.deltas.some((d: any) => d.kind === "turn.boundary")), { timeout: 15_000 }).toBe(true);
  } finally { bridge.onClose?.(); }

  const boundary = messages.flatMap((m) => m.method === "thread/delta" ? m.params.deltas : []).find((d: any) => d.kind === "turn.boundary");
  expect(boundary).toMatchObject({ status: "completed" });
  const replies = messages.flatMap((m) => m.method === "thread/delta" ? m.params.deltas : []).filter((d: any) => d.kind === "item.close" && d.item.type === "agentMessage").map((d: any) => d.item.text);
  expect(replies).toEqual(["Because the review checks ordering."]);
  // The side chat used BB's timelines and a native worker, never the bot's memory.
  const tools = messages.filter((m) => m.method === "item/tool/call").map((m) => m.params.tool);
  expect(new Set(tools)).toEqual(new Set(["optbot_side", "optbot_worker"]));
  expect(host.bb.storage.database().prepare("SELECT count(*) AS n FROM optchat_log").get()).toEqual(memoryBefore);
  // One worker: a side-chat worker on the conversation's model, owned by no bot, given the main conversation up to the fork.
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", title: "OptBot side chat", visibility: "hidden", lifecycleOwnerThreadId: "side-1" });
  const prompt = String(spawned[0]!.prompt);
  expect(prompt).toContain("User: Should we ship the recovery fix?");
  expect(prompt).toContain("Assistant: Ship it after the review passes.");
  expect(prompt).not.toContain("A message sent after the side chat opened");
  expect(prompt).toContain("Why wait for the review?");
  // OptBot's memory system prompt and worker note stay out: this is a plain native session.
  expect(prompt).not.toContain("optbot_memory");
  expect(prompt).not.toContain("optbot_spawn");
  const row = host.bb.storage.database().prepare("SELECT bot, role FROM optbot_workers").get();
  expect(row).toEqual({ bot: null, role: "side" });
  const workerConfig = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: "claude-code" }, thread: { id: "thread-1" }, project: { id: "project" }, pluginMetadata: { workerKey: (spawned[0]!.pluginMetadata as { workerKey: string }).workerKey } }));
  expect(workerConfig.tools).toEqual([]);
});

it("refuses side-chat context to a bot conversation", async () => {
  const host = await setup(); const bot = await host.create();
  const { threadId } = await host.harness.behavior.callRpc("conversation_create", { botId: bot.id, request: request(PERSONAL_ID) }) as { threadId: string };
  await expect(host.harness.behavior.callAgentTool("optbot_side", { action: "context" }, { threadId, projectId: "project" })).rejects.toThrow(/Only an OptBot side chat/);
});

it("delivers a message sent during a bot side-chat turn to its worker, not to the bot's memory", async () => {
  const host = await setup(); const bot = await host.create();
  const { threadId } = await host.harness.behavior.callRpc("conversation_create", { botId: bot.id, request: request(PERSONAL_ID) }) as { threadId: string };
  host.timelines.set(threadId, [{ kind: "conversation", role: "user", threadId, createdAt: 1_000, initiator: "user", text: "Plan the release." }]);
  await create(host, sideFork(host, "side-2", threadId, "optbot", 2_000));
  let worker = "";
  // The worker is still working when the steer arrives.
  host.setOnSpawn((spawned) => { worker = spawned.id; host.threads.set(spawned.id, { ...spawned, status: "active" }); });
  const messages: { id?: string; method?: string; params?: any; result?: any; error?: any }[] = [];
  const bridge = createOptBotBridge({ catalog: async () => ({ models: [], selectedOnlyModels: [] }), write: (line) => {
    const message = JSON.parse(line); messages.push(message);
    if (message.method !== "item/tool/call") return;
    void host.harness.behavior.callAgentTool(message.params.tool, message.params.arguments, { threadId: message.params.threadId, projectId: "project" })
      .then((text) => ({ success: true, contentItems: [{ type: "inputText", text }] }), (error) => ({ success: false, contentItems: [{ type: "inputText", text: String(error) }] }))
      .then((result) => bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })));
  } });
  const send = (id: string, method: string, params: unknown) => bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const deltas = () => messages.flatMap((m) => m.method === "thread/delta" ? m.params.deltas : []);
  try {
    send("init", "initialize", initializeParamsSchema.parse({ protocolVersion: 2, client: { name: "side chat test", version: "1" }, grammarVersions: [2, 3] }));
    const config = await configure(host, "side-2", "optbot");
    const options = { model: "bb/claude-code/claude-opus-5-5", envVars: {}, permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null, instructions: config.instructions ?? "" };
    send("fork", "thread/fork", threadForkParamsSchema.parse({ threadId: "side-2", cwd: tmpdir(), instructionMode: "append", options, dynamicTools: config.tools.map(({ presentation, ...tool }) => presentation ? { ...tool, presentation } : tool), sourceProviderThreadId: `optbot:${threadId}` }));
    const providerThreadId = messages.find((m) => m.id === "fork")?.result.providerThreadId;
    send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "side-2", providerThreadId, clientRequestId: "creq_sidechat23", input: [{ type: "text", text: "Which day?", mentions: [] }], options }));
    await expect.poll(() => worker, { timeout: 10_000 }).not.toBe("");
    const providerTurnId = deltas().find((d: any) => d.kind === "turn.open").providerTurnId;
    send("steer", "turn/steer", turnSteerParamsSchema.parse({ threadId: "side-2", providerThreadId, expectedTurnId: providerTurnId, clientRequestId: "creq_sidechat24", input: [{ type: "text", text: "Prefer Friday.", mentions: [] }], options }));
    await expect.poll(() => messages.find((m) => m.id === "steer"), { timeout: 5_000 }).toBeTruthy();
    expect(messages.find((m) => m.id === "steer")?.error).toBeUndefined();
    expect(deltas()).toContainEqual({ kind: "input.accepted", clientRequestId: "creq_sidechat24", providerTurnId });
    // The worker finishes once it has the steer: BB's feed reports its answer.
    await expect.poll(() => host.sends.some((args) => JSON.stringify(args).includes("Prefer Friday.")), { timeout: 10_000 }).toBe(true);
    host.events.set(worker, [{ seq: 1, type: "item/completed", data: { item: { type: "agentMessage", id: "w1", text: "Friday then." } } }, { seq: 2, type: "turn/completed", data: { status: "completed" } }]);
    host.outputs.set(worker, "Friday then.");
    host.threads.set(worker, { ...host.threads.get(worker)!, status: "idle", queuedMessageCount: 0 });
    await expect.poll(() => deltas().some((d: any) => d.kind === "turn.boundary"), { timeout: 20_000 }).toBe(true);
  } finally { bridge.onClose?.(); }
  expect(deltas().find((d: any) => d.kind === "turn.boundary")).toMatchObject({ status: "completed" });
  expect(messages.filter((m) => m.method === "item/tool/call").map((m) => m.params.tool)).not.toContain("optbot_chat");
  expect(host.bb.storage.database().prepare("SELECT count(*) AS n FROM optchat_log").get()).toEqual({ n: 0 });
}, 40_000);
