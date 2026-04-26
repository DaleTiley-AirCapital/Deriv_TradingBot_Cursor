import React, { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetTicks,
  useGetCandles,
  useGetSpikeEvents,
  useGetOverview,
  getGetDataStatusQueryKey,
  getGetTicksQueryKey,
  getGetCandlesQueryKey,
  getGetSpikeEventsQueryKey,
} from "@workspace/api-client-react";
import { formatNumber, cn } from "@/lib/utils";
import {
  Database, Play, RefreshCw, Radio, Activity, Loader2,
  TrendingUp, Layers, CheckCircle, XCircle, AlertTriangle, Eye, EyeOff, Wrench,
  Download, ChevronRight, Cpu, Sparkles, ChevronDown,
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

interface DataTopUpTracker {
  symbol: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  baseline1mCount: number;
  current1mCount: number;
  downloaded1mCount: number;
  message: string;
  error?: string | null;
}

type OpResult = { ok: boolean; msg: string; detail?: Record<string, string> } | null;
type ViewTab = "runtime" | "streaming" | "coverage" | "ops" | "export" | "live";
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

interface CoverageRow { symbol: string; timeframe: string; count: number; interpolatedCount: number; }
function useCoverageAll() {
  return useQuery<{ rows: CoverageRow[] }>({
    queryKey: ["research/coverage-all"],
    queryFn: () => apiFetch("research/coverage-all"),
    refetchInterval: 60_000,
    staleTime: 30_000,
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
    available: { cls: "bg-blue-500/12 text-blue-400 border-blue-500/25",      label: "Registered" },
    idle:      { cls: "bg-muted/30 text-muted-foreground border-border/40",   label: "Pending"    },
    disabled:  { cls: "bg-amber-500/12 text-amber-400 border-amber-500/25",   label: "Paused"     },
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
  const [optimisticState, setOptimisticState] = useState<string | null>(null);
  const isActive = ACTIVE_SYMBOLS.includes(sym);

  const serverState: string = (() => {
    if (diag?.streamingState) return diag.streamingState;
    if (diag?.apiSymbol) return "available";
    if (coverage && coverage.totalCandles > 0) return "available";
    if (ALL_28_SYMBOLS.includes(sym)) return "available";
    return "no_data";
  })();

  const effectiveState = optimisticState ?? serverState;

  useEffect(() => {
    if (diag?.streamingState) setOptimisticState(null);
  }, [diag?.streamingState]);

  async function toggle() {
    const wantEnable = effectiveState !== "streaming";
    setBusy(true);
    setOptimisticState(wantEnable ? "streaming" : "disabled");
    try { await onToggle(sym, wantEnable); }
    catch { setOptimisticState(null); }
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
        {(effectiveState !== "no_data") && (
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

// ── Data Operations Tab — Unified Canonical Cleanup ───────────────────────────

function CleanCanonicalTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced individual ops state
  const [advSym, setAdvSym] = useState("CRASH300");
  const [advOp, setAdvOp]  = useState<"repair"|"reconcile"|"enrich"|null>(null);
  const [advResult, setAdvResult] = useState<OpResult>(null);
  const [advRunning, setAdvRunning] = useState(false);

  const run = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const d = await apiFetch("research/clean-canonical?background=true", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      setResult({ started: true, symbol, message: d.message ?? "Pipeline started in background." });
    } catch (e: any) { setErr((e as Error).message); }
    finally { setRunning(false); }
  };

  const runAdv = async (op: "repair"|"reconcile"|"enrich") => {
    setAdvRunning(true); setAdvOp(op); setAdvResult(null);
    const paths: Record<string, string> = {
      repair:    "research/repair-interpolated",
      reconcile: "research/reconcile",
      enrich:    "research/enrich",
    };
    try {
      const d = await apiFetch(paths[op], {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: advSym }),
      });
      setAdvResult({
        ok: true,
        msg: `${op} complete for ${advSym}`,
        detail: Object.fromEntries(
          Object.entries(d.summary ?? d.result ?? d)
            .filter(([, v]) => typeof v !== "object")
            .map(([k, v]) => [k, String(v)])
        ),
      });
    } catch (e: any) { setAdvResult({ ok: false, msg: (e as Error).message }); }
    finally { setAdvRunning(false); }
  };

  return (
    <div className="space-y-4">
      {/* Primary Action */}
      <div className="rounded-xl border border-primary/20 bg-card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Clean Canonical Data</h3>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed max-w-xl">
              Runs the full pipeline: detect &amp; fill gaps from API → re-check existing interpolated
              candles and replace with real data → derive all timeframes. Interpolation is only used
              as last resort when the API has no data.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <SymbolSelectFull value={symbol} onChange={s => { setSymbol(s); setResult(null); setErr(null); }} />
          <button onClick={run} disabled={running}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary/40 bg-primary/12 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Cleaning… (may take 2–5 min)</>
              : <><Sparkles className="w-4 h-4" /> Clean Canonical Data for {symbol}</>}
          </button>
        </div>

        {running && (
          <div className="rounded-lg bg-muted/20 border border-border/30 px-4 py-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Starting pipeline…</p>
            <p>Launching gap repair, interpolation recovery, and enrichment in background</p>
          </div>
        )}

        {err && <ErrorBox msg={err} />}

        {result && !err && result.started && (
          <div className="space-y-2">
            <SuccessBox msg={`Pipeline launched for ${result.symbol ?? symbol}`} />
            <div className="rounded-lg bg-muted/20 border border-border/30 px-4 py-3 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">Running in background — typically 2–5 min</p>
              <p>1. Detecting and filling gaps from Deriv API</p>
              <p>2. Re-checking interpolated candles → replacing with real API data</p>
              <p>3. Running multi-timeframe enrichment (5m → 1d)</p>
              <p className="pt-1">Refresh the <span className="font-medium text-foreground">Coverage</span> tab after a few minutes to see updated counts.</p>
            </div>
          </div>
        )}
      </div>

      {/* Advanced / debug ops */}
      <div className="rounded-xl border border-border/40 overflow-hidden">
        <button
          onClick={() => setShowAdvanced(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 bg-muted/10 hover:bg-muted/20 transition-colors text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Wrench className="w-3.5 h-3.5" /> Advanced — Individual Operations
          </span>
          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showAdvanced && "rotate-180")} />
        </button>
        {showAdvanced && (
          <div className="p-4 space-y-3 bg-muted/5">
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed border-b border-border/20 pb-3">
              Low-level operations for advanced debugging. Use "Clean Canonical Data" for normal maintenance.
              These run on the selected symbol only and do not run the full pipeline.
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <SymbolSelectFull value={advSym} onChange={s => { setAdvSym(s); setAdvResult(null); }} />
              {(["repair", "reconcile", "enrich"] as const).map(op => (
                <button key={op} onClick={() => runAdv(op)} disabled={advRunning}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {advRunning && advOp === op ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  {op.charAt(0).toUpperCase() + op.slice(1)}
                </button>
              ))}
            </div>
            {advResult && (
              advResult.ok ? (
                <div className="space-y-1.5">
                  <SuccessBox msg={advResult.msg} />
                  {advResult.detail && Object.keys(advResult.detail).length > 0 && (
                    <div className="rounded bg-muted/20 p-3 space-y-1">
                      {Object.entries(advResult.detail).map(([k, v]) => (
                        <div key={k} className="flex items-start gap-3 text-xs">
                          <span className="text-muted-foreground w-36 shrink-0">{k}</span>
                          <span className="font-mono text-foreground">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : <ErrorBox msg={advResult.msg} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoricalDownloadCard({ statusData }: { statusData?: ResearchDataStatus }) {
  const [symbol, setSymbol] = useState("R_100");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [tracker, setTracker] = useState<DataTopUpTracker | null>(null);

  const statusBySymbol = useMemo(() => {
    return new Map((statusData?.symbols ?? []).map(s => [s.symbol, s]));
  }, [statusData]);

  const noDataSymbols = useMemo(() => {
    return ALL_28_SYMBOLS.filter(s => (statusBySymbol.get(s)?.totalCandles ?? 0) === 0);
  }, [statusBySymbol]);

  const selectedStatus = statusBySymbol.get(symbol);

  useEffect(() => {
    let cancelled = false;
    const loadTracker = async () => {
      try {
        const d = await apiFetch<{ tracker: DataTopUpTracker | null }>(`research/data-top-up-status/${symbol}`);
        if (!cancelled) setTracker(d.tracker ?? null);
      } catch {
        if (!cancelled) setTracker(null);
      }
    };

    void loadTracker();
    const id = setInterval(() => { void loadTracker(); }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  const startDownload = async () => {
    setRunning(true);
    setErr(null);
    setOk(null);
    try {
      const d = await apiFetch<{ message?: string; tracker?: DataTopUpTracker }>("research/data-top-up?background=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      setOk(d.message ?? `Historical download started for ${symbol}`);
      setTracker(d.tracker ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
          <Download className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Download Historical Data (Per Symbol)</h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed max-w-xl">
            Backfills missing or incomplete history for any symbol, including active symbols like R_100 and research-only symbols with no data.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <SymbolSelectFull value={symbol} onChange={setSymbol} />
        <button
          onClick={startDownload}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-500/40 bg-blue-500/12 text-blue-400 text-xs font-semibold hover:bg-blue-500/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {running
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting...</>
            : <><Download className="w-4 h-4" /> Download Historical Data for {symbol}</>}
        </button>
        <span className="text-[11px] text-muted-foreground">
          No-data symbols: <span className="font-semibold text-foreground">{noDataSymbols.length}</span>
        </span>
        {selectedStatus && (
          <span className="text-[11px] text-muted-foreground">
            Selected M1: <span className="font-semibold text-foreground">{selectedStatus.count1m.toLocaleString()}</span>
            {selectedStatus.newestDate ? ` · latest ${formatAge(selectedStatus.newestDate)}` : ""}
          </span>
        )}
      </div>
      {err && <ErrorBox msg={err} />}
      {ok && <SuccessBox msg={ok} />}
      {tracker && (
        <div className="rounded-lg bg-muted/20 border border-border/30 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Download tracker ({symbol})</span>
            <span className={cn(
              "font-medium",
              tracker.status === "running"
                ? "text-primary"
                : tracker.status === "completed"
                  ? "text-green-400"
                  : "text-red-400",
            )}>
              {tracker.status}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded bg-background/50 border border-border/30 p-2">
              <div className="text-muted-foreground text-[10px] uppercase tracking-wide">Baseline M1</div>
              <div className="font-mono text-foreground">{tracker.baseline1mCount.toLocaleString()}</div>
            </div>
            <div className="rounded bg-background/50 border border-border/30 p-2">
              <div className="text-muted-foreground text-[10px] uppercase tracking-wide">Current M1</div>
              <div className="font-mono text-foreground">{tracker.current1mCount.toLocaleString()}</div>
            </div>
            <div className="rounded bg-background/50 border border-border/30 p-2">
              <div className="text-muted-foreground text-[10px] uppercase tracking-wide">Downloaded</div>
              <div className="font-mono text-green-400">+{tracker.downloaded1mCount.toLocaleString()}</div>
            </div>
            <div className="rounded bg-background/50 border border-border/30 p-2">
              <div className="text-muted-foreground text-[10px] uppercase tracking-wide">Last update</div>
              <div className="font-mono text-foreground">{new Date(tracker.updatedAt).toLocaleTimeString()}</div>
            </div>
          </div>
          {tracker.status === "running" && (
            <div className="w-full h-1.5 rounded bg-background/60 overflow-hidden">
              <div className="h-full w-1/3 bg-primary animate-pulse" />
            </div>
          )}
          <p className="text-[11px] text-foreground">{tracker.message}</p>
          {tracker.error && <ErrorBox msg={tracker.error} />}
          <p className="text-[11px] text-muted-foreground">
            Tracker is persisted on the backend and remains visible after navigation or refresh.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Export Tab ────────────────────────────────────────────────────────────────

const EXPORT_TIMEFRAMES = ["1m", "5m"] as const;
type ExportTimeframe = typeof EXPORT_TIMEFRAMES[number];

function ExportTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [timeframe, setTimeframe] = useState<ExportTimeframe>("1m");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [range, setRange] = useState<any | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [precheck, setPrecheck] = useState<any | null>(null);
  const [prechecking, setPrechecking] = useState(false);
  const [precheckErr, setPrecheckErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [exportOk, setExportOk] = useState(false);

  useEffect(() => {
    setRangeLoading(true);
    setRange(null);
    setPrecheck(null);
    setPrecheckErr(null);
    apiFetch(`export/range?symbol=${symbol}&timeframe=${timeframe}`)
      .then((d: any) => {
        setRange(d);
        if (d.firstAvailableDate) setStartDate(d.firstAvailableDate);
        if (d.lastAvailableDate)  setEndDate(d.lastAvailableDate);
      })
      .catch(() => {})
      .finally(() => setRangeLoading(false));
  }, [symbol, timeframe]);

  const runPrecheck = async () => {
    if (!startDate || !endDate) return;
    setPrechecking(true); setPrecheck(null); setPrecheckErr(null);
    try {
      const d = await apiFetch(
        `export/precheck?symbol=${symbol}&timeframe=${timeframe}&startDate=${startDate}&endDate=${endDate}`
      );
      setPrecheck(d);
    } catch (e: any) { setPrecheckErr(e.message); }
    finally { setPrechecking(false); }
  };

  const runExport = async () => {
    if (!startDate || !endDate) return;
    setExporting(true); setExportErr(null); setExportOk(false);
    try {
      const resp = await fetch(`${BASE}api/export/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, startDate, endDate }),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error((d as any).error ?? `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = `${symbol}_${timeframe}_${startDate}_${endDate}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportOk(true);
    } catch (e: any) { setExportErr(e.message); }
    finally { setExporting(false); }
  };

  const canAct = !!(startDate && endDate && startDate <= endDate);
  const noData = range?.health === "empty";

  return (
    <div className="space-y-5">
      {/* Config */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Download className="w-4 h-4 text-primary" /> Export Candle Data — ZIP
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
            Downloads a ZIP archive containing raw candle chunks, <span className="font-mono text-foreground">manifest.json</span> (file map + row counts),
            and <span className="font-mono text-foreground">validation.json</span> (gap and interpolation report).
            ZIP is the only export format — no CSV-only or JSON-only options.
          </p>
        </div>

        {/* Symbol + Timeframe */}
        <div className="flex flex-wrap items-center gap-4">
          <SymbolSelectFull value={symbol} onChange={s => { setSymbol(s); setPrecheck(null); }} />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Timeframe:</span>
            {EXPORT_TIMEFRAMES.map(tf => (
              <button key={tf} onClick={() => { setTimeframe(tf); setPrecheck(null); }}
                className={cn("px-2.5 py-1 rounded border text-xs transition-colors",
                  timeframe === tf
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/40 text-muted-foreground hover:border-border")}>
                {tf}
              </button>
            ))}
          </div>
        </div>

        {/* Available range banner */}
        {rangeLoading && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading available range…
          </div>
        )}
        {range && !rangeLoading && (
          <div className="rounded-lg bg-muted/20 border border-border/30 px-3 py-2.5 space-y-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Available Range — {symbol}/{timeframe}
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span className="text-xs">
                <span className="text-muted-foreground">First: </span>
                <span className="font-mono text-foreground">{range.firstAvailableDate ?? "—"}</span>
              </span>
              <span className="text-xs">
                <span className="text-muted-foreground">Last: </span>
                <span className="font-mono text-foreground">{range.lastAvailableDate ?? "—"}</span>
              </span>
              <span className="text-xs">
                <span className="text-muted-foreground">Total: </span>
                <span className="font-mono text-foreground">{range.totalRows?.toLocaleString() ?? "—"} rows</span>
              </span>
              <span className="text-xs">
                <span className="text-muted-foreground">Interpolated: </span>
                <span className="font-mono text-foreground">{range.interpolatedCount?.toLocaleString() ?? "—"}</span>
              </span>
              <span className={cn("text-xs font-semibold",
                range.health === "ok" ? "text-green-400" : range.health === "partial" ? "text-amber-400" : "text-red-400")}>
                {range.health?.toUpperCase() ?? "—"}
              </span>
            </div>
          </div>
        )}
        {noData && <ErrorBox msg={`No ${symbol}/${timeframe} candle data found in the database. Run a Top-Up first.`} />}

        {/* Date range pickers */}
        {!noData && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-10">From:</span>
              <input type="date" value={startDate}
                min={range?.firstAvailableDate || undefined}
                max={endDate || range?.lastAvailableDate || undefined}
                onChange={e => { setStartDate(e.target.value); setPrecheck(null); }}
                className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-10">To:</span>
              <input type="date" value={endDate}
                min={startDate || range?.firstAvailableDate || undefined}
                max={range?.lastAvailableDate || undefined}
                onChange={e => { setEndDate(e.target.value); setPrecheck(null); }}
                className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50" />
            </div>
          </div>
        )}

        {/* Actions */}
        {!noData && (
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <button onClick={runPrecheck} disabled={!canAct || prechecking}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border/50 text-foreground text-xs font-medium hover:border-border hover:bg-muted/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {prechecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Precheck
            </button>
            <button onClick={runExport} disabled={!canAct || exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {exporting ? "Preparing ZIP…" : "Download ZIP"}
            </button>
          </div>
        )}

        {precheckErr && <ErrorBox msg={precheckErr} />}
        {exportErr   && <ErrorBox msg={exportErr} />}
        {exportOk    && <SuccessBox msg="ZIP download started — check your downloads folder." />}
      </div>

      {/* Precheck results */}
      {precheck && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              Precheck — {symbol}/{timeframe}
            </h3>
            {precheck.outOfRange && (
              <span className="text-[10px] px-2 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/25">
                Out of range
              </span>
            )}
          </div>
          {precheck.outOfRangeMsg && <ErrorBox msg={precheck.outOfRangeMsg} />}
          {!precheck.outOfRange && (
            <>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Selected Range</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: "Row Count",    value: (precheck.selectedRange?.rowCount        ?? 0).toLocaleString() },
                    { label: "Real Rows",    value: (precheck.selectedRange?.realCount        ?? 0).toLocaleString() },
                    { label: "Interpolated", value: (precheck.selectedRange?.interpolatedCount ?? 0).toLocaleString() },
                    { label: "Date Range",   value: precheck.selectedRange?.firstDate && precheck.selectedRange?.lastDate
                      ? `${precheck.selectedRange.firstDate} → ${precheck.selectedRange.lastDate}` : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-muted/20 rounded-lg p-3">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                      <div className="text-sm font-mono font-bold text-foreground">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                  Total Available — {symbol}/{timeframe}
                </p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {[
                    { label: "Total Rows",   value: (precheck.totalAvailable?.rowCount        ?? 0).toLocaleString() },
                    { label: "Real Rows",    value: (precheck.totalAvailable?.realCount        ?? 0).toLocaleString() },
                    { label: "Interpolated", value: (precheck.totalAvailable?.interpolatedCount ?? 0).toLocaleString() },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-muted/20 rounded-lg p-3">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                      <div className="text-sm font-mono font-bold text-muted-foreground">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          <p className="text-[10px] text-muted-foreground border-t border-border/20 pt-3">
            ZIP contains: raw candle chunks (25k rows/file) · <span className="font-mono">manifest.json</span> (file map + counts) · <span className="font-mono">validation.json</span> (gap + interpolation audit)
          </p>
        </div>
      )}
    </div>
  );
}

// ── Runtime Tab (operational system state) ────────────────────────────────────

function RuntimeKV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{k}</span>
      <span className={cn("text-xs text-foreground text-right break-all", mono && "font-mono")}>{v}</span>
    </div>
  );
}

function RuntimePill({ variant, label }: { variant: "ok"|"warn"|"error"|"info"|"default"; label: string }) {
  const cls = {
    ok:      "bg-green-500/15 text-green-400 border-green-500/25",
    warn:    "bg-amber-500/15 text-amber-400 border-amber-500/25",
    error:   "bg-red-500/15 text-red-400 border-red-500/25",
    info:    "bg-primary/15 text-primary border-primary/25",
    default: "bg-muted/40 text-muted-foreground border-border/50",
  }[variant];
  return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", cls)}>{label}</span>;
}

function RuntimePanel({ title, icon: Icon, badge, children }: {
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

function RuntimeTab() {
  const [features, setFeatures] = useState<Record<string, any>>({});
  const [featLoading, setFeatLoading] = useState<Record<string, boolean>>({});
  const FEATURE_LABELS: Record<string, string> = {
    emaSlope: "EMA trend slope",
    emaDist: "Price distance vs EMA20",
    priceVsEma20: "Normalized price/EMA20 distance",
    rsi14: "RSI (14)",
    rsiZone: "RSI regime zone",
    atr14: "ATR(14) normalized volatility",
    atrRank: "ATR percentile rank",
    bbWidth: "Bollinger Band width",
    bbPctB: "Bollinger %B position",
    candleBody: "Candle body ratio",
    upperWickRatio: "Upper wick ratio",
    lowerWickRatio: "Lower wick ratio",
    consecutive: "Consecutive directional candles",
    zScore: "Price z-score",
    rollingSkew: "Short-window return skew",
    ticksSinceSpike: "Ticks elapsed since spike",
    runLengthSinceSpike: "Bars since spike run started",
    spikeHazardScore: "Spike hazard estimate",
    swingHighDist: "Distance to swing high",
    swingLowDist: "Distance to swing low",
    swingBreached: "Swing low/high breach flag",
    swingReclaimed: "Swing reclaim flag",
    latestCandleCloseTs: "Latest candle close timestamp",
    ts: "Feature snapshot timestamp",
  };

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

  return (
    <div className="space-y-4">
      <RuntimePanel title="V3 Engine Features — Live State" icon={Cpu}
        badge={<span className="text-[10px] text-muted-foreground">Active symbols only</span>}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground bg-muted/20 rounded p-3">
            Computed feature vectors that the V3 coordinator sees on each scan cycle. Click a symbol to load its latest features.
          </p>
          <div className="rounded border border-border/30 bg-background/30 p-3 text-[11px] text-muted-foreground">
            <p className="font-medium text-foreground mb-1">How to read this</p>
            <p>
              These are normalized model inputs, not profits or scores. They feed:
              feature vector → engine formula → native score → coordinator → allocator → trade manager.
            </p>
          </div>
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
            <div key={sym} className="rounded border border-border/40 p-3 space-y-1.5">
              <div className="text-xs font-semibold text-primary mb-2">{sym}</div>
              {(f as any).error ? <ErrorBox msg={(f as any).error} /> : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-0">
                  {Object.entries(f as Record<string,any>).filter(([k]) => !["symbol","error"].includes(k)).slice(0, 24).map(([k, v]) => (
                    <RuntimeKV
                      key={k}
                      k={FEATURE_LABELS[k] ? `${k} · ${FEATURE_LABELS[k]}` : k}
                      v={String(v ?? "—")}
                      mono
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {Object.keys(features).length === 0 && (
            <p className="text-xs text-muted-foreground/60 text-center py-4">
              Click a symbol above to load its feature vector
            </p>
          )}
        </div>
      </RuntimePanel>
    </div>
  );
}

// ── Coverage All Grid ──────────────────────────────────────────────────────────

const ALL_TIMEFRAMES = ["1m","5m","10m","20m","40m","1h","2h","4h","8h","1d","2d","4d"] as const;

function CoverageAllGrid() {
  const { data, isLoading, refetch } = useCoverageAll();

  const matrix = useMemo(() => {
    if (!data?.rows) return {};
    const m: Record<string, Record<string, { count: number; interpolatedCount: number }>> = {};
    for (const row of data.rows) {
      if (!m[row.symbol]) m[row.symbol] = {};
      m[row.symbol][row.timeframe] = { count: row.count, interpolatedCount: row.interpolatedCount };
    }
    return m;
  }, [data]);

  const symbolsWithData = useMemo(() => {
    const activeFirst = ACTIVE_SYMBOLS.filter(s => ALL_28_SYMBOLS.includes(s));
    const rest = ALL_28_SYMBOLS.filter(s => !ACTIVE_SYMBOLS.includes(s));
    return [...activeFirst, ...rest];
  }, []);

  const statusCls = (count: number, interpCount: number) => {
    if (!count) return "bg-muted/10 text-muted-foreground/30 border-border/10";
    const interpRatio = count > 0 ? interpCount / count : 0;
    if (interpRatio > 0.3) return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    return "bg-green-500/10 text-green-400 border-green-500/20";
  };

  if (isLoading) return <div className="text-center py-12 text-sm text-muted-foreground">Loading multi-timeframe coverage…</div>;
  if (!data) return <p className="text-sm text-muted-foreground">Coverage data unavailable.</p>;

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Database className="w-4 h-4 text-primary" /> Multi-Timeframe Candle Coverage
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            All {symbolsWithData.length} symbols · {ALL_TIMEFRAMES.length} timeframes ·
            <span className="ml-1 text-green-400">■</span> present
            <span className="ml-2 text-amber-400">■</span> &gt;30% interpolated
            <span className="ml-2 text-muted-foreground/30">■</span> absent
          </p>
        </div>
        <button onClick={() => refetch()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground border border-border/40 hover:border-border transition-colors">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] text-muted-foreground uppercase tracking-wide border-b border-border/30 bg-muted/10">
              <th className="text-left py-2 px-4 font-medium sticky left-0 bg-muted/10 z-10">Symbol</th>
              {ALL_TIMEFRAMES.map(tf => (
                <th key={tf} className="text-center py-2 px-2 font-medium whitespace-nowrap">{tf}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbolsWithData.map(sym => {
              const isActive = ACTIVE_SYMBOLS.includes(sym);
              const symData = matrix[sym] ?? {};
              return (
                <tr key={sym} className={cn("border-b border-border/15 hover:bg-muted/10", isActive && "bg-primary/2")}>
                  <td className={cn("py-2 px-4 sticky left-0 z-10", isActive ? "bg-primary/5" : "bg-card")}>
                    <div className="flex items-center gap-1.5">
                      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                      <span className="font-mono font-semibold whitespace-nowrap">{sym}</span>
                    </div>
                  </td>
                  {ALL_TIMEFRAMES.map(tf => {
                    const cell = symData[tf];
                    return (
                      <td key={tf} className="py-2 px-1 text-center">
                        {cell ? (
                          <span className={cn("inline-block px-1.5 py-0.5 rounded border text-[10px] font-mono tabular-nums", statusCls(cell.count, cell.interpolatedCount))}
                            title={`${cell.count.toLocaleString()} candles${cell.interpolatedCount > 0 ? ` (${cell.interpolatedCount} interp)` : ""}`}>
                            {cell.count >= 1_000_000
                              ? `${(cell.count / 1_000_000).toFixed(1)}M`
                              : cell.count >= 1000
                                ? `${(cell.count / 1000).toFixed(0)}k`
                                : cell.count}
                          </span>
                        ) : (
                          <span className="inline-block w-4 h-4 rounded border border-border/15 bg-muted/5" />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {symbolsWithData.length === 0 && (
              <tr>
                <td colSpan={ALL_TIMEFRAMES.length + 1} className="text-center py-10 text-muted-foreground">
                  No candle data found. Run Clean Canonical Data to bootstrap.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DataManager() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ViewTab>("runtime");
  const [symbol, setSymbol] = useState("BOOM300");
  const [liveSubtab, setLiveSubtab] = useState<LiveSubtab>("ticks");

  const { data: diagData, refetch: refetchDiag } = useSymbolDiagnostics();
  const { data: researchData } = useResearchDataStatus();

  const { data: ticks } = useGetTicks(
    { symbol, limit: 30 },
    { query: { queryKey: getGetTicksQueryKey({ symbol, limit: 30 }), enabled: tab === "live" && liveSubtab === "ticks", refetchInterval: 2000 } }
  );
  const { data: candles } = useGetCandles(
    { symbol, timeframe: "M1", limit: 30 },
    { query: { queryKey: getGetCandlesQueryKey({ symbol, timeframe: "M1", limit: 30 }), enabled: tab === "live" && liveSubtab === "candles", refetchInterval: 5000 } }
  );
  const { data: spikes } = useGetSpikeEvents(
    { symbol, limit: 30 },
    { query: { queryKey: getGetSpikeEventsQueryKey({ symbol, limit: 30 }), enabled: tab === "live" && liveSubtab === "spikes", refetchInterval: 5000 } }
  );

  const diagSymbols = diagData?.symbols ?? [];
  const streamingCount = diagSymbols.filter(d => d.streamingState === "streaming").length;
  const activeDiag = ACTIVE_SYMBOLS.map(sym => diagSymbols.find(d => d.symbol === sym)).filter(Boolean) as SymbolDiagnostic[];
  const activeStreamingCount = activeDiag.filter(d => d.streamingState === "streaming").length;
  const activePausedCount = activeDiag.filter(d => d.streamingState === "disabled" || d.streamingState === "available").length;
  const staleActiveCount = activeDiag.filter(d => {
    if (d.streamingState !== "streaming" || !d.lastTick) return false;
    return Date.now() - d.lastTick > 120_000;
  }).length;
  const oldestActiveTickTs = activeDiag
    .map(d => d.lastTick ?? 0)
    .filter(ts => ts > 0)
    .sort((a, b) => a - b)[0] ?? null;

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
    const coverageMap = new Map((researchData?.symbols ?? []).map(s => [s.symbol, s]));
    return ALL_28_SYMBOLS.map(sym => ({
      sym,
      diag: diagMap.get(sym),
      coverage: coverageMap.get(sym),
    }));
  }, [diagSymbols, researchData]);

  const tabs: { id: ViewTab; label: string; icon: React.ElementType }[] = [
    { id: "runtime",   label: "Runtime",          icon: Cpu       },
    { id: "streaming", label: "Symbol State",     icon: Radio     },
    { id: "coverage",  label: "Coverage",         icon: Database  },
    { id: "ops",       label: "Data Operations",  icon: Sparkles  },
    { id: "export",    label: "Export",           icon: Download  },
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
          All 28 symbols · V3 engine features · multi-timeframe coverage · clean canonical data · export
        </p>
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
            <div className="flex items-center gap-2">
              <span className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border",
                staleActiveCount > 0
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                  : "bg-green-500/10 text-green-400 border-green-500/30"
              )}>
                Live {activeStreamingCount}/{ACTIVE_SYMBOLS.length}
                {activePausedCount > 0 && <span className="text-muted-foreground">· paused {activePausedCount}</span>}
              </span>
              <span className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border",
                staleActiveCount > 0
                  ? "bg-red-500/10 text-red-400 border-red-500/30"
                  : "bg-muted/20 text-muted-foreground border-border/40"
              )}>
                {oldestActiveTickTs
                  ? `Oldest tick ${formatAge(new Date(oldestActiveTickTs).toISOString())}`
                  : "No tick data"}
              </span>
              <button onClick={() => refetchDiag()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground border border-border/40 hover:border-border transition-colors">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>
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
              <span className="text-green-400 font-medium">Streaming</span> = active live tick feed ·
              <span className="text-blue-400 font-medium ml-1">Registered</span> = validated with Deriv API and ready for historical data / optional streaming ·
              <span className="text-amber-400 font-medium ml-1">Paused</span> = registered but live streaming intentionally switched off ·
              <span className="ml-1">No data</span> = not yet bootstrapped
            </p>
          </div>
        </div>
      )}

      {/* ── Coverage Tab ── */}
      {tab === "coverage" && <CoverageAllGrid />}

      {/* ── Data Operations ── */}
      {tab === "ops" && (
        <div className="space-y-4">
          <CleanCanonicalTab />
          <HistoricalDownloadCard statusData={researchData} />
        </div>
      )}

      {/* ── Export ── */}
      {tab === "export" && <ExportTab />}

      {/* ── Runtime / Engine State ── */}
      {tab === "runtime" && <RuntimeTab />}

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

