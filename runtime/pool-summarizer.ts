import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Refusal, type ApiConversation, type ApiOptions } from "./models";

// Opt-in, unsupported by BB: Account Pooler serves only Codex and Claude Code threads, so OptBot reads its
// per-machine token from Account Pooler's data folder and calls its local proxy. The proxy picks and switches
// accounts per request. The token is read for each call (rotation keeps working) and never logged or stored.
export const POOL_CALL_TIMEOUT_MS = 90_000;
type Pool = "claude" | "codex";

/** pool/claude/<model> or pool/codex/<model>. */
export function poolRef(value: string): { pool: Pool; model: string } {
  const match = /^pool\/(claude|codex)\/(\S+)$/.exec(value);
  if (!match) throw new Error("Select pool/claude/<model> or pool/codex/<model>, e.g. pool/claude/claude-haiku-4-5.");
  return { pool: match[1] as Pool, model: match[2]! };
}

/** The proxy URL and the token of one enrolled machine (the compactor machine when set). */
export async function poolCredentials(dataDir: string, loopbackBaseUrl: string, hostId?: string) {
  const dir = join(dataDir, "plugins", "account-pool", "secrets", "accounts");
  let names: string[];
  try { names = (await readdir(dir)).filter(name => /^hub-token-[\w-]+\.json$/.test(name)).sort(); }
  catch { throw new Error("Account Pooler is not set up on this BB server (no machine tokens found)"); }
  const name = hostId && names.includes(`hub-token-${hostId}.json`) ? `hub-token-${hostId}.json` : names[0];
  if (!name) throw new Error("Account Pooler has no machine token yet; run a Codex or Claude Code thread once, or `bb pool token rotate`");
  const value = (JSON.parse(await readFile(join(dir, name), "utf8")) as { value?: unknown }).value;
  if (typeof value !== "string" || !value) throw new Error("Account Pooler's machine token file is unreadable");
  return { OPTBOT_POOL_URL: `${loopbackBaseUrl.replace(/\/$/, "")}/api/v1/plugins/account-pool/http/v1`, OPTBOT_POOL_TOKEN: value };
}

// A short reason from the proxy's error body, without anything that looks like a credential or an address.
function reason(body: string) {
  let text = body;
  try { const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } | unknown; message?: unknown }; text = String((parsed.error as { message?: unknown })?.message ?? parsed.detail ?? parsed.message ?? parsed.error ?? ""); } catch { /* plain text */ }
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").replace(/\s+/g, " ").trim().slice(0, 200);
  return text ? `: ${text}` : "";
}

/** A tool-less summarizer through Account Pooler. Size feedback continues the same dialogue. */
export function poolConversation(blocks: { text: string }[], options: ApiOptions, network: typeof fetch = (...args) => fetch(...args)): ApiConversation {
  const { pool, model } = poolRef(options.model);
  const url = options.env.OPTBOT_POOL_URL, token = options.env.OPTBOT_POOL_TOKEN;
  if (!url || !token) throw new Error("Turn on OptBot's compactorAccountPooler setting to summarize through Account Pooler");
  const prompt = blocks.map(block => block.text).join("\n\n");
  const history: { role: "user" | "assistant"; text: string }[] = [{ role: "user", text: prompt }];
  async function send() {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(POOL_CALL_TIMEOUT_MS)]);
    const body = pool === "claude"
      ? { model, max_tokens: 2_048, system: options.system, messages: history.map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] })) }
      // The Codex backend only streams and takes the system prompt as instructions.
      : { model, instructions: options.system, stream: true, store: false, reasoning: { effort: "medium" },
          input: history.map(m => m.role === "user" ? { role: "user", content: [{ type: "input_text", text: m.text }] } : { role: "assistant", content: [{ type: "output_text", text: m.text }] }) };
    let response: Response;
    try {
      response = await network(`${url}/${pool === "claude" ? "messages" : "responses"}`, { method: "POST", signal, body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-bb-account-pool-token": token!, ...(pool === "claude" ? { "anthropic-version": "2023-06-01" } : {}) } });
    } catch (error) {
      if (options.signal.aborted) throw new Error("Summary cancelled");
      if (signal.aborted) throw new Error(`${options.model} summary timed out after ${POOL_CALL_TIMEOUT_MS / 1000} s in Account Pooler`);
      throw new Error(`Could not reach Account Pooler: ${error instanceof Error ? error.message : String(error)}`);
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`${options.model} summary failed in Account Pooler (HTTP ${response.status})${reason(raw)}${response.status === 401 ? "; its machine token may have rotated, the next try rereads it" : ""}`);
    if (pool === "claude") {
      const parsed = JSON.parse(raw) as { content?: { type?: string; text?: string }[]; stop_reason?: string };
      if (parsed.stop_reason === "refusal") throw new Refusal(`${options.model} declined to summarize`);
      if (parsed.stop_reason !== "end_turn" && parsed.stop_reason !== "stop_sequence") throw new Error(`${options.model} summary stopped with ${parsed.stop_reason ?? "no completion status"}`);
      return (parsed.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("").trim();
    }
    // Server-sent events: the final response.completed event carries the whole output.
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:") || !line.includes("\"response.completed\"")) continue;
      const done = JSON.parse(line.slice(5)) as { response?: { output?: { type?: string; content?: { type?: string; text?: string }[] }[] } };
      return (done.response?.output ?? []).filter(item => item.type === "message").flatMap(item => item.content ?? []).filter(part => part.type === "output_text").map(part => part.text ?? "").join("").trim();
    }
    throw new Error(`${options.model} summary ended without a completed response`);
  }
  return {
    addUser() { throw new Error("Use ask(message) for summarizer feedback"); },
    addResult() { throw new Error("Summarizer tools are disabled"); },
    async ask(feedback) {
      options.signal.throwIfAborted();
      if (feedback) history.push({ role: "user", text: feedback });
      const text = await send();
      history.push({ role: "assistant", text });
      return { text, thoughts: [], calls: [] };
    },
  };
}
