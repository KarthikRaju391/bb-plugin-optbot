import { afterEach, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { initializeParamsSchema, threadForkParamsSchema, threadResumeParamsSchema, turnStartParamsSchema, turnSteerParamsSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { createOptBotBridge } from "../host";
import { sideContext, SIDE_CONTEXT_CHARS, SIDE_HISTORY_CHARS } from "../lib/side-chat";
import { backend, PERSONAL_ID, request } from "./backend-fixture";

// BB's built-in side chat forks the thread (origin { kind: "fork", pluginId: "side-chat" }, hidden, same provider).
// Live failures on 2026-10-29/30: "Provider optbot does not support thread forks" for bot conversations, and
// "The optbot plugin's message.dispatch hook failed: did not decide within 10000ms" while OptBot tried to bind forks.
// BB's API is stubbed at the plugin boundary; timeline rows follow the shape of a live 0.48.0 /timeline response
// (top-level conversation rows; turn rows summarise the rest).
type Host = Awaited<ReturnType<typeof backend>>;
const instances: Host[] = [];
const bridges: { onClose?: () => void }[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) bridge.onClose?.(); await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose())); });
async function setup() { const host = await backend(); instances.push(host); return host; }
async function botConversation(host: Host) {
  const bot = await host.create();
  const { threadId } = await host.harness.behavior.callRpc("conversation_create", { botId: bot.id, request: request(PERSONAL_ID) }) as { threadId: string };
  return { bot, threadId };
}
function fork(host: Host, id: string, source: string, providerId: string, options: { createdAt?: number; pluginId?: string | null; visibility?: "hidden" | "visible" } = {}) {
  const thread = makeThreadResponse({ id, projectId: "project", environmentId: "env-1", providerId, sourceThreadId: source, originKind: "fork", originPluginId: options.pluginId === undefined ? "side-chat" : options.pluginId, visibility: options.visibility ?? "hidden", status: "pending", createdAt: options.createdAt ?? 2_000 });
  host.threads.set(id, thread);
  return thread;
}
// What BB does for a new fork: thread.created, then message.dispatch with the side chat's seeded first message.
async function create(host: Host, thread: ReturnType<typeof makeThreadResponse>) {
  await host.harness.behavior.emitThreadEvent("thread.created", { thread });
  await host.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread, input: { blocks: [{ type: "text", text: "Replying to this earlier message in the conversation:\n\nShip it?", mentions: [], visibility: "agent-only" }], text: "" } }));
}
const configure = (host: Host, threadId: string, provider: string, pluginId: string | null = "side-chat") => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: provider }, thread: { id: threadId }, project: { id: "project" }, origin: { kind: "fork", pluginId } }));
const reply = (text: string) => [{ seq: 1, type: "item/completed", data: { item: { type: "agentMessage", id: `w-${text.length}`, text } } }, { seq: 2, type: "turn/completed", data: { status: "completed" } }];

// The real provider bridge, its tool calls answered by the real plugin.
async function bridgeFor(host: Host, threadId: string, pluginId: string | null = "side-chat") {
  const messages: { id?: string; method?: string; params?: any; result?: any; error?: any }[] = [];
  const bridge = createOptBotBridge({ catalog: async () => ({ models: [], selectedOnlyModels: [] }), write: (line) => {
    const message = JSON.parse(line); messages.push(message);
    if (message.method !== "item/tool/call") return;
    void host.harness.behavior.callAgentTool(message.params.tool, message.params.arguments, { threadId: message.params.threadId, projectId: "project" })
      .then((text) => ({ success: true, contentItems: [{ type: "inputText", text }] }), (error) => ({ success: false, contentItems: [{ type: "inputText", text: String(error) }] }))
      .then((result) => bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })));
  } });
  bridges.push(bridge);
  const send = (id: string, method: string, params: unknown) => bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  send("init", "initialize", initializeParamsSchema.parse({ protocolVersion: 2, client: { name: "side chat test", version: "1" }, grammarVersions: [2, 3] }));
  const config = await configure(host, threadId, "optbot", pluginId);
  const options = (model = "bb/claude-code/claude-opus-5-5") => ({ model, envVars: {}, permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null, instructions: config.instructions ?? "" });
  const session = { threadId, cwd: tmpdir(), instructionMode: "append", options: options(), dynamicTools: config.tools.map(({ presentation, ...tool }) => presentation ? { ...tool, presentation } : tool) };
  const deltas = () => messages.flatMap((m) => m.method === "thread/delta" ? m.params.deltas : []);
  const tools = () => messages.filter((m) => m.method === "item/tool/call").map((m) => m.params.tool);
  const ended = () => expect.poll(() => deltas().some((d: any) => d.kind === "turn.boundary"), { timeout: 20_000 }).toBe(true);
  return { messages, send, deltas, tools, ended, options, session, config };
}

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
  await create(host, fork(host, "side-normal", "normal", "claude-code", { createdAt: Date.now() + 1_000 }));
  expect(host.store.owner("side-normal")).toBeNull();
  const config = await configure(host, "side-normal", "claude-code");
  expect(config.tools).toEqual([]);
  expect(config.instructions ?? null).toBeNull();
});

it("never binds a side chat of a bot conversation to the bot, gives it only the side-session tools, and refuses assignment", async () => {
  const host = await setup(); const { bot, threadId } = await botConversation(host);
  await create(host, fork(host, "side-bot", threadId, "optbot"));
  expect(host.store.owner("side-bot")).toBeNull();
  const config = await configure(host, "side-bot", "optbot");
  expect(config.tools.map((tool) => tool.name).sort()).toEqual(["optbot_side", "optbot_worker"]);
  expect(config.instructions ?? "").not.toContain("You are Atlas.");
  await expect(host.harness.behavior.callAgentTool("optbot_chat", { action: "view" }, { threadId: "side-bot", projectId: "project" })).rejects.toThrow();
  // Dragging the side chat onto the bot would leave a side session bound to the bot (every later turn failing).
  await expect(host.harness.behavior.callRpc("conversation_assign", { botId: bot.id, threadId: "side-bot" })).rejects.toThrow(/cannot be assigned/);
  expect(host.store.owner("side-bot")).toBeNull();
});

it("runs a bot side chat end to end on a native worker without reading or writing the bot's memory", async () => {
  const host = await setup(); const { threadId } = await botConversation(host);
  host.timelines.set(threadId, [
    { kind: "conversation", role: "user", threadId, createdAt: 1_000, initiator: "user", text: "Should we ship the recovery fix?" },
    { kind: "turn", threadId, createdAt: 1_100, children: null },
    { kind: "conversation", role: "assistant", threadId, createdAt: 1_200, text: "Ship it after the review passes." },
    { kind: "conversation", role: "user", threadId, createdAt: 9_000, initiator: "user", text: "A message sent after the side chat opened" },
  ]);
  await create(host, fork(host, "side-1", threadId, "optbot", { createdAt: 2_000 }));
  host.timelines.set("side-1", [
    { kind: "conversation", role: "user", threadId: "side-1", createdAt: 2_010, text: "Earlier side question" },
    { kind: "conversation", role: "assistant", threadId: "side-1", createdAt: 2_020, text: "Earlier side answer" },
    { kind: "conversation", role: "assistant", threadId: "elsewhere", createdAt: 2_050, text: "A row from another thread" },
    { kind: "conversation", role: "user", threadId: "side-1", createdAt: 2_100, text: "Why wait for the review?" },
  ]);
  const memoryBefore = host.bb.storage.database().prepare("SELECT count(*) AS n FROM optchat_log").get();
  const spawned: Record<string, unknown>[] = [];
  host.setOnSpawn((worker, args) => { spawned.push(args); host.events.set(worker.id, reply("Because the review checks ordering.")); host.outputs.set(worker.id, "Because the review checks ordering."); });
  const b = await bridgeFor(host, "side-1");
  expect(b.messages.find((m) => m.id === "init")?.result.capabilities.fork).toBe("tip");
  b.send("fork", "thread/fork", threadForkParamsSchema.parse({ ...b.session, sourceProviderThreadId: `optbot:${threadId}` }));
  const providerThreadId = b.messages.find((m) => m.id === "fork")?.result.providerThreadId;
  expect(providerThreadId).toBe("optbot-side:side-1");
  b.send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "side-1", providerThreadId, clientRequestId: "creq_sidechat22", input: [
    { type: "text", text: "Replying to this earlier message in the conversation:\n\nShip it after the review passes.", mentions: [], visibility: "agent-only" },
    { type: "text", text: "Why wait for the review?", mentions: [] },
  ], options: b.options() }));
  await b.ended();
  expect(b.deltas().find((d: any) => d.kind === "turn.boundary")).toMatchObject({ status: "completed" });
  expect(b.deltas().filter((d: any) => d.kind === "item.close" && d.item.type === "agentMessage").map((d: any) => d.item.text)).toEqual(["Because the review checks ordering."]);
  expect(new Set(b.tools())).toEqual(new Set(["optbot_side", "optbot_worker"]));
  expect(host.bb.storage.database().prepare("SELECT count(*) AS n FROM optchat_log").get()).toEqual(memoryBefore);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", title: "OptBot side chat", visibility: "hidden", lifecycleOwnerThreadId: "side-1" });
  const prompt = String(spawned[0]!.prompt);
  expect(prompt).toContain("User: Should we ship the recovery fix?");
  expect(prompt).toContain("Assistant: Ship it after the review passes.");
  expect(prompt).not.toContain("A message sent after the side chat opened");
  expect(prompt).toContain("Assistant: Earlier side answer");
  expect(prompt).not.toContain("A row from another thread");
  expect(prompt).toContain("Why wait for the review?");
  // OptBot's memory system prompt and worker note stay out: this is a plain native session.
  expect(prompt).not.toContain("optbot_memory");
  expect(prompt).not.toContain("optbot_spawn");
  expect(host.bb.storage.database().prepare("SELECT bot, role FROM optbot_workers").get()).toEqual({ bot: null, role: "side" });
  const workerConfig = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: "claude-code" }, thread: { id: "thread-1" }, project: { id: "project" }, pluginMetadata: { workerKey: (spawned[0]!.pluginMetadata as { workerKey: string }).workerKey } }));
  expect(workerConfig.tools).toEqual([]);
});

it("answers a message sent while a side-chat turn is finishing, instead of dropping it", async () => {
  const host = await setup(); const { threadId } = await botConversation(host);
  host.timelines.set(threadId, [{ kind: "conversation", role: "user", threadId, createdAt: 1_000, initiator: "user", text: "Plan the release." }]);
  await create(host, fork(host, "side-race", threadId, "optbot"));
  const spawned: Record<string, unknown>[] = [];
  host.setOnSpawn((worker, args) => { spawned.push(args); const text = spawned.length === 1 ? "Friday works." : "Noted: Monday instead."; host.events.set(worker.id, reply(text)); host.outputs.set(worker.id, text); });
  const b = await bridgeFor(host, "side-race");
  b.send("fork", "thread/fork", threadForkParamsSchema.parse({ ...b.session, sourceProviderThreadId: `optbot:${threadId}` }));
  const providerThreadId = b.messages.find((m) => m.id === "fork")?.result.providerThreadId;
  // The steer lands while the first worker is being archived: after the worker loop's last read of new messages.
  let steered = false;
  host.setOnArchive(async () => {
    if (steered) return;
    steered = true;
    const providerTurnId = b.deltas().find((d: any) => d.kind === "turn.open").providerTurnId;
    b.send("steer", "turn/steer", turnSteerParamsSchema.parse({ threadId: "side-race", providerThreadId, expectedTurnId: providerTurnId, clientRequestId: "creq_sidechat24", input: [{ type: "text", text: "Actually, Monday.", mentions: [] }], options: b.options() }));
    await expect.poll(() => b.messages.find((m) => m.id === "steer"), { timeout: 5_000 }).toBeTruthy();
  });
  b.send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "side-race", providerThreadId, clientRequestId: "creq_sidechat23", input: [{ type: "text", text: "Which day?", mentions: [] }], options: b.options() }));
  await b.ended();
  const steer = b.messages.find((m) => m.id === "steer")!;
  expect(steered).toBe(true);
  // Either the open turn took it and answered it, or it was refused so BB starts the next turn: never accepted and lost.
  if (steer.error) expect(steer.error.code).toBe(-32001);
  else {
    expect(spawned).toHaveLength(2);
    expect(String(spawned[1]!.prompt)).toContain("Actually, Monday.");
    expect(b.deltas().filter((d: any) => d.kind === "item.close" && d.item.type === "agentMessage").map((d: any) => d.item.text)).toEqual(["Friday works.", "Noted: Monday instead."]);
  }
  expect(b.tools()).not.toContain("optbot_chat");
}, 40_000);

it("delivers a message sent during a side-chat turn to its worker, and keeps the worker through a thread failure event", async () => {
  const host = await setup(); const { threadId } = await botConversation(host);
  host.timelines.set(threadId, [{ kind: "conversation", role: "user", threadId, createdAt: 1_000, initiator: "user", text: "Plan the release." }]);
  const side = fork(host, "side-2", threadId, "optbot");
  await create(host, side);
  let worker = "";
  host.setOnSpawn((spawned) => { worker = spawned.id; host.threads.set(spawned.id, { ...spawned, status: "active" }); });
  const b = await bridgeFor(host, "side-2");
  b.send("fork", "thread/fork", threadForkParamsSchema.parse({ ...b.session, sourceProviderThreadId: `optbot:${threadId}` }));
  const providerThreadId = b.messages.find((m) => m.id === "fork")?.result.providerThreadId;
  b.send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "side-2", providerThreadId, clientRequestId: "creq_sidechat23", input: [{ type: "text", text: "Which day?", mentions: [] }], options: b.options() }));
  await expect.poll(() => worker, { timeout: 10_000 }).not.toBe("");
  // BB marks a thread failed when one command fails, even while its turn runs on: the worker must survive it.
  await host.harness.behavior.emitThreadEvent("thread.failed", { thread: { ...side, status: "error" } });
  expect(host.bb.storage.database().prepare("SELECT status FROM optbot_workers WHERE worker=?").get(worker)).not.toEqual({ status: "stopped" });
  const providerTurnId = b.deltas().find((d: any) => d.kind === "turn.open").providerTurnId;
  b.send("steer", "turn/steer", turnSteerParamsSchema.parse({ threadId: "side-2", providerThreadId, expectedTurnId: providerTurnId, clientRequestId: "creq_sidechat24", input: [{ type: "text", text: "Prefer Friday.", mentions: [] }], options: b.options() }));
  await expect.poll(() => b.messages.find((m) => m.id === "steer"), { timeout: 5_000 }).toBeTruthy();
  expect(b.messages.find((m) => m.id === "steer")?.error).toBeUndefined();
  expect(b.deltas()).toContainEqual({ kind: "input.accepted", clientRequestId: "creq_sidechat24", providerTurnId });
  await expect.poll(() => host.sends.some((args) => JSON.stringify(args).includes("Prefer Friday.")), { timeout: 10_000 }).toBe(true);
  host.events.set(worker, reply("Friday then."));
  host.outputs.set(worker, "Friday then.");
  host.threads.set(worker, { ...host.threads.get(worker)!, status: "idle", queuedMessageCount: 0 });
  await b.ended();
  expect(b.deltas().find((d: any) => d.kind === "turn.boundary")).toMatchObject({ status: "completed" });
  expect(b.tools()).not.toContain("optbot_chat");
  expect(host.bb.storage.database().prepare("SELECT count(*) AS n FROM optchat_log").get()).toEqual({ n: 0 });
}, 40_000);

it("keeps a side chat memoryless after a restart resumes it", async () => {
  const host = await setup(); const { threadId } = await botConversation(host);
  host.timelines.set(threadId, [{ kind: "conversation", role: "user", threadId, createdAt: 1_000, initiator: "user", text: "Plan the release." }]);
  await create(host, fork(host, "side-3", threadId, "optbot"));
  host.setOnSpawn((worker) => { host.events.set(worker.id, reply("Still a side chat.")); host.outputs.set(worker.id, "Still a side chat."); });
  const b = await bridgeFor(host, "side-3");
  // A new bridge (after a restart) resumes the session BB recorded from the fork.
  b.send("resume", "thread/resume", threadResumeParamsSchema.parse({ ...b.session, providerThreadId: "optbot-side:side-3" }));
  b.send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "side-3", providerThreadId: "optbot-side:side-3", clientRequestId: "creq_sidechat25", input: [{ type: "text", text: "Still there?", mentions: [] }], options: b.options() }));
  await b.ended();
  expect(b.deltas().find((d: any) => d.kind === "turn.boundary")).toMatchObject({ status: "completed" });
  expect(new Set(b.tools())).toEqual(new Set(["optbot_side", "optbot_worker"]));
});

it("refuses a side-chat turn on a direct API model, without touching memory", async () => {
  const host = await setup(); const { threadId } = await botConversation(host);
  await create(host, fork(host, "side-4", threadId, "optbot"));
  const b = await bridgeFor(host, "side-4");
  b.send("fork", "thread/fork", threadForkParamsSchema.parse({ ...b.session, sourceProviderThreadId: `optbot:${threadId}` }));
  b.send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "side-4", providerThreadId: "optbot-side:side-4", clientRequestId: "creq_sidechat26", input: [{ type: "text", text: "Hi", mentions: [] }], options: b.options("sonnet") }));
  await b.ended();
  expect(b.deltas().find((d: any) => d.kind === "turn.boundary")).toMatchObject({ status: "failed", error: { message: expect.stringMatching(/native BB model/) } });
  expect(b.tools()).not.toContain("optbot_chat");
});

it("runs a fork from BB's Fork action as another conversation of the bot, with its memory", async () => {
  const host = await setup(); const { bot, threadId } = await botConversation(host);
  // BB's Fork action: a visible fork with no plugin origin.
  const branch = fork(host, "branch-1", threadId, "optbot", { pluginId: null, visibility: "visible", createdAt: Date.now() + 1_000 });
  await create(host, branch);
  expect(host.store.owner("branch-1")).toBe(bot.id);
  const config = await configure(host, "branch-1", "optbot", null);
  expect(config.instructions).toContain("You are Atlas.");
  expect(config.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["optbot_chat", "optbot_side"]));
  const spawned: Record<string, unknown>[] = [];
  host.setOnSpawn((worker, args) => { spawned.push(args); host.events.set(worker.id, reply("Branch answer.")); host.outputs.set(worker.id, "Branch answer."); });
  const b = await bridgeFor(host, "branch-1", null);
  b.send("fork", "thread/fork", threadForkParamsSchema.parse({ ...b.session, sourceProviderThreadId: `optbot:${threadId}` }));
  b.send("turn", "turn/start", turnStartParamsSchema.parse({ threadId: "branch-1", providerThreadId: "optbot-side:branch-1", clientRequestId: "creq_branch2222", input: [{ type: "text", text: "Continue here.", mentions: [] }], options: b.options() }));
  await b.ended();
  expect(b.deltas().find((d: any) => d.kind === "turn.boundary")).toMatchObject({ status: "completed" });
  // The bot's own path: memory calls and a bot worker, not a side worker.
  expect(b.tools()).toContain("optbot_chat");
  expect(spawned[0]).toMatchObject({ title: "OptBot execution" });
  expect(host.bb.storage.database().prepare("SELECT count(*) AS n FROM optchat_log WHERE thread_id='branch-1'").get()).not.toEqual({ n: 0 });
}, 40_000);

it("refuses side-chat context to a bot conversation", async () => {
  const host = await setup(); const { threadId } = await botConversation(host);
  await expect(host.harness.behavior.callAgentTool("optbot_side", { action: "context" }, { threadId, projectId: "project" })).rejects.toThrow(/Only an OptBot side chat/);
});

it("builds side-chat context within one budget, newest first, with labels and short notices", () => {
  const row = (role: string, text: string, initiator: string | null = role === "user" ? "user" : null) => ({ kind: "conversation", role, text, createdAt: 1, initiator, threadId: "t" });
  const main = [row("user", "first question"), row("assistant", "x".repeat(SIDE_CONTEXT_CHARS * 2))];
  const side = [...Array.from({ length: 40 }, (_, i) => row(i % 2 ? "assistant" : "user", `side ${i} ${"s".repeat(1_500)}`)), row("user", "the message being answered")];
  const text = sideContext(main, 10, side);
  expect(text.length).toBeLessThan(SIDE_CONTEXT_CHARS + 1_000);
  // The side chat's own history keeps to its share, newest first, and leaves out the message this turn answers.
  const history = text.slice(text.indexOf("The side chat so far"));
  expect(history).toContain("side 39");
  expect(history).not.toContain("side 0 ");
  expect(history.length).toBeLessThanOrEqual(SIDE_HISTORY_CHARS + 100);
  expect(text).not.toContain("the message being answered");
  // A message longer than what is left keeps its label and its end.
  expect(text).toContain("Assistant: …xxx");
  // A long notice is cut short and labelled.
  const notice = sideContext([row("user", `[bb system] ${"n".repeat(5_000)}`, "system")], 10, []);
  expect(notice).toContain("Notice: [bb system] nnn");
  expect(notice.length).toBeLessThan(2_500);
});
