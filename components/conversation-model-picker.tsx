import { useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { ModelSelection, rpcContract } from "../contract";

/** BB's own provider/model picker for an OptBot conversation; the next turn uses the choice. */
export function ConversationModelPicker({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ environmentId: string | null; value: ModelSelection } | null>(null);
  const [owned, setOwned] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setState(null); setOwned(true);
    const load = () => rpc.call("conversation_model_get", { threadId }).then(result => {
      if (cancelled) return;
      setOwned(result.owned);
      if (!result.owned || result.value) clearInterval(timer);
      if (result.value) setState({ environmentId: result.environmentId, value: result.value });
    }, () => {});
    // A new conversation has no model recorded until its first turn starts.
    const timer = setInterval(() => { if (!cancelled) void load(); }, 10_000);
    void load();
    return () => { cancelled = true; clearInterval(timer); };
  }, [rpc, threadId]);
  if (!owned || !state) return null;
  async function choose(value: ModelSelection) {
    const previous = state;
    setState(current => current && { ...current, value });
    try { await rpc.call("conversation_model_set", { threadId, value }); }
    catch (cause) { setState(previous); toast.error(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <ProviderModelPicker value={state.value} onChange={next => void choose(next as ModelSelection)} align="end" {...(state.environmentId ? { routing: { kind: "environment" as const, environmentId: state.environmentId } } : {})} />;
}
