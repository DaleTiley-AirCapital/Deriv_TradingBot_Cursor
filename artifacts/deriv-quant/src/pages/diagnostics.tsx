import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  Shield, RefreshCw, XCircle, Cpu, Settings2,
} from "lucide-react";
import { useGetOverview } from "@workspace/api-client-react";

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

function Pill({ variant, label }: { variant: "ok"|"warn"|"error"|"info"|"default"; label: string }) {
  const cls = {
    ok:      "bg-green-500/15 text-green-400 border-green-500/25",
    warn:    "bg-amber-500/15 text-amber-400 border-amber-500/25",
    error:   "bg-red-500/15 text-red-400 border-red-500/25",
    info:    "bg-primary/15 text-primary border-primary/25",
    default: "bg-muted/40 text-muted-foreground border-border/50",
  }[variant];
  return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", cls)}>{label}</span>;
}

function Panel({ title, icon: Icon, badge, children }: {
  title: string; icon: React.ElementType; badge?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between gap-3 bg-muted/10">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {badge}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Runtime Debug Content ────────────────────────────────────────────────

function RuntimeContent() {
  const [err, setErr] = useState<string | null>(null);
  const [features, setFeatures] = useState<Record<string, any>>({});
  const [featLoading, setFeatLoading] = useState<Record<string, boolean>>({});

  const { data: rawData, isLoading, refetch } = useGetOverview({
    query: { refetchInterval: 5000 },
  });
  const data = rawData as any;

  useEffect(() => { if (isLoading === false && !rawData) setErr("Failed to load overview"); }, [isLoading, rawData]);

  const loadFeatures = async (sym: string) => {
    setFeatLoading(f => ({ ...f, [sym]: true }));
    try {
      const result = await apiFetch(`signals/features/${sym}`);
      setFeatures(prev => ({ ...prev, [sym]: result }));
    } catch (e: any) {
      setFeatures(prev => ({ ...prev, [sym]: { error: (e as Error).message } }));
    } finally {
      setFeatLoading(f => ({ ...f, [sym]: false }));
    }
  };

  const toggleKS = async (current: boolean) => {
    try {
      await fetch(`${BASE}api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "kill_switch", value: current ? "false" : "true" }),
      });
      refetch();
    } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      {err && <ErrorBox msg={err} />}

      {data && (
        <>
          <Panel title="System Overview" icon={Settings2}>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
              <KV k="Active Mode" v={<Pill variant={data.mode === "idle" ? "default" : "ok"} label={(data.mode?.toUpperCase() ?? "IDLE")} />} />
              <KV k="Tick Streaming" v={<Pill variant={data.streamingOnline ? "ok" : "warn"} label={data.streamingOnline ? "Online" : "Offline"} />} />
              <KV k="Scanner Running" v={<Pill variant={data.scannerRunning ? "ok" : "warn"} label={data.scannerRunning ? "Running" : "Stopped"} />} />
              <KV k="Kill Switch" v={
                <button onClick={() => toggleKS(data.killSwitchActive)}
                  className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold transition-all",
                    data.killSwitchActive
                      ? "bg-red-500/15 text-red-400 border-red-500/25 hover:bg-red-500/25"
                      : "bg-muted/40 text-muted-foreground border-border/50 hover:bg-muted/60")}>
                  {data.killSwitchActive ? "ACTIVE — click to disable" : "OFF — click to enable"}
                </button>
              } />
              <KV k="Last Scan Symbol" v={data.lastScanSymbol ?? "—"} mono />
              <KV k="Total Scans Run" v={(data.totalScansRun ?? 0).toLocaleString()} mono />
              <KV k="Total Decisions Logged" v={(data.totalDecisionsLogged ?? 0).toLocaleString()} mono />
              <KV k="Streaming Symbols" v={String(data.subscribedSymbolCount ?? "—")} mono />
            </div>
          </Panel>

          {data.perMode && (
            <Panel title="Per-Mode Status" icon={Shield}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {(["paper","demo","real"] as const).map(m => {
                  const pm = data.perMode?.[m] ?? {};
                  const isActive = (data.paperModeActive && m === "paper") || (data.demoModeActive && m === "demo") || (data.realModeActive && m === "real");
                  return (
                    <div key={m} className="space-y-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold uppercase">{m}</span>
                        <Pill variant={isActive ? "ok" : "default"} label={isActive ? "ACTIVE" : "OFF"} />
                      </div>
                      <KV k="Capital" v={(pm as any).capital ? `$${(pm as any).capital}` : "—"} mono />
                      <KV k="Min Score" v={String((pm as any).minScore ?? "—")} mono />
                      <KV k="Open Trades" v={String((pm as any).openTrades ?? "—")} mono />
                      <KV k="P&L" v={(pm as any).pnl != null ? `$${Number((pm as any).pnl).toFixed(2)}` : "—"} mono />
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
        </>
      )}

      <Panel title="V3 Engine Features — Live State" icon={Cpu}
        badge={<span className="text-[10px] text-muted-foreground">Active symbols only</span>}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground bg-muted/20 rounded p-3">
            Computed feature vectors that the V3 coordinator sees on each scan. Click a symbol to load its latest features.
          </p>
          <div className="flex flex-wrap gap-2">
            {ACTIVE_SYMBOLS.map(sym => (
              <button key={sym}
                onClick={() => loadFeatures(sym)}
                disabled={featLoading[sym]}
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
            <div key={sym} className="rounded border border-border/40 p-3 space-y-1.5">
              <div className="text-xs font-semibold text-primary mb-2">{sym}</div>
              {f.error ? <ErrorBox msg={f.error} /> : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-0">
                  {Object.entries(f).filter(([k]) => !["symbol","error"].includes(k)).slice(0, 24).map(([k, v]) => (
                    <KV key={k} k={k} v={String(v ?? "—")} mono />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────

export default function Diagnostics() {
  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Cpu className="w-6 h-6 text-muted-foreground" />
          Runtime Debug
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-muted/40 text-muted-foreground border-border/50 ml-1">
            ADVANCED
          </span>
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Live system state · kill switch · per-mode status · engine feature vectors
          <span className="ml-2 text-muted-foreground/50">— Data operations moved to Data console · AI research moved to Research</span>
        </p>
      </div>

      <RuntimeContent />
    </div>
  );
}
