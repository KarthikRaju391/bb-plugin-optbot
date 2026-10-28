import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
const model = z.string().regex(/^bb\/(?:codex(?:\/[^\s/]+)?|claude-code(?:\/[^\s/]+)?|pi(?:\/[^\s]+)?)$/);
const task = z.object({
  start: z.number().int().nonnegative(), count: z.number().int().positive(),
  source: z.string(), context: z.string(), children: z.array(z.string()).optional(),
}).strict();
/** Only the node/context cross the host boundary; login stays on the host. */
export const modelHostContract = defineRpcContract({
  compact: {
    input: z.object({ model, task, executable: z.string().regex(/^\/\S/).optional(), poolToken: z.string().min(16).optional(), rules: z.string().max(16_000).optional() }).strict(),
    output: z.string().min(1),
  },
  /** One CLI call for many nodes: their tasks (each with its context left out; the batch has one) and a line or null each. */
  compactBatch: {
    input: z.object({ model, items: z.array(z.object({ task: task.extend({ context: z.string().max(0) }), note: z.string().optional() }).strict()).min(1).max(64), context: z.string(), executable: z.string().regex(/^\/\S/).optional(), poolToken: z.string().min(16).optional(), rules: z.string().max(16_000).optional() }).strict(),
    output: z.object({ lines: z.array(z.string().nullable()), refused: z.boolean().optional() }).strict(),
  },
});
