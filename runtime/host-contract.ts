import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
/** Only the node/context cross the host boundary; login stays on the host. */
export const modelHostContract = defineRpcContract({
  compact: {
    input: z.object({ model: z.string().regex(/^bb\/codex(?:\/[^\s/]+)?$/), task: z.object({
      start: z.number().int().nonnegative(), count: z.number().int().positive(),
      source: z.string(), context: z.string(), children: z.array(z.string()).optional(),
    }).strict() }).strict(),
    output: z.string().min(1),
  },
});
