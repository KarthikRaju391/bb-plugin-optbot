// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { z } from "zod";
import { rpcContract, type BotMetadata } from "../contract";
import { bot, personalProjectId, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const hash = "a".repeat(64);
const hashes = { "SOUL.md": hash, "AGENTS.md": hash, "MEMORY.md": hash, "settings.json": hash };
type Update = z.infer<typeof rpcContract.bot_update.input>;
async function mount({ update, prepareFailures = 0, expectFailure = false }: { update?: (input: Update) => BotMetadata | Promise<BotMetadata>; prepareFailures?: number; expectFailure?: boolean } = {}) {
  let current: BotMetadata = { ...bot, id: "remote-bot", name: "Remote bot", hostId: "remote", stateReady: false, soul: "Stale cached identity" };
  const onNavigate = vi.fn();
  const slot = renderSlot(app.threadLists[0]!, { activeThreadId: "main", activeProjectId: "project", isCompactViewport: false, onNavigate, searchQuery: "", Original: () => null }, {
    sidebarThreads: { projects: [{ id: "project", name: "Unrelated checkout", isPersonal: false }], threads: [thread("main", 100)] },
    rpc: {
      bots_list: () => ({ bots: [{ ...current }], hosts: [], sections: [], projects: [], warnings: [], personalProjectId, threadBindings: [{ botId: current.id, threadId: "main" }] }),
      bot_prepare: () => {
        if (prepareFailures-- > 0) throw new Error("Private state unavailable");
        if (!current.stateReady) current = { ...current, stateReady: true, soul: "Fresh private identity", agents: "Private instructions", memory: "- A private fact.\n", settings: { style: "concise" }, updatedAt: 10, stateHashes: hashes };
        return current;
      },
      bot_update: async (raw) => {
        const input = rpcContract.bot_update.input.parse(raw);
        if (update) return await update(input);
        current = { ...current, name: input.name, role: input.role, avatar: input.avatar, soul: input.soul, memory: input.memory ?? current.memory, settings: input.settings ?? current.settings, updatedAt: 11 };
        return current;
      },
    },
  });
  async function open() { fireEvent.contextMenu(await slot.findByText(current.name)); expect(slot.queryByRole("menuitem", { name: "View bot state…" })).toBeNull(); fireEvent.click(await slot.findByRole("menuitem", { name: "Edit bot…" })); }
  await open();
  const dialog = expectFailure ? null : await slot.findByRole("dialog", { name: "Edit bot" });
  return { slot, dialog: dialog!, onNavigate, open, getCurrent: () => current, changeCurrent: (patch: Partial<BotMetadata>) => { current = { ...current, ...patch }; } };
}
function soulBox(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("tab", { name: "Instructions" }));
  return within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "SOUL.md" });
}

it("edits identity in one Save with no MEMORY.md, settings.json or AGENTS controls", async () => {
  const { slot, dialog, onNavigate } = await mount();
  expect(within(dialog).getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Setup", "Instructions", "Memory", "Projects · 1", "Appearance"]);
  expect(soulBox(dialog).value).toBe("Fresh private identity");
  for (const tab of within(dialog).getAllByRole("tab")) {
    if (tab.textContent === "Memory") continue;
    fireEvent.click(tab);
    expect(within(dialog).queryByRole("textbox", { name: "MEMORY.md" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "settings.json" })).toBeNull();
    expect(within(dialog).queryByText(/MEMORY\.md|settings\.json|AGENTS\.md/)).toBeNull();
  }
  expect(within(dialog).queryByRole("button", { name: "Save file" })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Save bot" }).closest('[role="tabpanel"]')).toBeNull();
  expect(slot.inspection.rpcCalls.every(call => ["bots_list", "bot_prepare"].includes(call.method))).toBe(true);
  expect(onNavigate).not.toHaveBeenCalled(); expect(slot.inspection.navigateCalls).toEqual([]);
  expect(dialog.textContent).not.toMatch(/\/home\/|Home folder|Unrelated checkout/);
});

it("submits identity with original hashes and leaves stored memory and settings untouched", async () => {
  const { slot, dialog } = await mount();
  fireEvent.change(soulBox(dialog), { target: { value: "New soul\nSecond line" } });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Appearance" }));
  expect(soulBox(dialog).value).toBe("New soul\nSecond line");
  expect(slot.inspection.rpcCalls.some(call => call.method === "bot_update")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bot" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  const updates = slot.inspection.rpcCalls.filter(call => call.method === "bot_update");
  expect(updates).toEqual([{ method: "bot_update", input: expect.objectContaining({ botId: "remote-bot", soul: "New soul\nSecond line", settings: { style: "concise" }, expectedUpdatedAt: 10, expectedStateHashes: hashes }) }]);
  expect(updates[0]!.input).not.toHaveProperty("memory");
  expect(slot.inspection.rpcCalls.some(call => call.method === "state_update")).toBe(false);
});

it("keeps the identity draft on conflicts and realtime refresh", async () => {
  const { slot, dialog, changeCurrent } = await mount({ update: () => { throw new Error("SOUL.md changed while editing"); } });
  fireEvent.change(soulBox(dialog), { target: { value: "Keep my identity draft" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bot" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("SOUL.md changed");
  changeCurrent({ soul: "Changed elsewhere", updatedAt: 20 }); await slot.behavior.emitRealtime("project-bots-changed", {});
  expect(soulBox(dialog).value).toBe("Keep my identity draft");
  expect(slot.inspection.rpcCalls.filter(call => call.method === "bot_update")).toHaveLength(1);
});

it("does not expose stale cached state when preparation fails and allows reopening", async () => {
  const { slot, open } = await mount({ prepareFailures: 1, expectFailure: true });
  expect((await slot.findByRole("alert")).textContent).toContain("Private state unavailable"); expect(slot.queryByRole("dialog")).toBeNull();
  await open(); const dialog = await slot.findByRole("dialog", { name: "Edit bot" });
  expect(soulBox(dialog).value).toBe("Fresh private identity");
});

it("blocks duplicate writes and closing while a unified save is pending", async () => {
  let resolve!: (value: BotMetadata) => void; const response = new Promise<BotMetadata>(done => { resolve = done; });
  const { slot, dialog, getCurrent } = await mount({ update: () => response });
  fireEvent.change(soulBox(dialog), { target: { value: "Save once" } });
  const save = within(dialog).getByRole("button", { name: "Save bot" }); fireEvent.click(save); fireEvent.click(save);
  expect(slot.inspection.rpcCalls.filter(call => call.method === "bot_update")).toHaveLength(1);
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(slot.getByRole("dialog")).toBe(dialog);
  await act(async () => { resolve({ ...getCurrent(), soul: "Save once" }); });
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
});

it("saves unrelated edits without rewriting legacy oversized memory", async () => {
  const { slot, dialog, open, changeCurrent } = await mount();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  changeCurrent({ memory: "L".repeat(8000) });
  await open();
  const reopened = await slot.findByRole("dialog", { name: "Edit bot" });
  fireEvent.change(within(reopened).getByRole("textbox", { name: "Bot name" }), { target: { value: "Renamed safely" } });
  fireEvent.click(within(reopened).getByRole("button", { name: "Save bot" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  const saved = slot.inspection.rpcCalls.find(call => call.method === "bot_update")!.input;
  expect(saved).toMatchObject({ name: "Renamed safely" });
  expect(saved).not.toHaveProperty("memory");
});
