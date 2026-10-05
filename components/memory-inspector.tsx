import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { Button } from "./ui/button";

type Page = ReturnType<typeof rpcContract.memory_inspect.output.parse>;
type Node = ReturnType<typeof rpcContract.memory_node.output.parse>;
export function MemoryInspector({ botId }: { botId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [stream, setStream] = useState<"main" | "tree" | "view">("main");
  const [pageRequest, setPageRequest] = useState<{ offset: number; snapshotToken?: string }>({ offset: 0 });
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [start, setStart] = useState("0"), [count, setCount] = useState("2");
  const [node, setNode] = useState<Node | null>(null);
  const nodeSequence = useRef(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    void rpc.call("memory_inspect", { botId, stream, ...pageRequest }).then(result => {
      if (!cancelled) setPage(result);
    }, cause => { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rpc, botId, stream, pageRequest]);
  useEffect(() => () => { nodeSequence.current++; }, [botId]);
  async function inspect() {
    const sequence = ++nodeSequence.current;
    setError(null);
    try {
      const result = await rpc.call("memory_node", { botId, start: Number(start), count: Number(count) });
      if (sequence === nodeSequence.current) setNode(result);
    } catch (cause) { if (sequence === nodeSequence.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className="flex min-h-0 flex-col gap-2 text-xs">
    <p>Read-only canonical history. Summaries never replace the original messages. Private content; do not share casually.</p>
    <div className="flex flex-wrap gap-1">{([['main', 'History JSONL'], ['tree', 'Summary tree JSONL'], ['view', 'Current memory view']] as const).map(([value, label]) => <Button key={value} type="button" size="sm" variant="ghost" aria-pressed={stream === value} onClick={() => { if (value === stream) return; setStream(value); setPageRequest({ offset: 0 }); setPage(null); }}>{label}</Button>)}<Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => { setPageRequest({ offset: 0 }); setPage(null); }}>Refresh memory</Button></div>
    {page ? <p>{page.messages} messages · {page.summaries} summaries · {page.settled ? 'settled' : 'merges pending'}</p> : null}
    {page?.snapshotReset ? <p role="status">Memory changed while paging. Returned to the first page; continue with the updated snapshot.</p> : null}
    {loading ? <p role="status">Loading memory…</p> : null}
    <textarea aria-label="Memory JSONL" readOnly value={page?.jsonl ?? ''} className="h-40 w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs" />
    {page ? <div className="flex items-center gap-2"><Button type="button" size="sm" variant="ghost" disabled={loading || page.offset === 0} onClick={() => setPageRequest({ offset: Math.max(0, page.offset - 16384), snapshotToken: page.snapshotToken })}>Previous page</Button><span>Characters {page.offset}–{Math.min(page.offset + page.jsonl.length, page.total)} / {page.total}</span><Button type="button" size="sm" variant="ghost" disabled={loading || page.nextOffset === null} onClick={() => setPageRequest({ offset: page.nextOffset!, snapshotToken: page.snapshotToken })}>Next page</Button></div> : null}
    <p>Tree records use l (level) and i (index): start = i × 2^l, count = 2^l. A merge joins the two adjacent half-spans. Pages can split a JSONL record; use Next page to inspect the remainder.</p>
    <div className="flex flex-wrap items-end gap-2"><label>Message start<input aria-label="Merge start" type="number" min="0" value={start} onChange={e => setStart(e.target.value)} className="block w-20 rounded border border-input bg-background p-1" /></label><label>Span count<input aria-label="Merge count" type="number" min="1" value={count} onChange={e => setCount(e.target.value)} className="block w-20 rounded border border-input bg-background p-1" /></label><Button type="button" size="sm" variant="ghost" onClick={() => void inspect()}>Inspect merge</Button></div>
    {node ? <div><p>Parent {node.start}+{node.count}</p><pre className="whitespace-pre-wrap break-words">{node.parent ?? 'Not summarized yet'}</pre>{node.parentTruncated ? <p>Parent preview truncated. Use Summary tree JSONL pagination for the full text.</p> : null}<p>{node.count === 1 ? 'Original message (bounded preview; History JSONL contains the full text)' : 'Source children'}</p><pre className="whitespace-pre-wrap break-words">{node.children}</pre>{node.childrenTruncated ? <p>Source children preview truncated. Use Summary tree JSONL or History JSONL pagination for the full text.</p> : null}</div> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>;
}
