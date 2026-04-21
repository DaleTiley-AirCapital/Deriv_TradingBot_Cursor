import { useState } from "react";
import { cn } from "@/lib/utils";
import { Cpu, RefreshCw, XCircle, ArrowRight } from "lucide-react";
import { useGetOverview, getGetOverviewQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL || "/";

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}api/${path.replace(/^\//, "")}`, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const d = await res.json(); msg = d.error ?? d.message ?? msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const ACTIVE_SYMBOLS = ["CRASH300","BOOM300","R_75","R_100"];

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="font-mono break-all">{msg}</span>
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{k}</span>
      <span className={cn("text-xs text-foreground text-right break-all", mono && "font-mono")}>{v}</span>
    </div>
  );
}

export default function Diagnostics() {
  const [features, setFeatures] = useState<Record<string, any>>({});
  const [featLoading, setFeatLoading] = useState<Record<string, boolean>>({});
  const [featErr, setFeatErr] = useState<string | null>(null);

  const { data: rawData, isLoading, refetch } = useGetOverview({
    query: { queryKey: getGetOverviewQueryKey(), refetchInterval: 8000 },
  });
  const ov = rawData as any;

  const toggleKS = async (current: boolean) => {
    try {
      await fetch(`${BASE}api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kill_switch: current ? "false" : "true" }),
      });
      refetch();
    } catch {}
  };

  const loadFeatures = async (sym: string) => {
    setFeatLoading(f => ({ ...f, [sym]: true }));
    setFeatErr(null);
    try {
      const result = await apiFetch(`signals/features/${sym}`);
      setFeatures(prev => ({ ...prev, [sym]: result }));
    } catch (e: any) {
      setFeatErr((e as Error).message);
    } finally {
      setFeatLoading(f => ({ ...f, [sym]: false }));
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2 text-muted-foreground">
          <Cpu className="w-6 h-6" />
          Advanced Debug
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-muted/40 text-muted-foreground border-border/50 ml-1">
            DEV ONLY
          </span>
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Raw system debug access — kill switch · raw feature vectors
        </p>
      </div>

      {/* Redirect notice */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex items-start gap-3">
        <ArrowRight className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-foreground">Operational runtime content has moved to Data</p>
          <p className="text-xs text-muted-foreground mt-1">
            System Overview, Per-Mode Status, engine live state, and export are all in the{" "}
            <Link href="/data" className="text-primary underline underline-offset-2">Data page</Link>.
            This page contains raw debug tooling only.
          </p>
        </div>
      </div>

      {/* Kill Switch */}
      {ov && (
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Kill Switch</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Immediately halt all new signal processing and order placement</p>
            </div>
            <button onClick={() => toggleKS(ov.killSwitchActive)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-semibold transition-all",
                ov.killSwitchActive
                  ? "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25"
                  : "bg-muted/40 text-muted-foreground border-border/50 hover:bg-muted/60"
              )}>
              {ov.killSwitchActive ? "ACTIVE — click to disable" : "OFF — click to enable"}
            </button>
          </div>
        </div>
      )}

      {/* Raw feature vectors */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Raw Feature Vectors</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Raw computed features fed to the V3 coordinator on each scan cycle
            </p>
          </div>
          <button onClick={() => refetch()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
        {featErr && <ErrorBox msg={featErr} />}
        <div className="flex flex-wrap gap-2">
          {ACTIVE_SYMBOLS.map(sym => (
            <button key={sym} onClick={() => loadFeatures(sym)} disabled={featLoading[sym]}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium transition-all",
                features[sym]
                  ? "bg-primary/15 border-primary/30 text-primary"
                  : "bg-muted/40 border-border/50 text-foreground hover:bg-muted/70",
                featLoading[sym] && "opacity-60 cursor-not-allowed"
              )}>
              {featLoading[sym] ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
              {sym}
            </button>
          ))}
        </div>
        {Object.entries(features).map(([sym, f]) => (
          <div key={sym} className="rounded border border-border/40 p-3">
            <div className="text-xs font-semibold text-primary mb-2">{sym}</div>
            {(f as any).error ? <ErrorBox msg={(f as any).error} /> : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-0">
                {Object.entries(f as Record<string,any>)
                  .filter(([k]) => !["symbol","error"].includes(k))
                  .slice(0, 30)
                  .map(([k, v]) => (
                    <KV key={k} k={k} v={String(v ?? "—")} mono />
                  ))}
              </div>
            )}
          </div>
        ))}
        {!isLoading && Object.keys(features).length === 0 && (
          <p className="text-xs text-muted-foreground/60 text-center py-4">
            Click a symbol above to load its raw feature vector
          </p>
        )}
      </div>
    </div>
  );
}
