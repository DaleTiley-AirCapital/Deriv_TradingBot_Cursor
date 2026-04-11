import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetDataStatus,
  useGetTicks,
  useGetCandles,
  useGetSpikeEvents,
  getGetDataStatusQueryKey,
} from "@workspace/api-client-react";
import { formatNumber, cn } from "@/lib/utils";
import {
  Database, Play, RefreshCw, Radio, RadioTower, Activity, Loader2,
  TrendingUp, Layers, CheckCircle, XCircle, AlertTriangle, Eye, EyeOff, Wrench,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";
function apiFetch<T = any>(path: string, opts?: RequestInit): Promise<T> {
  return fetch(`${BASE}api/${path.replace(/^\//, "")}`, opts).then(async r => {
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const d = await r.json(); msg = d.error ?? d.message ?? msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTIVE_SYMBOLS = ["CRASH300", "BOOM300", "R_75", "R_100"];

const ALL_28_SYMBOLS = [
  "CRASH300","BOOM300","R_75","R_100",
  "BOOM1000","CRASH1000","BOOM900","CRASH900","BOOM600","CRASH600",
  "BOOM500","CRASH500","R_10","R_25","R_50","RDBULL","RDBEAR",
  "JD10","JD25","JD50","JD75","JD100",
  "stpRNG","stpRNG2","stpRNG3","stpRNG5","RB100","RB200",
];

const SYMBOL_LABELS: Record<string, string> = {
  BOOM1000: "Boom 1000",  CRASH1000: "Crash 1000",
  BOOM900:  "Boom 900",   CRASH900:  "Crash 900",
  BOOM600:  "Boom 600",   CRASH600:  "Crash 600",
  BOOM500:  "Boom 500",   CRASH500:  "Crash 500",
  BOOM300:  "Boom 300",   CRASH300:  "Crash 300",
  R_75:     "Vol 75",     R_100:     "Vol 100",
  R_10:     "Vol 10",     R_25:      "Vol 25",     R_50: "Vol 50",
  RDBULL:   "RD Bull",    RDBEAR:    "RD Bear",
  JD10:     "Jump 10",    JD25:      "Jump 25",    JD50: "Jump 50",
  JD75:     "Jump 75",    JD100:     "Jump 100",
  stpRNG:   "Step",       stpRNG2:   "Step 2",     stpRNG3: "Step 3", stpRNG5: "Step 5",
  RB100:    "Range 100",  RB200:     "Range 200",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface SymbolDiagnostic {
  symbol: string;
  streaming: boolean;
  streamingState: string;
  apiSymbol: string | null;
  lastTick?: number | null;
}

interface DataStatusSymbol {
  symbol: string;
  tier: string;
  count1m: number;
  count5m: number;
  totalCandles: number;
  oldestDate: string | null;
  newestDate: string | null;
  lastBacktestDate: string | null;
  status: string;
}

interface ResearchDataStatus {
  symbols: DataStatusSymbol[];
  totalStorage: number;
  symbolCount: number;
}

type OpResult = { ok: boolean; msg: string; detail?: Record<string, string> } | null;
type ViewTab = "streaming" | "coverage" | "ops" | "topup" | "live";
type LiveSubtab = "ticks" | "candles" | "spikes";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAge(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useSymbolDiagnostics() {
  return useQuery<{ symbols: SymbolDiagnostic[] }>({
    queryKey: ["diagnostics-symbols"],
    queryFn: () => apiFetch("diagnostics/symbols"),
    refetchInterval: 6000,
    retry: 1,
  });
}

function useResearchDataStatus() {
  return useQuery<ResearchDataStatus>({
    queryKey: ["research/data-status"],
    queryFn: () => apiFetch("research/data-status"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

// ── Primitives ────────────────────────────────────────────────────────────────

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="font-mono break-all">{msg}</span>
    </div>
  );
}

function SuccessBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
      <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="break-all">{msg}</span>
    </div>
  );
}

function SymbolSelectFull({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50">
      {ALL_28_SYMBOLS.map(s => (
        <option key={s} value={s}>{s}{ACTIVE_SYMBOLS.includes(s) ? " ●" : ""}</option>
      ))}
    </select>
  );
}

// ── Stream State Chip ─────────────────────────────────────────────────────────

function StreamState({ state }: { state: string | undefined }) {
  const cfg: Record<string, { cls: string; label: string }> = {
    streaming: { cls: "bg-green-500/12 text-green-400 border-green-500/25",   label: "Streaming" },
    available: { cls: "bg-blue-500/12 text-blue-400 border-blue-500/25",      label: "Available" },
    idle:      { cls: "bg-muted/30 text-muted-foreground border-border/40",   label: "Idle"      },
    disabled:  { cls: "bg-red-500/12 text-red-400 border-red-500/25",         label: "Disabled"  },
    no_data:   { cls: "bg-muted/20 text-muted-foreground/40 border-border/20",label: "No data"   },
  };
  const s = cfg[state ?? "idle"] ?? cfg.idle;
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold border", s.cls)}>
      {state === "streaming" && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
      {s.label}
    </span>
  );
}

// ── Coverage Status Chip ──────────────────────────────────────────────────────

function CoverageStatus({ sym }: { sym: DataStatusSymbol }) {
  if (sym.status === "no_data" || sym.totalCandles === 0) {
    return <span className="text-[10px] px-2 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/20 font-semibold">No data</span>;
  }
  if (!sym.newestDate) {
    return <span className="text-[10px] px-2 py-0.5 rounded border bg-muted/30 text-muted-foreground border-border/40 font-semibold">Unknown</span>;
  }
  const hrs = (Date.now() - new Date(sym.newestDate).getTime()) / 3_600_000;
  if (hrs < 24) {
    return <span className="text-[10px] px-2 py-0.5 rounded border bg-green-500/10 text-green-400 border-green-500/20 font-semibold">Current</span>;
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20 font-semibold">
      Stale {formatAge(sym.newestDate)}
    </span>
  );
}

// ── Symbol State Row ──────────────────────────────────────────────────────────

function SymbolStreamRow({ sym, diag, coverage, onToggle }: {
  sym: string;
  diag?: SymbolDiagnostic;
  coverage?: DataStatusSymbol;
  onToggle: (sym: string, enable: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const isActive = ACTIVE_SYMBOLS.includes(sym);

  const effectiveState: string = (() => {
    if (diag?.streamingState) return diag.streamingState;
    if (coverage && coverage.totalCandles > 0) return "available";
    return "no_data";
  })();

  async function toggle() {
    setBusy(true);
    try { await onToggle(sym, effectiveState !== "streaming"); }
    finally { setBusy(false); }
  }

  return (
    <tr className={cn("border-b border-border/20 last:border-0", isActive ? "bg-primary/2" : "")}>
      <td className="py-2.5 px-4">
        <div className="flex items-center gap-2">
          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
          <span className="font-mono font-semibold text-sm text-foreground">{sym}</span>
          {SYMBOL_LABELS[sym] && <span className="text-[11px] text-muted-foreground">{SYMBOL_LABELS[sym]}</span>}
        </div>
      </td>
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-2">
          <StreamState state={effectiveState} />
          {isActive && <span className="text-[10px] text-primary/60 font-medium">ACTIVE</span>}
        </div>
      </td>
      <td className="py-2.5 px-3 tabular-nums text-xs text-muted-foreground">
        {coverage?.count1m ? coverage.count1m.toLocaleString() : "—"}
      </td>
      <td className="py-2.5 px-3 tabular-nums text-xs text-muted-foreground">
        {coverage?.count5m ? coverage.count5m.toLocaleString() : "—"}
      </td>
      <td className="py-2.5 px-3 text-[11px] text-muted-foreground">
        {coverage ? formatAge(coverage.newestDate) : "—"}
      </td>
      <td className="py-2.5 px-4">
        {isActive && (
          <button
            onClick={toggle}
            disabled={busy}
            className={cn(
              "px-2.5 py-0.5 rounded text-[11px] font-medium border transition-colors inline-flex items-center gap-1",
              effectiveState === "streaming"
                ? "bg-red-500/10 border-red-500/25 text-red-400 hover:bg-red-500/20"
                : "bg-green-500/10 border-green-500/25 text-green-400 hover:bg-green-500/20",
              busy && "opacity-50 cursor-not-allowed"
            )}>
            {busy
              ? <RefreshCw className="w-3 h-3 animate-spin" />
              : effectiveState === "streaming"
                ? <><EyeOff className="w-3 h-3" /> Pause</>
                : <><Eye className="w-3 h-3" /> Stream</>}
          </button>
        )}
      </td>
    </tr>
  );
}

// ── Coverage Table ────────────────────────────────────────────────────────────

function CoverageTable({ data, tier }: { data: DataStatusSymbol[]; tier?: string }) {
  const rows = tier ? data.filter(s => s.tier === tier) : data;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-4">No symbols in this tier.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/40 bg-muted/10">
            <th className="text-left py-2.5 px-4 font-medium">Symbol</th>
            <th className="text-left py-2.5 px-3 font-medium">Tier</th>
            <th className="text-right py-2.5 px-3 font-medium">M1 Candles</th>
            <th className="text-right py-2.5 px-3 font-medium">M5 Candles</th>
            <th className="text-right py-2.5 px-3 font-medium">Total</th>
            <th className="text-center py-2.5 px-3 font-medium">Oldest</th>
            <th className="text-center py-2.5 px-3 font-medium">Newest</th>
            <th className="text-center py-2.5 px-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(sym => {
            const isActive = ACTIVE_SYMBOLS.includes(sym.symbol);
            return (
              <tr key={sym.symbol} className={cn("border-b border-border/20 hover:bg-muted/10", isActive ? "bg-primary/2" : "")}>
                <td className="py-2.5 px-4">
                  <div className="flex items-center gap-2">
                    {isActive && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                    <span className="font-mono font-semibold text-foreground">{sym.symbol}</span>
                    {SYMBOL_LABELS[sym.symbol] && (
                      <span className="text-[11px] text-muted-foreground">{SYMBOL_LABELS[sym.symbol]}</span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 px-3">
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase",
                    sym.tier === "active" ? "bg-primary/10 text-primary border-primary/25"
                    : sym.tier === "data" ? "bg-blue-500/10 text-blue-400 border-blue-500/25"
                    : "bg-muted/30 text-muted-foreground border-border/40"
                  )}>
                    {sym.tier}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {sym.count1m > 0 ? <span className="text-foreground font-medium">{sym.count1m.toLocaleString()}</span> : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {sym.count5m > 0 ? <span className="text-foreground font-medium">{sym.count5m.toLocaleString()}</span> : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                  {sym.totalCandles > 0 ? sym.totalCandles.toLocaleString() : "—"}
                </td>
                <td className="py-2.5 px-3 text-center text-xs text-muted-foreground">{formatDate(sym.oldestDate)}</td>
                <td className="py-2.5 px-3 text-center text-xs text-muted-foreground">
                  {sym.newestDate
                    ? <span title={sym.newestDate}>{formatDate(sym.newestDate)} <span className="text-muted-foreground/50">({formatAge(sym.newestDate)})</span></span>
                    : "—"}
                </td>
                <td className="py-2.5 px-3 text-center"><CoverageStatus sym={sym} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Integrity Summary ─────────────────────────────────────────────────────────

function IntegritySummary({ data }: { data: ResearchDataStatus }) {
  const withData = data.symbols.filter(s => s.totalCandles > 0);
  const noData = data.symbols.filter(s => s.totalCandles === 0);
  const current = data.symbols.filter(s => {
    if (!s.newestDate) return false;
    return (Date.now() - new Date(s.newestDate).getTime()) < 24 * 3_600_000;
  });
  const stale = withData.filter(s => {
    if (!s.newestDate) return false;
    return (Date.now() - new Date(s.newestDate).getTime()) >= 24 * 3_600_000;
  });
  const totalM = (data.totalStorage / 1_000_000).toFixed(2);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {[
        { label: "Total Symbols",  value: String(data.symbolCount),          color: "text-foreground" },
        { label: "Total Candles",  value: `${totalM}M`,                      color: "text-foreground" },
        { label: "Current",        value: String(current.length),             color: "text-green-400",  sub: "within 24h" },
        { label: "Stale",          value: String(stale.length),               color: "text-amber-400",  sub: ">24h behind" },
        { label: "No Data",        value: String(noData.length),              color: "text-red-400",    sub: "research syms" },
      ].map(({ label, value, color, sub }) => (
        <div key={label} className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5">{label}</p>
          <p className={cn("text-2xl font-bold tabular-nums", color)}>{value}</p>
          {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      ))}
    </div>
  );
}

// ── Data Operations Tab ───────────────────────────────────────────────────────

function OpCard({ title, description, symbol, onSymbolChange, onRun, running, result }: {
  title: string; description: string;
  symbol: string; onSymbolChange: (s: string) => void;
  onRun: () => void; running: boolean; result: OpResult;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <SymbolSelectFull value={symbol} onChange={onSymbolChange} />
        <button onClick={onRun} disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? "Running…" : `Run for ${symbol}`}
        </button>
      </div>
      {result && (
        result.ok ? (
          <div className="space-y-1.5">
            <SuccessBox msg={result.msg} />
            {result.detail && (
              <div className="rounded bg-muted/20 p-3 space-y-1">
                {Object.entries(result.detail).map(([k, v]) => (
                  <div key={k} className="flex items-start gap-3 text-xs">
                    <span className="text-muted-foreground w-36 shrink-0">{k}</span>
                    <span className="font-mono text-foreground">{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : <ErrorBox msg={result.msg} />
      )}
    </div>
  );
}

function DataOpsTab() {
  const [repairSym, setRepairSym] = useState("CRASH300");
  const [repairRunning, setRepairRunning] = useState(false);
  const [repairResult, setRepairResult] = useState<OpResult>(null);

  const [reconcileSym, setReconcileSym] = useState("CRASH300");
  const [reconcileRunning, setReconcileRunning] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<OpResult>(null);

  const [enrichSym, setEnrichSym] = useState("CRASH300");
  const [enrichRunning, setEnrichRunning] = useState(false);
  const [enrichResult, setEnrichResult] = useState<OpResult>(null);

  const runRepair = async () => {
    setRepairRunning(true); setRepairResult(null);
    try {
      const d = await apiFetch("research/repair-interpolated", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: repairSym }),
      });
      const s = d.summary ?? {};
      setRepairResult({
        ok: true,
        msg: `Repair complete — recovered ${(s.totalRecovered ?? 0).toLocaleString()} of ${(s.totalBefore ?? 0).toLocaleString()} interpolated candles`,
        detail: {
          "Found (before)": (s.totalBefore ?? 0).toLocaleString(),
          "Recovered": (s.totalRecovered ?? 0).toLocaleString(),
          "Unrecoverable": (s.totalUnrecoverable ?? 0).toLocaleString(),
        },
      });
    } catch (e: any) { setRepairResult({ ok: false, msg: e.message }); }
    finally { setRepairRunning(false); }
  };

  const runReconcile = async () => {
    setReconcileRunning(true); setReconcileResult(null);
    try {
      const d = await apiFetch("research/reconcile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: reconcileSym }),
      });
      setReconcileResult({
        ok: true,
        msg: `Reconciliation complete for ${reconcileSym}`,
        detail: Object.fromEntries(Object.entries(d.summary ?? d).map(([k, v]) => [k, String(v)])),
      });
    } catch (e: any) { setReconcileResult({ ok: false, msg: e.message }); }
    finally { setReconcileRunning(false); }
  };

  const runEnrich = async () => {
    setEnrichRunning(true); setEnrichResult(null);
    try {
      const d = await apiFetch("research/enrich", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: enrichSym }),
      });
      setEnrichResult({
        ok: true,
        msg: `Enrichment complete for ${enrichSym}`,
        detail: Object.fromEntries(Object.entries(d.summary ?? d).map(([k, v]) => [k, String(v)])),
      });
    } catch (e: any) { setEnrichResult({ ok: false, msg: e.message }); }
    finally { setEnrichRunning(false); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Data operations run in the foreground and may take several minutes for large symbol histories.
          Repair may not recover all candles — data outside API history limits remains interpolated.
        </p>
      </div>
      <OpCard
        title="Repair Interpolated Candles"
        description="Scans all isInterpolated=true candles in the 1m and 5m tables and attempts to replace them with real API candles. Candles the API cannot supply remain interpolated (market closures, history limits). May take 2–5 minutes."
        symbol={repairSym} onSymbolChange={setRepairSym}
        onRun={runRepair} running={repairRunning} result={repairResult}
      />
      <OpCard
        title="Reconcile Candles"
        description="Reconciles the stored candle database against the Deriv API to identify gaps, missing bars, and timeframe coverage issues. Fills gaps where possible."
        symbol={reconcileSym} onSymbolChange={setReconcileSym}
        onRun={runReconcile} running={reconcileRunning} result={reconcileResult}
      />
      <OpCard
        title="Enrich Candles (Multi-TF)"
        description="Re-runs the multi-timeframe aggregation pipeline. Derives all higher timeframes (5m, 10m, 20m, 40m, 1h, 2h, 4h, 8h, 1d, 2d, 4d) from the base 1m candle data."
        symbol={enrichSym} onSymbolChange={setEnrichSym}
        onRun={runEnrich} running={enrichRunning} result={enrichResult}
      />
    </div>
  );
}

// ── Top-Up Tab ────────────────────────────────────────────────────────────────

function TopUpTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [days, setDays] = useState(30);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const d = await apiFetch("research/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, days, type: "topup" }),
      });
      setResult(d);
    } catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Data Top-Up</h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            Fetches recent candle data from the Deriv API and stores it for the selected symbol.
            Used to bring symbols up-to-date after a streaming gap or to bootstrap a new symbol.
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <SymbolSelectFull value={symbol} onChange={setSymbol} />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Lookback:</span>
            {[7, 30, 90, 180].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={cn("px-2 py-1 rounded border text-xs transition-colors",
                  days === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                {d}d
              </button>
            ))}
          </div>
        </div>
        <button onClick={run} disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? "Running top-up…" : `Top-Up ${symbol} (${days}d)`}
        </button>
        {err && <ErrorBox msg={err} />}
        {result && (
          <div className="space-y-1.5">
            <SuccessBox msg="Top-up complete" />
            <div className="rounded bg-muted/20 p-3 space-y-1">
              {Object.entries(result.summary ?? result).map(([k, v]) => (
                <div key={k} className="flex items-start gap-3 text-xs">
                  <span className="text-muted-foreground w-36 shrink-0">{k}</span>
                  <span className="font-mono text-foreground">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DataManager() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ViewTab>("streaming");
  const [symbol, setSymbol] = useState("BOOM300");
  const [coverageTier, setCoverageTier] = useState<"" | "active" | "data" | "research">("");
  const [liveSubtab, setLiveSubtab] = useState<LiveSubtab>("ticks");

  const { data: status } = useGetDataStatus({ query: { refetchInterval: 3000 } });
  const { data: diagData, refetch: refetchDiag } = useSymbolDiagnostics();
  const { data: researchData, isLoading: researchLoading } = useResearchDataStatus();

  const { data: ticks } = useGetTicks(
    { symbol, limit: 30 },
    { query: { enabled: tab === "live" && liveSubtab === "ticks", refetchInterval: 2000 } }
  );
  const { data: candles } = useGetCandles(
    { symbol, timeframe: "M1", limit: 30 },
    { query: { enabled: tab === "live" && liveSubtab === "candles", refetchInterval: 5000 } }
  );
  const { data: spikes } = useGetSpikeEvents(
    { symbol, limit: 30 },
    { query: { enabled: tab === "live" && liveSubtab === "spikes", refetchInterval: 5000 } }
  );

  const diagSymbols = diagData?.symbols ?? [];
  const streamingCount = diagSymbols.filter(d => d.streamingState === "streaming").length;

  async function toggleStream(sym: string, enable: boolean) {
    await apiFetch(`diagnostics/symbols/${sym}/streaming`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enable }),
    });
    refetchDiag();
    queryClient.invalidateQueries({ queryKey: getGetDataStatusQueryKey() });
  }

  const allSymbolRows = useMemo(() => {
    const diagMap = new Map(diagSymbols.filter(d => !!d.symbol).map(d => [d.symbol, d]));
    const activeRows = ACTIVE_SYMBOLS.map(sym => ({
      sym,
      diag: diagMap.get(sym),
      coverage: researchData?.symbols.find(s => s.symbol === sym),
    }));
    const seen = new Set<string>(ACTIVE_SYMBOLS);
    const nonActiveFromCoverage = (researchData?.symbols ?? [])
      .filter(s => s.symbol && !seen.has(s.symbol) && !!seen.add(s.symbol))
      .map(s => ({ sym: s.symbol, diag: diagMap.get(s.symbol), coverage: s }));
    const diagOnlySymbols = diagSymbols
      .filter(d => d.symbol && !seen.has(d.symbol) && !!seen.add(d.symbol))
      .map(d => ({ sym: d.symbol, diag: d, coverage: undefined }));
    return [...activeRows, ...nonActiveFromCoverage, ...diagOnlySymbols];
  }, [diagSymbols, researchData]);

  const tabs: { id: ViewTab; label: string; icon: React.ElementType }[] = [
    { id: "streaming", label: "Symbol State",    icon: Radio     },
    { id: "coverage",  label: "Coverage",         icon: Database  },
    { id: "ops",       label: "Data Operations",  icon: Wrench    },
    { id: "topup",     label: "Top-Up",           icon: TrendingUp},
    { id: "live",      label: "Live View",        icon: Activity  },
  ];

  const liveSubtabs: { id: LiveSubtab; label: string }[] = [
    { id: "ticks",   label: "Live Ticks"   },
    { id: "candles", label: "M1 Candles"   },
    { id: "spikes",  label: "Spike Events" },
  ];

  const getCoverageForSymbol = (sym: string) => researchData?.symbols.find(s => s.symbol === sym);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Database className="w-6 h-6 text-primary" /> Data Console
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          All 28 symbols · streaming state · candle coverage · data operations · top-up
        </p>
      </div>

      {/* Stream summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-border/50 bg-card p-4 flex items-center gap-4">
          <div className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
            status?.streaming ? "bg-green-500/12 text-green-400" : "bg-muted/30 text-muted-foreground"
          )}>
            {status?.streaming ? <RadioTower className="w-5 h-5" /> : <Radio className="w-5 h-5" />}
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-0.5">Global Stream</p>
            <p className={cn("text-sm font-bold", status?.streaming ? "text-green-400" : "text-muted-foreground")}>
              {status?.streaming ? "Live" : "Offline"}
            </p>
            <p className="text-[10px] text-muted-foreground">Toggle in Settings</p>
          </div>
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <Activity className="w-3 h-3" /> Streaming Symbols
          </p>
          <p className="text-2xl font-bold tabular-nums">{streamingCount}</p>
          <p className="text-[10px] text-muted-foreground">of {allSymbolRows.length} tracked</p>
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <Layers className="w-3 h-3" /> Total Ticks Ingested
          </p>
          <p className="text-2xl font-bold tabular-nums">
            {status?.tickCount != null ? status.tickCount.toLocaleString() : "—"}
          </p>
          <p className="text-[10px] text-muted-foreground">since last stream start</p>
        </div>
      </div>

      {/* Integrity summary */}
      {researchData && <IntegritySummary data={researchData} />}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border/50 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border/60"
            )}>
            <t.icon className="w-3.5 h-3.5" />{t.label}
          </button>
        ))}
      </div>

      {/* ── Symbol State ── */}
      {tab === "streaming" && (
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Radio className="w-4 h-4 text-primary" /> Per-Symbol Streaming State
              </h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                All {allSymbolRows.length} symbols · Active trading symbols highlighted · Toggle streaming per active symbol
              </p>
            </div>
            <button onClick={() => refetchDiag()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground border border-border/40 hover:border-border transition-colors">
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/30 bg-muted/10">
                  <th className="text-left py-2.5 px-4 font-medium">Symbol</th>
                  <th className="text-left py-2.5 px-3 font-medium">Stream State</th>
                  <th className="text-right py-2.5 px-3 font-medium">M1 Candles</th>
                  <th className="text-right py-2.5 px-3 font-medium">M5 Candles</th>
                  <th className="text-right py-2.5 px-3 font-medium">Last Updated</th>
                  <th className="text-left py-2.5 px-4 font-medium">Control</th>
                </tr>
              </thead>
              <tbody>
                {allSymbolRows.map(({ sym, diag, coverage }) => (
                  <SymbolStreamRow
                    key={sym}
                    sym={sym}
                    diag={diag}
                    coverage={coverage}
                    onToggle={toggleStream}
                  />
                ))}
                {allSymbolRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-sm text-muted-foreground">
                      Loading symbol data…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t border-border/20 bg-muted/5">
            <p className="text-[10px] text-muted-foreground">
              <span className="text-green-400 font-medium">Streaming</span> = active tick feed ·
              <span className="text-blue-400 font-medium ml-1">Available</span> = has stored data, not streaming ·
              <span className="ml-1">No data</span> = not yet bootstrapped
            </p>
          </div>
        </div>
      )}

      {/* ── Coverage Tab ── */}
      {tab === "coverage" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted-foreground font-medium">Filter tier:</label>
            <select value={coverageTier} onChange={e => setCoverageTier(e.target.value as typeof coverageTier)}
              className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none">
              <option value="">All tiers</option>
              <option value="active">Active</option>
              <option value="data">Data</option>
              <option value="research">Research</option>
            </select>
          </div>

          {researchLoading ? (
            <div className="text-center py-12 text-sm text-muted-foreground">Loading coverage data…</div>
          ) : researchData ? (
            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Database className="w-4 h-4 text-primary" /> Candle Coverage — All {researchData.symbolCount} Symbols
                </h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {(researchData.totalStorage / 1_000_000).toFixed(2)}M total candles · Active symbols highlighted
                </p>
              </div>
              <CoverageTable data={researchData.symbols} tier={coverageTier || undefined} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Coverage data unavailable.</p>
          )}
        </div>
      )}

      {/* ── Data Operations ── */}
      {tab === "ops" && <DataOpsTab />}

      {/* ── Top-Up ── */}
      {tab === "topup" && <TopUpTab />}

      {/* ── Live View ── */}
      {tab === "live" && (
        <div className="space-y-4">
          {/* Symbol + sub-tab selector */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground font-medium">Symbol:</label>
              <select className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none h-8 w-52"
                value={symbol} onChange={e => setSymbol(e.target.value)}>
                {ALL_28_SYMBOLS.map(s => (
                  <option key={s} value={s}>{s}{SYMBOL_LABELS[s] ? ` — ${SYMBOL_LABELS[s]}` : ""}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-1 border border-border/40 rounded-lg p-0.5 bg-muted/10">
              {liveSubtabs.map(st => (
                <button key={st.id} onClick={() => setLiveSubtab(st.id)}
                  className={cn(
                    "px-3 py-1 rounded text-xs font-medium transition-colors",
                    liveSubtab === st.id
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}>
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          {/* Live Ticks */}
          {liveSubtab === "ticks" && (
            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Activity className="w-4 h-4 text-primary" /> Live Ticks — {symbol}
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/30 bg-muted/10">
                      <th className="text-left py-2 px-4 font-medium">Time</th>
                      <th className="text-left py-2 px-3 font-medium">Symbol</th>
                      <th className="text-right py-2 px-3 font-medium">Quote</th>
                      <th className="text-right py-2 px-4 font-medium">Epoch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!ticks?.length
                      ? <tr><td colSpan={4} className="text-center py-10 text-sm text-muted-foreground">No tick data for {symbol}</td></tr>
                      : ticks.map(t => (
                        <tr key={t.id} className="border-b border-border/15 hover:bg-muted/10">
                          <td className="py-2 px-4 tabular-nums text-xs text-muted-foreground">
                            {new Date(t.createdAt).toLocaleTimeString()}
                          </td>
                          <td className="py-2 px-3 text-sm font-medium">{symbol}</td>
                          <td className="py-2 px-3 text-right tabular-nums font-semibold">{formatNumber(t.quote, 4)}</td>
                          <td className="py-2 px-4 text-right tabular-nums text-xs text-muted-foreground/50">{t.epochTs}</td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* M1 Candles */}
          {liveSubtab === "candles" && (
            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-primary" /> M1 Candles — {symbol}
                </h2>
                {getCoverageForSymbol(symbol) && (
                  <span className="text-[11px] text-muted-foreground">
                    {getCoverageForSymbol(symbol)!.count1m.toLocaleString()} total
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/30 bg-muted/10">
                      <th className="text-left py-2 px-4 font-medium">Time</th>
                      <th className="text-right py-2 px-3 font-medium">Open</th>
                      <th className="text-right py-2 px-3 font-medium">High</th>
                      <th className="text-right py-2 px-3 font-medium">Low</th>
                      <th className="text-right py-2 px-3 font-medium">Close</th>
                      <th className="text-right py-2 px-4 font-medium">Ticks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!candles?.length
                      ? <tr><td colSpan={6} className="text-center py-10 text-sm text-muted-foreground">No candle data for {symbol}</td></tr>
                      : candles.map(c => (
                        <tr key={c.id} className="border-b border-border/15 hover:bg-muted/10">
                          <td className="py-2 px-4 tabular-nums text-xs text-muted-foreground">
                            {new Date(c.openTs * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">{formatNumber(c.open, 3)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-green-400">{formatNumber(c.high, 3)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-red-400">{formatNumber(c.low, 3)}</td>
                          <td className="py-2 px-3 text-right tabular-nums font-semibold">{formatNumber(c.close, 3)}</td>
                          <td className="py-2 px-4 text-right tabular-nums text-muted-foreground">{c.tickCount}</td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Spike Events */}
          {liveSubtab === "spikes" && (
            <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/30">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="w-4 h-4 text-primary" /> Spike Events — {symbol}
                </h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Boom/Crash spike events captured from live tick stream
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b border-border/30 bg-muted/10">
                      <th className="text-left py-2 px-4 font-medium">Time</th>
                      <th className="text-left py-2 px-3 font-medium">Direction</th>
                      <th className="text-right py-2 px-3 font-medium">Size</th>
                      <th className="text-right py-2 px-4 font-medium">Ticks Since Previous</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!spikes?.length
                      ? <tr><td colSpan={4} className="text-center py-10 text-sm text-muted-foreground">No spike events for {symbol}</td></tr>
                      : spikes.map(s => (
                        <tr key={s.id} className="border-b border-border/15 hover:bg-muted/10">
                          <td className="py-2 px-4 tabular-nums text-xs text-muted-foreground">
                            {new Date(s.eventTs * 1000).toLocaleTimeString()}
                          </td>
                          <td className="py-2 px-3">
                            <span className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border",
                              s.direction === "up"
                                ? "bg-green-500/10 text-green-400 border-green-500/25"
                                : "bg-red-500/10 text-red-400 border-red-500/25"
                            )}>
                              {s.direction === "up" ? "↑ Up" : "↓ Down"}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums font-semibold">{formatNumber(s.spikeSize, 2)}</td>
                          <td className="py-2 px-4 text-right tabular-nums text-muted-foreground">
                            {s.ticksSincePreviousSpike || "—"}
                          </td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
