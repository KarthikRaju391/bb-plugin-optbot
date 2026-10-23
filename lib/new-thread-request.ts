import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

// Validate the public composer request at the RPC boundary. Keep provenance,
// mentions and attachments intact; the SDK owns execution/environment policy.
// Like BB's own promptInputSchema, never reject a field BB adds later: unknown
// keys pass through to threads.spawn, which validates the request itself, and
// a block without mentions gets none. Where the thread runs (environment) stays
// strict: an unknown field there is refused, not passed on.
const id = z.string().min(1);
const resource = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("thread"), label: z.string(), threadId: id, projectId: id.optional() }),
  z.looseObject({ kind: z.literal("project"), label: z.string(), projectId: id }),
  z.looseObject({ kind: z.literal("section"), label: z.string(), sectionId: id }),
  z.looseObject({ kind: z.literal("path"), label: z.string(), path: z.string(), entryKind: z.enum(["file", "directory"]), source: z.enum(["workspace", "thread-storage"]) }),
  z.looseObject({ kind: z.literal("command"), label: z.string(), name: z.string(), argumentHint: z.string().nullable(), origin: z.enum(["builtin", "project", "user"]), source: z.enum(["command", "skill"]), trigger: z.literal("/") }),
  z.looseObject({ kind: z.literal("plugin"), label: z.string(), pluginId: id, itemId: id, icon: z.string().nullable().optional() }),
]);
const visibility = z.literal("agent-only").optional();
const input = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("text"), text: z.string(), mentions: z.array(z.looseObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), resource })).default([]), visibility }),
  z.looseObject({ type: z.literal("image"), url: z.string(), visibility }),
  z.looseObject({ type: z.literal("localImage"), path: z.string(), visibility }),
  z.looseObject({ type: z.literal("localFile"), path: z.string(), mimeType: z.string().optional(), name: z.string().optional(), sizeBytes: z.number().nonnegative().optional(), visibility }),
]);
const environment = z.discriminatedUnion("type", [
  // The current native composer uses environment providers, including
  // personal-workspace for projectless conversations (SDK 0.5.29).
  z.strictObject({
    type: z.literal("provider"), environmentProviderId: id,
    inputs: z.json().nullable().default(null),
    machine: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("existing"), hostId: id }),
      z.strictObject({ type: z.literal("new"), machineProviderId: id, inputs: z.json().nullable().default(null) }),
    ]).optional(),
  }),
  z.strictObject({ type: z.literal("reuse"), environmentId: id }),
  z.strictObject({ type: z.literal("project-default") }),
  z.strictObject({
    type: z.literal("host"), hostId: id.optional(),
    workspace: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("personal") }),
      z.strictObject({ type: z.literal("unmanaged"), path: z.string().nullable(), branch: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("existing"), name: id }),
        z.strictObject({ kind: z.literal("new"), baseBranch: id }),
      ]).optional() }),
      z.strictObject({ type: z.literal("managed-worktree"), baseBranch: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("default") }),
        z.strictObject({ kind: z.literal("named"), name: id }),
      ]) }),
    ]),
  }),
]);
const source = z.enum(["explicit", "client-preference"]).optional();
export const newThreadRequestSchema: z.ZodType<NewThreadRequest> = z.looseObject({
  projectId: id, providerId: id, model: z.string(),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  serviceTier: z.enum(["default", "fast"]).optional(),
  executionInputSources: z.looseObject({ providerId: source, model: source, reasoningLevel: source, permissionMode: source, serviceTier: source }),
  environment, input: z.array(input).min(1), sendAt: z.number().int().nonnegative().optional(),
});
