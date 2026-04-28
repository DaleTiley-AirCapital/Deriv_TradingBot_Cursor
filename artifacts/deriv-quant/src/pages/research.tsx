import { useState, useRef, useEffect, useCallback, createContext, useContext, type ReactNode } from "react";
import {
  FlaskConical, Brain, Play, RefreshCw,
  Loader2, CheckCircle, XCircle,
  FileText, Clock, BarChart2, ChevronRight, Download, Activity,
  Target, Zap, TrendingUp, TrendingDown, Search, ChevronDown, ChevronUp, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDurationCompact } from "@/lib/time";

const BASE = import.meta.env.BASE_URL || "/";

function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${BASE}api/${path.replace(/^\//, "")}`, opts).then(async r => {
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const d = await r.json(); msg = d.error ?? d.message ?? msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  });
}

const CALIB_PASS_SESSION_KEY = "deriv_calib_pass_run";

interface PassStatusResult {
  id: number;
  symbol?: string;
  status: string;
  passName?: string | null;
  totalMoves?: number | null;
  processedMoves?: number | null;
  failedMoves?: number | null;
  windowDays?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  errors?: string[];
  errorSummary?: unknown;
  metaJson?: Record<string, unknown> | null;
}

type CalibrationRunContextValue = {
  runId: number | null;
  symbol: string | null;
  status: PassStatusResult | null;
  /** Last finished run (failed/completed/partial) so the UI can still show errors after polling stops. */
  lastTerminalRun: { symbol: string; status: PassStatusResult } | null;
  /** Polling active for an in-flight server run */
  isPassRunActive: boolean;
  beginPassRun: (runId: number, symbol: string) => void;
  /** Stop polling and session if the active run was for this symbol (e.g. DB reset). */
  clearPassRunForSymbol: (symbol: string) => void;
};

const CalibrationRunContext = createContext<CalibrationRunContextValue | null>(null);

function useCalibrationRun(): CalibrationRunContextValue {
  const v = useContext(CalibrationRunContext);
  if (!v) throw new Error("useCalibrationRun: missing provider");
  return v;
}

/** Keeps pass-run polling alive while viewing any Research tab (AI / Backtest / Move Calibration). */
function CalibrationRunProvider({ children }: { children: ReactNode }) {
  const [runId, setRunId] = useState<number | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [status, setStatus] = useState<PassStatusResult | null>(null);
  const [lastTerminalRun, setLastTerminalRun] = useState<{ symbol: string; status: PassStatusResult } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopInterval = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const beginPassRun = useCallback((rid: number, sym: string) => {
    stopInterval();
    try {
      sessionStorage.setItem(CALIB_PASS_SESSION_KEY, JSON.stringify({ runId: rid, symbol: sym }));
    } catch { /* ignore */ }
    setLastTerminalRun(null);
    setRunId(rid);
    setSymbol(sym);
    setStatus(null);
  }, []);

  const clearPassRunForSymbol = useCallback((sym: string) => {
    if (symbol !== sym) return;
    stopInterval();
    try { sessionStorage.removeItem(CALIB_PASS_SESSION_KEY); } catch { /* ignore */ }
    setRunId(null);
    setSymbol(null);
    setStatus(null);
    setLastTerminalRun(prev => (prev?.symbol === sym ? null : prev));
  }, [symbol]);

  // Restore session and drop stale "running" entries
  useEffect(() => {
    (async () => {
      try {
        const raw = sessionStorage.getItem(CALIB_PASS_SESSION_KEY);
        if (!raw) return;
        const p = JSON.parse(raw) as { runId: number; symbol: string };
        const s = (await apiFetch(`calibration/run-status/${p.runId}`)) as PassStatusResult;
        setStatus(s);
        if (s.status === "running") {
          setRunId(p.runId);
          setSymbol(p.symbol);
        } else {
          sessionStorage.removeItem(CALIB_PASS_SESSION_KEY);
          setLastTerminalRun({ symbol: p.symbol, status: s });
        }
      } catch {
        try { sessionStorage.removeItem(CALIB_PASS_SESSION_KEY); } catch { /* ignore */ }
      }
    })();
  }, []);

  useEffect(() => {
    if (!runId) return;

    const tick = async () => {
      try {
        const s = (await apiFetch(`calibration/run-status/${runId}`)) as PassStatusResult;
        setStatus(s);
        const done =
          s.status === "completed" || s.status === "failed" || s.status === "partial";
        if (done) {
          stopInterval();
          try { sessionStorage.removeItem(CALIB_PASS_SESSION_KEY); } catch { /* ignore */ }
          const symForRun = symbol;
          if (symForRun) setLastTerminalRun({ symbol: symForRun, status: s });
          setRunId(null);
          setSymbol(null);
          setStatus(null);
        }
      } catch {
        /* transient network errors  keep polling */
      }
    };

    void tick();
    intervalRef.current = setInterval(tick, 1800);
    return () => stopInterval();
  }, [runId]);

  const value: CalibrationRunContextValue = {
    runId,
    symbol,
    status,
    lastTerminalRun,
    isPassRunActive: runId !== null,
    beginPassRun,
    clearPassRunForSymbol,
  };

  return (
    <CalibrationRunContext.Provider value={value}>
      {children}
    </CalibrationRunContext.Provider>
  );
}

const ALL_SYMBOLS = [
  "BOOM300","CRASH300","R_75","R_100",
  "BOOM1000","CRASH1000","BOOM900","CRASH900","BOOM600","CRASH600","BOOM500","CRASH500",
  "R_10","R_25","R_50","RDBULL","RDBEAR",
  "JD10","JD25","JD50","JD75","JD100",
  "stpRNG","stpRNG2","stpRNG3","stpRNG5","RB100","RB200",
];
const ACTIVE_SYMBOLS = ["CRASH300", "BOOM300", "R_75", "R_100"];
const RESEARCH_ONLY_SYMBOLS = ALL_SYMBOLS.filter((s) => !ACTIVE_SYMBOLS.includes(s));
const BACKTEST_ACTIVE_SYMBOLS = ["all", ...ACTIVE_SYMBOLS];
const BACKTEST_RESEARCH_SYMBOLS = ["all", ...RESEARCH_ONLY_SYMBOLS];
type DomainId = "active" | "research";
const RESEARCH_WINDOWS = [
  { days: 30, label: "1 month" },
  { days: 90, label: "3 months" },
  { days: 180, label: "6 months" },
  { days: 270, label: "9 months" },
  { days: 365, label: "12 months" },
] as const;

function windowLabel(days: number): string {
  return RESEARCH_WINDOWS.find(w => w.days === days)?.label ?? `${days} days`;
}

function getWindowRange(windowDays: number): {
  startTs: number;
  endTs: number;
  startDateStr: string;
  endDateStr: string;
} {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, windowDays) + 1);
  start.setHours(0, 0, 0, 0);
  return {
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000),
    startDateStr: start.toISOString().slice(0, 10),
    endDateStr: end.toISOString().slice(0, 10),
  };
}

function StatusPill({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 border border-green-500/25"><CheckCircle className="w-3 h-3" />{yes}</span>
    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/15 text-red-400 border border-red-500/25"><XCircle className="w-3 h-3" />{no}</span>;
}

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

function SymbolSelect({
  value,
  onChange,
  label,
  symbols = ALL_SYMBOLS,
}: {
  value: string;
  onChange: (s: string) => void;
  label?: string;
  symbols?: string[];
}) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
      >
        {symbols.map(s => (
          <option key={s} value={s}>{s}{ACTIVE_SYMBOLS.includes(s) ? " " : ""}</option>
        ))}
      </select>
    </div>
  );
}

//  AI Analysis Tab 

function AiAnalysisTab({ domain, windowDays }: { domain: DomainId; windowDays: number }) {
  const domainSymbols = domain === "active" ? ACTIVE_SYMBOLS : RESEARCH_ONLY_SYMBOLS;
  const [symbol, setSymbol] = useState(domainSymbols[0] ?? "CRASH300");
  const [running, setRunning] = useState(false);
  const [bgStarted, setBgStarted] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<any | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = async () => {
    try {
      const d = await apiFetch("research/ai-analyze/status");
      setStatus(d);
    } catch {}
  };

  useEffect(() => {
    loadStatus();
    intervalRef.current = setInterval(loadStatus, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  useEffect(() => {
    if (!domainSymbols.includes(symbol)) {
      setSymbol(domainSymbols[0] ?? "CRASH300");
      setResult(null);
    }
  }, [domain, domainSymbols, symbol]);

  const runSync = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const d = await apiFetch("research/ai-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, windowDays }),
      });
      setResult(d.report ?? d);
    } catch (e: any) { setErr(e.message); }
    finally { setRunning(false); }
  };

  const runBackground = async () => {
    setErr(null); setBgStarted(false);
    try {
      await apiFetch("research/ai-analyze/background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, windowDays }),
      });
      setBgStarted(true);
    } catch (e: any) { setErr(e.message); }
  };

  const displayResult = result ?? (status?.lastResult?.[symbol] ?? null);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">AI Research Analysis</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Runs a structured analysis on stored candle data for the selected symbol.
            Extracts swing patterns, move size distribution, frequency, and behavioral drift.
            Produces a research report. <strong className="text-foreground">Sync mode blocks until complete (~10-30s).</strong>
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <SymbolSelect
            value={symbol}
            symbols={domainSymbols}
            onChange={s => { setSymbol(s); setResult(null); }}
            label="Symbol:"
          />
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Window:</span>
            <span className="px-2 py-1 rounded border border-primary/30 bg-primary/10 text-primary">
              {windowLabel(windowDays)} (shared)
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={runSync}
            disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? "Analyzing" : "Run Sync Analysis"}
          </button>
          <button
            onClick={runBackground}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border/50 text-foreground text-xs font-medium hover:border-border hover:bg-muted/30 transition-colors"
          >
            <Clock className="w-3.5 h-3.5" /> Start Background Job
          </button>
          <button onClick={loadStatus}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-border/40 text-muted-foreground text-xs hover:border-border transition-colors">
            <RefreshCw className="w-3 h-3" /> Status
          </button>
        </div>
        {err && <ErrorBox msg={err} />}
        {bgStarted && <SuccessBox msg={`Background analysis started for ${symbol} (${windowDays}d window). Check status panel.`} />}
      </div>

      {status && (
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Background Job Status</h3>
            <StatusPill ok={!status.running} yes="Idle" no="Running" />
          </div>
          {Object.keys(status.lastRun ?? {}).length === 0 ? (
            <p className="text-xs text-muted-foreground">No jobs run yet this session.</p>
          ) : (
            <div className="space-y-1">
              {Object.entries(status.lastRun ?? {}).map(([sym, ts]) => (
                <div key={sym} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-muted-foreground">{sym}</span>
                  <span className="text-foreground">{String(ts)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {displayResult && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold">Research Report  {symbol}</h3>
          </div>
          {typeof displayResult === "string" ? (
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap bg-muted/20 rounded p-3 leading-relaxed max-h-96 overflow-y-auto">
              {displayResult}
            </pre>
          ) : (
            <div className="space-y-2">
              {Object.entries(displayResult).map(([k, v]) => (
                <div key={k} className="flex items-start gap-3 py-1.5 border-b border-border/20 last:border-0">
                  <span className="text-xs text-muted-foreground w-40 shrink-0">{k}</span>
                  <span className="text-xs font-mono text-foreground break-all">{JSON.stringify(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

//  Backtest Tab 

interface V3Trade {
  entryTs: number;
  exitTs: number;
  symbol: string;
  direction: "buy" | "sell";
  engineName: string;
  entryType: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  projectedMovePct: number;
  nativeScore: number;
  scoringSource?: string;
  runtimeModelRunId?: number | null;
  runtimeFamily?: string | null;
  selectedBucket?: string | null;
  qualityTier?: string | null;
  confidence?: number | null;
  setupMatch?: number | null;
  trailingActivationPct?: number | null;
  trailingDistancePct?: number | null;
  trailingMinHoldBars?: number | null;
  trailingActivated?: boolean;
  regimeAtEntry: string;
  holdBars: number;
  pnlPct: number;
  leg1Hit: boolean;
  mfePct: number;
  maePct: number;
}

interface V3Summary {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  totalPnlPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgHoldBars: number;
  leg1HitRate: number;
  byEngine: Record<string, { count: number; wins: number; avgPnlPct: number }>;
  byExitReason: Record<string, number>;
}

type BacktestTierMode = "A" | "AB" | "ABC" | "ALL";

const BACKTEST_TIER_MODES: Array<{ value: BacktestTierMode; label: string }> = [
  { value: "A", label: "A only" },
  { value: "AB", label: "A+B" },
  { value: "ABC", label: "A+B+C" },
  { value: "ALL", label: "All tiers" },
];

interface V3Result {
  symbol: string;
  tierMode?: BacktestTierMode;
  startTs: number;
  endTs: number;
  totalBars: number;
  runtimeModel?: {
    enabled?: boolean;
    applied?: boolean;
    reason?: string;
    useCalibratedRuntimeProfiles?: boolean;
    mode?: string | null;
    source?: string | null;
    sourceRunId?: number | null;
    entryModel?: string | null;
    tpBucketCount?: number;
    dynamicTpEnabled?: boolean;
    scoringSourceCounts?: Record<string, number>;
  };
  trades: V3Trade[];
  moveOverlap?: {
    movesInWindow: number;
    capturedMoves: number;
    missedMoves: number;
    captureRate: number;
    ghostTrades: number;
    ghostTradeRate: number;
  };
  summary: V3Summary;
}

interface PersistedV3BacktestHistoryRun {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  mode: string;
  tierMode: BacktestTierMode;
  runtimeModelRunId: number | null;
  summary: V3Summary;
  createdAt: string;
}

function isValidV3ResultShape(value: unknown): value is V3Result {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<V3Result>;
  return (
    typeof r.symbol === "string" &&
    Array.isArray(r.trades) &&
    typeof r.summary === "object" &&
    r.summary != null &&
    typeof r.totalBars === "number"
  );
}

function pct(v: number) {
  return (v * 100).toFixed(2) + "%";
}

function formatTs(ts: number) {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function holdLabel(bars: number) {
  const hours = bars / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function ExitReasonBadge({ reason }: { reason: string }) {
  const colors: Record<string, string> = {
    leg1_tp: "bg-green-500/15 text-green-400 border-green-500/25",
    hard_sl: "bg-red-500/15 text-red-400 border-red-500/25",
    mfe_reversal: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    trailing_stop: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    tp_hit: "bg-green-500/15 text-green-400 border-green-500/25",
    sl_hit: "bg-red-500/15 text-red-400 border-red-500/25",
    max_duration: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  };
  const labels: Record<string, string> = {
    tp_hit: "TP Hit",
    sl_hit: "SL Hit",
    trailing_stop: "Trailing Stop",
    max_duration: "Max Duration",
    leg1_tp: "Leg 1 TP",
    hard_sl: "Hard SL",
    mfe_reversal: "MFE Reversal",
  };
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium border", colors[reason] ?? "bg-muted/30 text-muted-foreground border-border/30")}>
      {labels[reason] ?? reason.replace(/_/g, " ")}
    </span>
  );
}

function exitReasonSortValue(reason: string): number {
  const order = ["tp_hit", "trailing_stop", "sl_hit", "max_duration"];
  const idx = order.indexOf(reason);
  return idx >= 0 ? idx : order.length;
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-lg bg-muted/20 border border-border/30">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-sm font-semibold font-mono">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function summarizeBacktestGroup(results: Record<string, V3Result>) {
  const rows = Object.values(results);
  const totals = rows.reduce((acc, result) => {
    const s = result.summary;
    acc.trades += s.tradeCount;
    acc.wins += s.winCount;
    acc.losses += s.lossCount;
    acc.totalPnlPct += s.totalPnlPct;
    acc.maxDrawdownPct = Math.max(acc.maxDrawdownPct, s.maxDrawdownPct);
    if (Number.isFinite(s.profitFactor)) {
      acc.profitFactorSum += s.profitFactor;
      acc.profitFactorCount += 1;
    }
    for (const [reason, count] of Object.entries(s.byExitReason ?? {})) {
      acc.exits[reason] = (acc.exits[reason] ?? 0) + count;
    }
    const overlap = result.moveOverlap;
    if (overlap) {
      acc.movesInWindow += overlap.movesInWindow;
      acc.capturedMoves += overlap.capturedMoves;
      acc.missedMoves += overlap.missedMoves;
      acc.ghostTrades += overlap.ghostTrades;
    }
    return acc;
  }, {
    trades: 0,
    wins: 0,
    losses: 0,
    totalPnlPct: 0,
    maxDrawdownPct: 0,
    profitFactorSum: 0,
    profitFactorCount: 0,
    exits: {} as Record<string, number>,
    movesInWindow: 0,
    capturedMoves: 0,
    missedMoves: 0,
    ghostTrades: 0,
  });

  return {
    ...totals,
    winRate: totals.trades > 0 ? totals.wins / totals.trades : 0,
    profitFactor: totals.profitFactorCount > 0 ? totals.profitFactorSum / totals.profitFactorCount : 0,
    captureRate: totals.movesInWindow > 0 ? totals.capturedMoves / totals.movesInWindow : 0,
    ghostTradeRate: totals.trades > 0 ? totals.ghostTrades / totals.trades : 0,
  };
}

function SymbolBacktestSection({ result }: { result: V3Result }) {
  const s = result.summary;
  const trades = result.trades;
  const [showAll, setShowAll] = useState(false);
  const displayTrades = showAll ? trades : trades.slice(0, 30);
  const runtime = result.runtimeModel;
  const scoringCounts = runtime?.scoringSourceCounts ?? {};
  const runtimeApplied = runtime?.applied ?? runtime?.enabled ?? false;
  const runtimeReason = runtime?.reason ?? "unknown";
  const overlap = result.moveOverlap;

  return (
    <div className="space-y-4">
      {/* Summary grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SummaryCard label="Trades" value={String(s.tradeCount)} sub={`${s.winCount}W / ${s.lossCount}L`} />
        <SummaryCard label="Win rate" value={pct(s.winRate)} />
        <SummaryCard label="Avg P&L" value={pct(s.avgPnlPct)} />
        <SummaryCard label="Total P&L" value={pct(s.totalPnlPct)} />
        <SummaryCard label="Profit factor" value={isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : ""} />
        <SummaryCard label="Max drawdown" value={pct(s.maxDrawdownPct)} />
        <SummaryCard label="Avg hold" value={holdLabel(s.avgHoldBars)} />
        <SummaryCard label="Leg1 hit rate" value={pct(s.leg1HitRate)} />
      </div>

      <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-xs">
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <span>
            <span className="text-muted-foreground">Runtime model: </span>
            <span className={runtimeApplied ? "text-emerald-300 font-semibold" : "text-red-300 font-semibold"}>
              {runtimeApplied ? runtime?.source ?? "enabled" : "not applied"}
            </span>
          </span>
          <span><span className="text-muted-foreground">Reason: </span>{runtimeReason.replace(/_/g, " ")}</span>
          <span>
            <span className="text-muted-foreground">Setting: </span>
            <span className={runtime?.useCalibratedRuntimeProfiles ? "text-emerald-300" : "text-red-300"}>
              use_calibrated_runtime_profiles={String(runtime?.useCalibratedRuntimeProfiles ?? false)}
            </span>
          </span>
          <span><span className="text-muted-foreground">Run: </span>{runtime?.sourceRunId ?? "none"}</span>
          <span><span className="text-muted-foreground">Entry: </span>{runtime?.entryModel ?? "native"}</span>
          <span><span className="text-muted-foreground">Tier mode: </span>{result.tierMode ?? "ALL"}</span>
          <span>
            <span className="text-muted-foreground">TP buckets: </span>
            <span className={runtime?.dynamicTpEnabled ? "text-emerald-300" : "text-amber-300"}>
              {runtime?.tpBucketCount ?? 0}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">Scoring: </span>
            {Object.keys(scoringCounts).length > 0
              ? Object.entries(scoringCounts).map(([k, v]) => `${k}=${v}`).join(", ")
              : "no signals"}
          </span>
        </div>
        {!runtimeApplied && (
          <div className="mt-2 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-red-200">
            This run is not testing the promoted calibration model. Results are legacy/native until the runtime reason is "applied".
          </div>
        )}
      </div>

      {overlap && (
        <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              <span className="text-muted-foreground">Move capture: </span>
              <span className={overlap.captureRate >= 0.8 ? "text-emerald-300 font-semibold" : "text-amber-300 font-semibold"}>
                {overlap.capturedMoves}/{overlap.movesInWindow} ({pct(overlap.captureRate)})
              </span>
            </span>
            <span><span className="text-muted-foreground">Missed moves: </span>{overlap.missedMoves}</span>
            <span>
              <span className="text-muted-foreground">Outside calibrated moves: </span>
              <span className={overlap.ghostTradeRate <= 0.2 ? "text-emerald-300" : "text-red-300"}>
                {overlap.ghostTrades} ({pct(overlap.ghostTradeRate)})
              </span>
            </span>
          </div>
        </div>
      )}

      {/* By engine */}
      {Object.keys(s.byEngine).length > 0 && (
        <div className="rounded-lg border border-border/30 overflow-hidden">
          <div className="px-3 py-2 bg-muted/10 border-b border-border/20">
            <span className="text-[11px] font-medium text-muted-foreground">By engine</span>
          </div>
          <div className="divide-y divide-border/20">
            {Object.entries(s.byEngine).map(([engine, stats]) => (
              <div key={engine} className="px-3 py-2 flex items-center justify-between text-xs">
                <span className="font-mono text-muted-foreground truncate">{engine}</span>
                <div className="flex items-center gap-4 shrink-0">
                  <span>{stats.count} trades</span>
                  <span>{stats.wins}W</span>
                  <span className={stats.avgPnlPct >= 0 ? "text-green-400" : "text-red-400"}>
                    avg {pct(stats.avgPnlPct)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By exit reason */}
      {Object.keys(s.byExitReason).length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">Exits:</span>
          {Object.entries(s.byExitReason)
            .sort(([a], [b]) => exitReasonSortValue(a) - exitReasonSortValue(b))
            .map(([reason, count]) => (
            <span key={reason} className="flex items-center gap-1">
              <ExitReasonBadge reason={reason} />
              <span className="text-[10px] text-muted-foreground">{count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Trades table */}
      {trades.length > 0 && (
        <div className="rounded-lg border border-border/30 overflow-hidden">
          <div className="px-3 py-2 bg-muted/10 border-b border-border/20 flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              Trades ({trades.length})
            </span>
            {trades.length > 30 && (
              <button
                onClick={() => setShowAll(v => !v)}
                className="text-[11px] text-primary hover:underline"
              >
                {showAll ? "Show top 30" : `Show all ${trades.length}`}
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="border-b border-border/20 bg-muted/5 text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">Dir</th>
                  <th className="px-2 py-1.5 text-left font-medium">Engine</th>
                  <th className="px-2 py-1.5 text-left font-medium">Scoring</th>
                  <th className="px-2 py-1.5 text-left font-medium">Entry</th>
                  <th className="px-2 py-1.5 text-left font-medium">Exit</th>
                  <th className="px-2 py-1.5 text-right font-medium">Hold</th>
                  <th className="px-2 py-1.5 text-right font-medium">Entry $</th>
                  <th className="px-2 py-1.5 text-right font-medium">Exit $</th>
                  <th className="px-2 py-1.5 text-right font-medium">MFE</th>
                  <th className="px-2 py-1.5 text-right font-medium">MAE</th>
                  <th className="px-2 py-1.5 text-center font-medium">Exit</th>
                  <th className="px-2 py-1.5 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/10">
                {displayTrades.map((t, i) => (
                  <tr key={i} className="hover:bg-muted/10 transition-colors">
                    <td className="px-2 py-1.5">
                      <span className={cn("px-1 py-0.5 rounded text-[10px] font-medium",
                        t.direction === "buy" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400")}>
                        {t.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground max-w-[120px] truncate" title={t.engineName}>
                      {t.engineName.replace(/_engine$/, "").replace(/_/g, " ")}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground max-w-[140px] truncate" title={t.scoringSource ?? "native_engine"}>
                      {(t.scoringSource ?? "native_engine").replace(/_/g, " ")}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{formatTs(t.entryTs)}</td>
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{formatTs(t.exitTs)}</td>
                    <td className="px-2 py-1.5 text-right">{holdLabel(t.holdBars)}</td>
                    <td className="px-2 py-1.5 text-right">{t.entryPrice.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right">{t.exitPrice.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right text-green-400">{pct(t.mfePct)}</td>
                    <td className="px-2 py-1.5 text-right text-red-400">{pct(t.maePct)}</td>
                    <td className="px-2 py-1.5 text-center"><ExitReasonBadge reason={t.exitReason} /></td>
                    <td className={cn("px-2 py-1.5 text-right font-semibold",
                      t.pnlPct >= 0 ? "text-green-400" : "text-red-400")}>
                      {t.pnlPct >= 0 ? "+" : ""}{pct(t.pnlPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function BacktestTab({ domain, windowDays }: { domain: DomainId; windowDays: number }) {
  const backtestSymbols = domain === "active" ? BACKTEST_ACTIVE_SYMBOLS : BACKTEST_RESEARCH_SYMBOLS;

  const [symbol, setSymbol] = useState(backtestSymbols[0] ?? "all");
  const [tierMode, setTierMode] = useState<BacktestTierMode>("ALL");
  const [running, setRunning] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<Record<string, V3Result> | null>(null);
  const [tierSweep, setTierSweep] = useState<Record<BacktestTierMode, Record<string, V3Result>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [historyRuns, setHistoryRuns] = useState<PersistedV3BacktestHistoryRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<number | null>(null);
  const [latestPersistedRunIds, setLatestPersistedRunIds] = useState<Record<string, number>>({});
  const [historyRunLoadError, setHistoryRunLoadError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  useEffect(() => {
    if (!backtestSymbols.includes(symbol)) {
      setSymbol(backtestSymbols[0] ?? "all");
    }
  }, [domain, backtestSymbols, symbol]);

  const loadBacktestHistory = async (sym = symbol, silent = false) => {
    if (!sym || sym === "all") {
      setHistoryRuns([]);
      return;
    }
    if (!silent) setHistoryLoading(true);
    try {
      const d = await apiFetch(`backtest/v3/history?symbol=${encodeURIComponent(sym)}&limit=30`) as { runs?: PersistedV3BacktestHistoryRun[] };
      setHistoryRuns(Array.isArray(d.runs) ? d.runs : []);
    } catch {
      if (!silent) setHistoryRuns([]);
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  };

  const loadBacktestHistoryRun = async (runId: number) => {
    setErr(null);
    setHistoryRunLoadError(null);
    setSelectedHistoryRunId(runId);
    try {
      const d = await apiFetch(`backtest/v3/history/${runId}`) as { run?: { symbol?: string; result?: V3Result } };
      const run = d.run;
      if (!run?.symbol || !isValidV3ResultShape(run.result)) {
        throw new Error(`Run ${runId} has malformed or empty persisted result data.`);
      }
      const selectedSymbol = String(run.symbol);
      setSymbol(selectedSymbol);
      setTierMode(run.result.tierMode ?? "ALL");
      setResults({ [selectedSymbol]: run.result });
      setTierSweep(null);
    } catch (e: any) {
      const msg = e?.message ?? "Failed to load selected backtest run";
      setHistoryRunLoadError(msg);
      setErr(msg);
      setResults(null);
      setTierSweep(null);
    }
  };

  useEffect(() => {
    void loadBacktestHistory(symbol);
  }, [symbol]);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setHistoryRunLoadError(null);
    setResults(null);
    setTierSweep(null);
    setElapsed(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      const { startTs, endTs } = getWindowRange(windowDays);
      const body: Record<string, unknown> = { symbol, startTs, endTs, tierMode };

      const d = await apiFetch("backtest/v3/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setResults(d.results as Record<string, V3Result>);
      setLatestPersistedRunIds((d.persistedRunIds as Record<string, number> | undefined) ?? {});
      await loadBacktestHistory(symbol, true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const runTierSweep = async () => {
    setSweeping(true);
    setErr(null);
    setHistoryRunLoadError(null);
    setResults(null);
    setTierSweep(null);
    setElapsed(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      const { startTs, endTs } = getWindowRange(windowDays);
      const sweep = {} as Record<BacktestTierMode, Record<string, V3Result>>;

      for (const mode of BACKTEST_TIER_MODES.map(item => item.value)) {
        const d = await apiFetch("backtest/v3/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol, startTs, endTs, tierMode: mode }),
        });
        sweep[mode] = d.results as Record<string, V3Result>;
        setLatestPersistedRunIds((d.persistedRunIds as Record<string, number> | undefined) ?? {});
      }

      setTierSweep(sweep);
      setResults(sweep[tierMode] ?? sweep.ALL);
      await loadBacktestHistory(symbol, true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSweeping(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const totalTrades = results
    ? Object.values(results).reduce((s, r) => s + r.trades.length, 0)
    : null;

  function downloadJson(data: unknown, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportSummary() {
    if (!results) return;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const summary = {
      exported_at: new Date().toISOString(),
      params: { symbol, tierMode, ...getWindowRange(windowDays), scoreGate: "runtime-platform-state" },
      symbols: Object.fromEntries(
        Object.entries(results).map(([sym, r]) => [sym, {
          totalBars: r.totalBars,
          runtimeModel: r.runtimeModel ?? null,
          totalTrades: r.trades.length,
          wins: r.trades.filter(t => t.pnlPct > 0).length,
          losses: r.trades.filter(t => t.pnlPct <= 0).length,
          winRate: r.trades.length > 0
            ? +((r.trades.filter(t => t.pnlPct > 0).length / r.trades.length) * 100).toFixed(1)
            : 0,
          avgPnlPct: r.trades.length > 0
            ? +(r.trades.reduce((s, t) => s + t.pnlPct, 0) / r.trades.length).toFixed(2)
            : 0,
          avgScore: r.trades.length > 0
            ? +(r.trades.reduce((s, t) => s + (t.nativeScore ?? 0), 0) / r.trades.length).toFixed(1)
            : 0,
          bestTrade: r.trades.length > 0
            ? +(Math.max(...r.trades.map(t => t.pnlPct))).toFixed(2)
            : 0,
          worstTrade: r.trades.length > 0
            ? +(Math.min(...r.trades.map(t => t.pnlPct))).toFixed(2)
            : 0,
        }])
      ),
    };
    downloadJson(summary, `bt-summary-${timestamp}.json`);
  }

  function exportTrades() {
    if (!results) return;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const allTrades = Object.entries(results).flatMap(([sym, r]) =>
      r.trades.map(t => ({ ...t, symbol: sym }))
    ).sort((a, b) => (a.entryTs ?? 0) - (b.entryTs ?? 0));
    downloadJson({
      exported_at: new Date().toISOString(),
      params: { symbol, tierMode, ...getWindowRange(windowDays), scoreGate: "runtime-platform-state" },
      total_trades: allTrades.length,
      trades: allTrades,
    }, `bt-trades-${timestamp}.json`);
  }

  async function exportSignals() {
    setErr(null);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const { startTs, endTs } = getWindowRange(windowDays);
    const params = new URLSearchParams({ startTs: String(startTs), endTs: String(endTs) });
    // "all" is the sentinel value for all-symbols mode; do not send it as a symbol filter
    const isAllSymbols = !symbol || symbol === "all";
    if (!isAllSymbols) params.set("symbol", symbol);
    try {
      const data = await apiFetch(`signals/export?${params.toString()}`);
      const result = data as { truncated?: boolean; count: number; note?: string };
      if (result.truncated) {
        setErr(`Signal export capped at ${result.count} rows. ${result.note ?? ""}`);
      }
      downloadJson(data, `signals-export-${isAllSymbols ? "all" : symbol}-${timestamp}.json`);
    } catch (e: any) {
      setErr(`Signal export failed: ${e?.message ?? "Unknown error"}`);
    }
  }

  async function exportAttribution() {
    if (symbol !== "CRASH300") {
      setErr("Trade-outcome attribution export is currently available for CRASH300 only.");
      return;
    }
    const runId = selectedHistoryRunId ?? latestPersistedRunIds.CRASH300;
    if (!runId) {
      setErr("Run a CRASH300 backtest or select a persisted CRASH300 run before exporting attribution.");
      return;
    }
    try {
      setErr(null);
      const data = await apiFetch(`backtest/v3/history/${runId}/attribution`) as { report?: unknown };
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      downloadJson(data.report ?? data, `bt-attribution-CRASH300-${timestamp}.json`);
    } catch (e: any) {
      setErr(`Attribution export failed: ${e?.message ?? "Unknown error"}`);
    }
  }

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">V3 Isolated Backtest Engine</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Replays historical 1m candles through the live V3 engines (CRASH300, BOOM300, R_75, R_100) with a hybrid exit model.
            Spike hazard is set to neutral  a conservative assumption for backtesting. All scoring and engine logic is identical to live.
            <strong className="text-foreground"> Running all symbols over {windowLabel(windowDays)} takes ~60s.</strong>
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Symbol</label>
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {backtestSymbols.map(s => (
                <option key={s} value={s}>
                  {s === "all"
                    ? `All (${domain === "active" ? "active symbols" : "new symbols"})`
                    : s}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Window</label>
            <div className="w-full text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">
              {windowLabel(windowDays)} (shared)
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Range</label>
            <div className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground font-mono">
              {getWindowRange(windowDays).startDateStr}  {getWindowRange(windowDays).endDateStr}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Tier mode</label>
            <select
              value={tierMode}
              onChange={e => setTierMode(e.target.value as BacktestTierMode)}
              className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {BACKTEST_TIER_MODES.map(mode => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Backtest Runs</label>
            <select
              value={selectedHistoryRunId ? String(selectedHistoryRunId) : ""}
              onChange={e => {
                const next = Number(e.target.value);
                if (Number.isInteger(next) && next > 0) {
                  void loadBacktestHistoryRun(next);
                } else {
                  setSelectedHistoryRunId(null);
                }
              }}
              disabled={symbol === "all" || historyLoading || historyRuns.length === 0}
              className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-60"
            >
              <option value="">
                {symbol === "all"
                  ? "Select a symbol to view run history"
                  : historyLoading
                    ? "Loading run history..."
                    : historyRuns.length === 0
                      ? "No persisted runs yet"
                      : "Choose a previous run"}
              </option>
              {historyRuns.map(run => (
                <option key={run.id} value={String(run.id)}>
                  #{run.id}  {new Date(run.createdAt).toLocaleString()}  {pct(Number(run.summary?.winRate ?? 0))} WR  PF {Number(run.summary?.profitFactor ?? 0).toFixed(2)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">History Refresh</label>
            <button
              onClick={() => void loadBacktestHistory(symbol)}
              disabled={historyLoading || symbol === "all"}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-border/50 text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors disabled:opacity-50"
            >
              {historyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Refresh Backtest Runs
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={run}
            disabled={running || sweeping}
            className="flex items-center gap-1.5 px-4 py-2 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {running
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <BarChart2 className="w-3.5 h-3.5" />}
            {running ? `Running ${formatDurationCompact(elapsed)}` : "Run Backtest"}
          </button>

          <button
            onClick={runTierSweep}
            disabled={running || sweeping}
            className="flex items-center gap-1.5 px-4 py-2 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 text-xs font-medium hover:bg-cyan-500/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {sweeping
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <BarChart2 className="w-3.5 h-3.5" />}
            {sweeping ? `Sweeping ${formatDurationCompact(elapsed)}` : "Run Tier Sweep"}
          </button>

          {results !== null && totalTrades !== null && totalTrades > 0 && (
            <>
              <button
                onClick={exportSummary}
                className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Export Summary JSON
              </button>
              <button
                onClick={exportTrades}
                className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Export Trades JSON
              </button>
              {symbol === "CRASH300" && (
                <button
                  onClick={() => void exportAttribution()}
                  className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
                  title="Export deterministic CRASH300 trade-outcome attribution for the selected or latest persisted backtest run"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export Attribution JSON
                </button>
              )}
            </>
          )}

          {/* Signals export is gated only on valid date inputs  includes blocked + allowed, not just executed trades */}
          {windowDays > 0 && (
            <button
              onClick={exportSignals}
              className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
              title="Export all live signal decisions (allowed + blocked + executed) for the selected date range from the signal log"
            >
              <Download className="w-3.5 h-3.5" />
              Export Signals JSON
            </button>
          )}

          {(running || sweeping) && (
            <p className="text-xs text-muted-foreground">
              Loading candles and replaying bars  this may take up to 2 minutes for all symbols.
            </p>
          )}
        </div>

        {err && <ErrorBox msg={err} />}
        {historyRunLoadError && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-amber-200">Backtest run could not be loaded</p>
            <p className="text-[11px] text-amber-100/90 mt-1">
              {historyRunLoadError}
            </p>
            <p className="text-[11px] text-amber-100/80 mt-1">
              Select another run or execute a fresh backtest to regenerate valid artifacts.
            </p>
          </div>
        )}
      </div>

      {/* Results */}
      {results !== null && (
        <div className="space-y-5">
          {tierSweep && (
            <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-4 overflow-x-auto">
              <h3 className="text-sm font-semibold text-cyan-100 mb-3">Tier Sweep Comparison</h3>
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="text-muted-foreground border-b border-cyan-500/20">
                    <th className="text-left py-2 pr-3 font-medium">Mode</th>
                    <th className="text-right py-2 px-3 font-medium">Trades</th>
                    <th className="text-right py-2 px-3 font-medium">Win rate</th>
                    <th className="text-right py-2 px-3 font-medium">Total P&L</th>
                    <th className="text-right py-2 px-3 font-medium">Drawdown</th>
                    <th className="text-right py-2 px-3 font-medium">PF</th>
                    <th className="text-right py-2 px-3 font-medium">Captured</th>
                    <th className="text-right py-2 px-3 font-medium">Ghost</th>
                    <th className="text-left py-2 pl-3 font-medium">Exits</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cyan-500/10">
                  {BACKTEST_TIER_MODES.map(mode => {
                    const summary = summarizeBacktestGroup(tierSweep[mode.value] ?? {});
                    return (
                      <tr key={mode.value} className={mode.value === tierMode ? "bg-cyan-500/10" : ""}>
                        <td className="py-2 pr-3 font-semibold text-cyan-100">{mode.label}</td>
                        <td className="py-2 px-3 text-right">{summary.trades}</td>
                        <td className="py-2 px-3 text-right">{pct(summary.winRate)}</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", summary.totalPnlPct >= 0 ? "text-green-400" : "text-red-400")}>
                          {summary.totalPnlPct >= 0 ? "+" : ""}{pct(summary.totalPnlPct)}
                        </td>
                        <td className="py-2 px-3 text-right">{pct(summary.maxDrawdownPct)}</td>
                        <td className="py-2 px-3 text-right">{summary.profitFactor.toFixed(2)}</td>
                        <td className="py-2 px-3 text-right">
                          {summary.capturedMoves}/{summary.movesInWindow} ({pct(summary.captureRate)})
                        </td>
                        <td className="py-2 px-3 text-right">
                          {summary.ghostTrades} ({pct(summary.ghostTradeRate)})
                        </td>
                        <td className="py-2 pl-3">
                          {Object.entries(summary.exits)
                            .sort(([a], [b]) => exitReasonSortValue(a) - exitReasonSortValue(b))
                            .map(([reason, count]) => `${reason}:${count}`)
                            .join("  ")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {totalTrades === 0 ? (
            <div className="rounded-xl border border-border/30 bg-card p-6 text-center">
              <BarChart2 className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">0 trades returned</p>
              <p className="text-xs text-muted-foreground mt-1">
                No signals passed engine gates in the selected range ({getWindowRange(windowDays).startDateStr}  {getWindowRange(windowDays).endDateStr}).
                Check the runtime wiring, promoted model, and mode/symbol settings before changing engine logic.
              </p>
            </div>
          ) : (
            Object.entries(results).map(([sym, result]) => (
              result.trades.length > 0 && (
                <div key={sym} className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
                  <div className="flex items-center gap-2 border-b border-border/20 pb-3">
                    <ChevronRight className="w-4 h-4 text-primary" />
                    <h3 className="text-sm font-semibold">{sym}</h3>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {result.totalBars.toLocaleString()} bars  {result.trades.length} trades
                    </span>
                  </div>
                  <SymbolBacktestSection result={result} />
                </div>
              )
            ))
          )}

          {/* Symbols with 0 trades */}
          {Object.entries(results).filter(([, r]) => r.trades.length === 0).map(([sym, r]) => (
            <div key={sym} className="rounded-xl border border-border/30 bg-card p-3 flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground">{sym}</span>
              <span className="text-xs text-muted-foreground">
                 {r.totalBars.toLocaleString()} bars processed, 0 trades
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

//  Move Calibration support types 

interface BehaviorOverview {
  symbol: string;
  totalTrades: number;
  totalSignalsFired: number;
  totalBlocked: number;
  overallWinRate: number;
  overallBlockedRate: number;
  recommendedScanCadenceMins: number;
  lastUpdated: string;
  engineProfiles?: Array<{
    engineName: string;
    tradeCount: number;
    winRate: number;
    avgPnlPct: number;
    signalFrequencyPerDay: number;
    sampleDays: number;
  }>;
}

interface ProfitabilityPath {
  name: string;
  estimatedMonthlyReturnPct: number;
  captureablePct: number;
  holdDays: number;
  confidence: string;
}

interface CalibrationProfile {
  id: number;
  symbol: string;
  moveType: string;
  windowDays: number;
  targetMoves: number;
  capturedMoves: number;
  missedMoves: number;
  fitScore: number;
  missReasons: Array<{ reason: string; count: number }> | null;
  avgMovePct: number;
  medianMovePct: number;
  avgHoldingHours: number;
  avgCaptureablePct: number;
  avgHoldabilityScore: number;
  engineCoverage: unknown | null;
  precursorSummary: unknown | null;
  triggerSummary: unknown | null;
  feeddownSchema: unknown | null;
  profitabilitySummary: {
    paths: ProfitabilityPath[];
    topPath: string;
    estimatedFitAdjustedReturn: number;
  } | null;
  lastRunId: number | null;
  generatedAt: string;
}

interface PassRun {
  id: number;
  symbol: string;
  passName: string;
  status: string;
  totalMoves: number;
  processedMoves: number;
  failedMoves: number;
  windowDays: number;
  startedAt: string;
  completedAt?: string | null;
  metaJson?: Record<string, unknown> | null;
}

interface SymbolResearchProfileUi {
  lastRunId?: number;
  moveCount?: number;
  moveFamilyDistribution?: Record<string, number>;
  estimatedTradesPerMonth?: number;
  recommendedHoldProfile?: Record<string, unknown>;
  recommendedScanIntervalSeconds?: number;
  recommendedEntryModel?: string;
  recommendedTpModel?: Record<string, unknown>;
  recommendedSlModel?: Record<string, unknown>;
  recommendedTrailingModel?: Record<string, unknown>;
  estimatedFitAdjustedMonthlyReturnPct?: number;
  engineTypeRecommendation?: string;
  researchStatus?: string;
}

interface RuntimeSymbolModelUi {
  sourceRunId?: number;
  entryModel?: string;
  tpModel?: Record<string, unknown>;
  recommendedScoreGates?: Record<string, number>;
  expectedTradesPerMonth?: number;
  recommendedScanIntervalSeconds?: number;
  promotedAt?: string;
  suggestedAt?: string;
}

interface RuntimeModelStateUi {
  researchProfile?: SymbolResearchProfileUi | null;
  stagedModel?: RuntimeSymbolModelUi | null;
  promotedModel?: RuntimeSymbolModelUi | null;
  lifecycle?: {
    hasResearchProfile?: boolean;
    hasStagedModel?: boolean;
    hasPromotedModel?: boolean;
    latestRunId?: number | null;
    stagedRunId?: number | null;
    promotedRunId?: number | null;
    runtimeSource?: string;
    stagedAt?: string | null;
    promotedAt?: string | null;
    stagedOptimisationRunId?: number | null;
    promotedOptimisationRunId?: number | null;
    stagedOptimisationCandidateId?: number | null;
    promotedOptimisationCandidateId?: number | null;
    promotedMatchesStaged?: boolean;
    stagedTpBucketCount?: number;
    promotedTpBucketCount?: number;
    stagedDynamicTpEnabled?: boolean;
    promotedDynamicTpEnabled?: boolean;
    driftPendingPromotion?: boolean;
  };
}

interface ParityDiagnosticsUi {
  failureReasonCounts?: Record<string, number>;
  selectedRuntimeFamilyCounts?: Record<string, number>;
  selectedBucketCounts?: Record<string, number>;
  directionMatrixCounts?: Record<string, number>;
  noCoordinatorOutput?: number;
  runtimeCalibratedSetupWeak?: number;
  gateComponentFailures?: Record<string, number>;
}

interface ParityReportUi {
  generatedAt?: string;
  promotedModelRunId?: number | null;
  stagedModelRunId?: number | null;
  totals?: {
    totalMoves?: number;
    matchedMoves?: number;
    noCandidate?: number;
    familyMismatch?: number;
    directionMismatch?: number;
    bucketMismatch?: number;
    setupEvidenceFailed?: number;
    runtimeModelMissing?: number;
    invalidRuntimeModel?: number;
  };
  diagnostics?: ParityDiagnosticsUi;
  verdicts?: Array<Record<string, unknown>>;
}

//  Move Calibration Tab 

const CALIB_ACTIVE_SYMBOLS = [...ACTIVE_SYMBOLS];
const CALIB_RESEARCH_SYMBOLS = [...RESEARCH_ONLY_SYMBOLS];
const PASS_NAMES = ["all", "enrichment", "family_inference", "model_synthesis"];
const MOVE_TYPES_FILTER_GENERIC = [
  "all",
  "breakout",
  "continuation",
  "reversal",
  "spike_cluster_recovery",
  "exhaustion",
  "drift_recovery",
  "uncategorized_emerging_pattern",
  "unknown",
];
function moveTypesFilterForSymbol(sym: string): string[] {
  if (sym === "BOOM300") return ["all", "boom_expansion"];
  if (sym === "CRASH300") return ["all", "crash_expansion"];
  return MOVE_TYPES_FILTER_GENERIC;
}
function strategyFamiliesForSymbol(sym: string): string[] {
  if (sym === "BOOM300") return ["all", "boom_expansion"];
  if (sym === "CRASH300") return ["all", "crash_expansion"];
  return [
    "all",
    "reversal",
    "continuation",
    "breakout",
    "spike_cluster_recovery",
    "exhaustion",
    "drift_recovery",
    "uncategorized_emerging_pattern",
  ];
}
const TIERS = ["A", "B", "C", "D"];
const TIER_COLORS: Record<string, string> = {
  A: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
  B: "text-sky-400 bg-sky-500/10 border-sky-500/25",
  C: "text-amber-400 bg-amber-500/10 border-amber-500/25",
  D: "text-red-400 bg-red-500/10 border-red-500/25",
};
const TYPE_COLORS: Record<string, string> = {
  breakout:     "text-purple-400 bg-purple-500/10 border-purple-500/25",
  continuation: "text-sky-400 bg-sky-500/10 border-sky-500/25",
  reversal:     "text-amber-400 bg-amber-500/10 border-amber-500/25",
  unknown:      "text-muted-foreground bg-muted/20 border-border/30",
  boom_expansion: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
  crash_expansion: "text-rose-400 bg-rose-500/10 border-rose-500/25",
  spike_cluster_recovery: "text-indigo-300 bg-indigo-500/10 border-indigo-500/25",
  exhaustion: "text-orange-300 bg-orange-500/10 border-orange-500/25",
  drift_recovery: "text-cyan-300 bg-cyan-500/10 border-cyan-500/25",
  uncategorized_emerging_pattern: "text-slate-300 bg-slate-500/10 border-slate-500/25",
};

function formatMoveTypeLabel(type: string): string {
  if (type === "boom_expansion") return "Boom Expansion";
  if (type === "crash_expansion") return "Crash Expansion";
  if (type === "spike_cluster_recovery") return "Spike Cluster Recovery";
  if (type === "drift_recovery") return "Drift Recovery";
  if (type === "uncategorized_emerging_pattern") return "Uncategorized Emerging Pattern";
  return type;
}

function TierPill({ tier }: { tier: string }) {
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
      {tier}
    </span>
  );
}

function formatRuntimeDate(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function nativeExpansionType(type?: string | null): boolean {
  return type === "boom_expansion" || type === "crash_expansion";
}

function percentileAt(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx] ?? 0;
}

function relativeNativeTier(score: number, sortedScoresAsc: number[]): "A" | "B" | "C" {
  const aCutoff = percentileAt(sortedScoresAsc, 0.75);
  const bCutoff = percentileAt(sortedScoresAsc, 0.35);
  return score >= aCutoff ? "A" : score >= bCutoff ? "B" : "C";
}

function relativeNativePercentile(score: number, sortedScoresAsc: number[]): number {
  if (sortedScoresAsc.length <= 1) return 100;
  let countAtOrBelow = 0;
  for (const candidate of sortedScoresAsc) {
    if (candidate <= score) countAtOrBelow++;
  }
  return Math.round(((countAtOrBelow - 1) / (sortedScoresAsc.length - 1)) * 100);
}

function TypePill({ type }: { type: string }) {
  const label = formatMoveTypeLabel(type);
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border", TYPE_COLORS[type] ?? TYPE_COLORS.unknown)}>
      {label}
    </span>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono font-medium text-foreground text-right max-w-[70%] break-words whitespace-normal">
        {value}
      </span>
    </div>
  );
}

function asNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatPct(v: unknown, digits = 2): string {
  const n = asNum(v);
  return n == null ? "" : `${n.toFixed(digits)}%`;
}

function formatModelDetails(
  model: Record<string, unknown> | undefined,
  kind: "tp" | "sl" | "trailing",
): string {
  if (!model || Object.keys(model).length === 0) return "";

  if (kind === "tp") {
    const target = formatPct(model.targetPct, 2);
    const rationale = typeof model.rationale === "string" ? model.rationale : "";
    return [target ? `target ${target}` : "", rationale].filter(Boolean).join(" - ");
  }

  if (kind === "sl") {
    const structural = model.structural === true ? "structural" : "";
    const risk = formatPct(model.maxInitialRiskPct, 2);
    return [structural, risk ? `max risk ${risk}` : ""].filter(Boolean).join(" - ");
  }

  const activation = formatPct(model.activationProfitPct, 2);
  const distance = formatPct(model.trailingDistancePct, 2);
  const hold = asNum(model.minHoldMinutesBeforeTrail);
  const policy = typeof model.policy === "string" ? model.policy : "";
  return [
    activation ? `arm ${activation}` : "",
    distance ? `distance ${distance}` : "",
    hold != null ? `min hold ${Math.round(hold)}m` : "",
    policy,
  ].filter(Boolean).join(" - ");
}

function DomainCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30">
        {icon}
        <span className="text-xs font-semibold text-foreground">{title}</span>
      </div>
      <div className="px-4 py-3 flex-1 space-y-0.5">{children}</div>
    </div>
  );
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface DetectResult {
  symbol: string;
  detected: number;
  savedToDb: number;
  windowDays: number;
  movesDetected?: number;
  totalCandlesScanned?: number;
  interpolatedExcluded?: number;
  movesByType?: Record<string, number>;
  movesByTier?: Record<string, number>;
}

interface MoveTypeStats {
  count: number;
  avgMovePct: number;
  medianMovePct: number;
  avgHoldHours: number;
  engineCoverage: number;
  avgCaptureablePct: number;
  avgHoldabilityScore: number;
}

interface AggregateResult {
  symbol: string;
  totalMoves: number;
  byMoveType: Record<string, MoveTypeStats>;
  overall: {
    targetMoves: number;
    capturedMoves: number;
    missedMoves: number;
    fitScore: number;
    avgMovePct: number;
    medianMovePct: number;
    avgHoldHours: number;
    avgCaptureablePct: number;
    avgHoldabilityScore: number;
    avgMfe: number | null;
    missReasons: Array<{ reason: string; count: number }>;
    engineCoverage: Record<string, { matched: number; fired: number; missRate: number }>;
    qualityDistribution: Record<string, number>;
    behaviorPatterns: Record<string, number>;
    leadInShapes: Record<string, number>;
    directionSplit: { up: number; down: number };
  };
  generatedAt: string;
}

interface EngineRow {
  engineName?: string;
  matchedMoves: number;
  wouldFireCount: number;
  fireRate: number;
  avgMissMovePct: number;
  topMissReasons?: string[];
}

interface DetectedMove {
  id: number;
  symbol: string;
  moveType: string;
  qualityTier: string;
  qualityScore?: number;
  direction: string;
  movePct: number;
  holdingMinutes: number;
  leadInShape: string;
  startTs: number;
}

function MoveCalibrationTab({ domain, windowDays }: { domain: DomainId; windowDays: number }) {
  const calibRun = useCalibrationRun();
  const calibrationSymbols = domain === "active" ? CALIB_ACTIVE_SYMBOLS : CALIB_RESEARCH_SYMBOLS;
  const [symbol, setSymbol] = useState(calibrationSymbols[0] ?? "BOOM300");
  const [minMovePct, setMinMovePct] = useState(0.05);
  const [clearExisting, setClearExisting] = useState(true);
  const [strategyFamily, setStrategyFamily] = useState("all");

  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [detectErr, setDetectErr] = useState<string | null>(null);

  const [aggregate, setAggregate] = useState<AggregateResult | null>(null);
  const [aggLoading, setAggLoading] = useState(false);

  const [targetMovesStats, setTargetMovesStats] = useState<{
    totalMoves: number;
    medianMagnitudePct: number | null;
    medianQualityScore: number | null;
    moveTypeDistribution: Record<string, number>;
    qualityDistribution: Record<string, number>;
  } | null>(null);

  const [behaviorProfile, setBehaviorProfile] = useState<BehaviorOverview | null>(null);
  const [buildingProfile, setBuildingProfile] = useState(false);
  const [calibProfile, setCalibProfile] = useState<CalibrationProfile | null>(null);
  const [researchProfile, setResearchProfile] = useState<SymbolResearchProfileUi | null>(null);
  const [runtimeModel, setRuntimeModel] = useState<RuntimeModelStateUi | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState<"stage" | "promote" | null>(null);
  const [runtimeErr, setRuntimeErr] = useState<string | null>(null);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [parityBusy, setParityBusy] = useState(false);
  const [parityErr, setParityErr] = useState<string | null>(null);
  const [parityReport, setParityReport] = useState<ParityReportUi | null>(null);
  const [optimiserBusy, setOptimiserBusy] = useState<"run" | "stage" | "refresh" | "cancel" | null>(null);
  const [optimiserRunId, setOptimiserRunId] = useState<number | null>(null);
  const [optimiserStatus, setOptimiserStatus] = useState<Record<string, unknown> | null>(null);
  const [optimiserErr, setOptimiserErr] = useState<string | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);

  const [engines, setEngines] = useState<EngineRow[]>([]);
  const [engineLoading, setEngineLoading] = useState(false);

  const [moves, setMoves] = useState<DetectedMove[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const [moveTypeFilter, setMoveTypeFilter] = useState("all");
  const [movesExpanded, setMovesExpanded] = useState(false);

  const [scope, setScope] = useState<"detect" | "passes" | "full">("full");
  const [runElapsed, setRunElapsed] = useState(0);
  const prevCalibStatusRef = useRef<string | undefined>(undefined);
  const [showDebugTools, setShowDebugTools] = useState(false);
  const [preflight, setPreflight] = useState<{
    latestCandleTs?: number;
    base1mCount: number;
    base1mGapCount: number;
    base1mInterpolatedCount: number;
    base1mCoveragePct: number;
    readyForCalibration: boolean;
    integrityStatus: "healthy" | "reconcile_required";
    recommendedAction: string;
  } | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  const [passName, setPassName] = useState("all");
  const [passMinTier, setPassMinTier] = useState("");
  const [passMoveType, setPassMoveType] = useState("all");
  const [maxMoves, setMaxMoves] = useState("");
  const [passErr, setPassErr] = useState<string | null>(null);

  const passForThisSymbol = calibRun.isPassRunActive && calibRun.symbol === symbol;
  const passStatus = (() => {
    if (calibRun.runId !== null && calibRun.symbol === symbol && calibRun.status) {
      return calibRun.status;
    }
    const term = calibRun.lastTerminalRun;
    if (term && term.symbol === symbol) {
      return term.status;
    }
    return null;
  })();

  const [historyDetailId, setHistoryDetailId] = useState<number | null>(null);
  const [historyDetail, setHistoryDetail] = useState<PassStatusResult | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);

  const [runs, setRuns] = useState<PassRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsExpanded, setRunsExpanded] = useState(false);

  const [exportBusy, setExportBusy] = useState<Record<string, boolean>>({});
  const [resetBusy, setResetBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importType, setImportType] = useState<"auto" | "moves" | "passes" | "profile" | "comparison">("auto");
  const [importReplace, setImportReplace] = useState(true);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const loadDomains = useCallback(async (sym: string, family?: string) => {
    setAggLoading(true);
    setDomainLoading(true);
    setEngineLoading(true);
    const profilePath = (family && family !== "all") ? family : "all";
    try {
      const [agg, eng, beh, calib, rawMovesResp, rp, runtime] = await Promise.all([
        apiFetch(`calibration/aggregate/${sym}`).catch(() => null),
        apiFetch(`calibration/engine/${sym}`).catch(() => null),
        apiFetch(`behavior/profile/${sym}`).catch(() => null),
        apiFetch(`calibration/profile/${sym}/${profilePath}`).catch(() => null),
        apiFetch(`calibration/moves/${sym}`).catch(() => null),
        apiFetch(`calibration/research-profile/${sym}`).catch(() => null),
        apiFetch(`calibration/runtime-model/${sym}`).catch(() => null),
      ]);
      setAggregate(agg);
      setEngines(eng?.engines ?? []);
      setBehaviorProfile(beh ?? null);
      setCalibProfile(calib ?? null);
      setResearchProfile(rp ?? null);
      setRuntimeModel(runtime ?? null);

      // Compute Target Moves stats directly from the moves endpoint (constraint #9  source: /api/calibration/moves/:symbol)
      const rawMoves: Array<{ movePct?: number | string | null; moveType?: string | null; qualityTier?: string | null; qualityScore?: number | string | null }> =
        rawMovesResp?.moves ?? [];
      if (rawMoves.length > 0) {
        const mags = rawMoves
          .map(m => Number(m.movePct ?? 0))
          .filter(v => !isNaN(v))
          .sort((a, b) => a - b);
        const mid = Math.floor(mags.length / 2);
        const medianMag = mags.length > 0 ? mags[mid] : null;
        const qualScores = rawMoves
          .map(m => Number(m.qualityScore ?? 0))
          .filter(v => !isNaN(v))
          .sort((a, b) => a - b);
        const medianQuality = qualScores.length > 0 ? qualScores[Math.floor(qualScores.length / 2)] : null;
        const moveTypeDist = rawMoves.reduce<Record<string, number>>((acc, m) => {
          const t = String(m.moveType ?? "unknown");
          acc[t] = (acc[t] ?? 0) + 1;
          return acc;
        }, {});
        const nativeScores = rawMoves.every(m => nativeExpansionType(m.moveType))
          ? rawMoves.map(m => Number(m.qualityScore ?? 0)).filter(v => !isNaN(v)).sort((a, b) => a - b)
          : [];
        const qualityDist = rawMoves.reduce<Record<string, number>>((acc, m) => {
          const score = Number(m.qualityScore ?? 0);
          const t = nativeScores.length >= 10 && !isNaN(score)
            ? relativeNativeTier(score, nativeScores)
            : String(m.qualityTier ?? "?");
          acc[t] = (acc[t] ?? 0) + 1;
          return acc;
        }, {});
        setTargetMovesStats({
          totalMoves: rawMoves.length,
          medianMagnitudePct: medianMag,
          medianQualityScore: medianQuality,
          moveTypeDistribution: moveTypeDist,
          qualityDistribution: qualityDist,
        });
      } else {
        setTargetMovesStats(null);
      }
    } finally {
      setAggLoading(false);
      setDomainLoading(false);
      setEngineLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (sym: string) => {
    setRunsLoading(true);
    try {
      const d = await apiFetch(`calibration/runs/${sym}`).catch(() => null);
      setRuns(d?.runs ?? []);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const loadMoves = useCallback(async (sym: string, type?: string) => {
    setMovesLoading(true);
    try {
      const params = new URLSearchParams();
      if (type && type !== "all") params.set("moveType", type);
      const qs = params.toString();
      const d = await apiFetch(`calibration/moves/${sym}${qs ? "?" + qs : ""}`);
      setMoves(d.moves ?? []);
    } catch {
      setMoves([]);
    } finally {
      setMovesLoading(false);
    }
  }, []);

  const loadPreflight = useCallback(async (sym: string) => {
    setPreflightLoading(true);
    try {
      const d = await apiFetch(`calibration/preflight/${sym}`);
      setPreflight(d);
    } catch {
      setPreflight(null);
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!calibrationSymbols.includes(symbol)) {
      setSymbol(calibrationSymbols[0] ?? "BOOM300");
      setDetectResult(null);
      setDetectErr(null);
      setStrategyFamily("all");
      setMoveTypeFilter("all");
    }
  }, [domain, calibrationSymbols, symbol]);

  useEffect(() => {
    setOptimiserRunId(null);
    setOptimiserStatus(null);
    setOptimiserErr(null);
    setParityReport(null);
    setParityErr(null);
  }, [symbol]);

  useEffect(() => {
    loadDomains(symbol, strategyFamily);
    loadMoves(symbol, moveTypeFilter);
    loadRuns(symbol);
    loadPreflight(symbol);
  }, [symbol]);

  // Recovery path: if a run is already "running" on the backend (e.g. page refresh,
  // new browser tab, or stale session storage), re-attach local polling automatically.
  useEffect(() => {
    if (calibRun.isPassRunActive) return;
    const running = runs.find(r => r.status === "running");
    if (!running) return;
    calibRun.beginPassRun(running.id, symbol);
  }, [runs, symbol, calibRun]);

  useEffect(() => {
    setHistoryDetailId(null);
    setHistoryDetail(null);
  }, [symbol]);

  useEffect(() => {
    loadMoves(symbol, moveTypeFilter);
  }, [moveTypeFilter]);

  useEffect(() => {
    setMoveTypeFilter(strategyFamily);
    loadDomains(symbol, strategyFamily);
  }, [strategyFamily]);

  useEffect(() => {
    if (!detecting && !passForThisSymbol) {
      setRunElapsed(0);
      return;
    }
    setRunElapsed(0);
    const id = setInterval(() => setRunElapsed(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [detecting, passForThisSymbol]);

  useEffect(() => {
    const st = calibRun.status?.status;
    if (
      prevCalibStatusRef.current === "running" &&
      st &&
      st !== "running" &&
      calibRun.symbol === symbol
    ) {
      void Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadRuns(symbol),
        loadPreflight(symbol),
      ]);
    }
    prevCalibStatusRef.current = st;
  }, [calibRun.status?.status, calibRun.symbol, symbol, strategyFamily, moveTypeFilter, loadDomains, loadMoves, loadRuns, loadPreflight]);

  const resetCalibration = async (): Promise<void> => {
    if (
      !window.confirm(
        `Clear all move calibration for ${symbol}? This deletes detected moves, AI pass rows, profiles, and run history for this symbol.`,
      )
    ) {
      return;
    }
    setResetBusy(true);
    setDetectErr(null);
    setPassErr(null);
    try {
      await apiFetch(`calibration/reset/${symbol}`, { method: "POST" });
      calibRun.clearPassRunForSymbol(symbol);
      setDetectResult(null);
      await Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadRuns(symbol),
        loadPreflight(symbol),
      ]);
    } catch (e: unknown) {
      setDetectErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setResetBusy(false);
    }
  };

  const detectMoves = async (): Promise<boolean> => {
    setDetecting(true);
    setDetectErr(null);
    setDetectResult(null);
    try {
      const d = await apiFetch(`calibration/detect-moves/${symbol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays, minMovePct, clearExisting }),
      });
      setDetectResult(d);
      await Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadPreflight(symbol),
      ]);
      return true;
    } catch (e: unknown) {
      setDetectErr(e instanceof Error ? e.message : "Detection failed");
      return false;
    } finally {
      setDetecting(false);
    }
  };

  const openRunHistoryDetail = async (id: number) => {
    setHistoryDetailId(id);
    setHistoryDetailLoading(true);
    try {
      const s = (await apiFetch(`calibration/run-status/${id}`)) as PassStatusResult;
      setHistoryDetail(s);
    } catch {
      setHistoryDetail(null);
    } finally {
      setHistoryDetailLoading(false);
    }
  };

  const runPasses = async (overridePassName?: string): Promise<boolean> => {
    setPassErr(null);
    try {
      const pn = overridePassName ?? passName;
      const body: Record<string, unknown> = {
        windowDays,
        passName: pn,
        continueOnMoveErrors: false,
      };
      if (passMinTier) body.minTier = passMinTier;
      const effectiveMoveType = passMoveType !== "all" ? passMoveType : (strategyFamily !== "all" ? strategyFamily : undefined);
      if (effectiveMoveType) body.moveType = effectiveMoveType;
      if (maxMoves && !isNaN(Number(maxMoves))) body.maxMoves = Number(maxMoves);
      const url = `${BASE}api/calibration/run-passes/${symbol}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.status === 409 && typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId as number, symbol);
        return true;
      }
      if (!r.ok) {
        setPassErr(String(d.error ?? `HTTP ${r.status}`));
        return false;
      }
      if (typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId, symbol);
        return true;
      }
      setPassErr("No run id returned from server");
      return false;
    } catch (e: unknown) {
      setPassErr(e instanceof Error ? e.message : "Pass run failed");
      return false;
    }
  };

  const runFullCalibration = async (): Promise<boolean> => {
    setPassErr(null);
    setDetectErr(null);
    try {
      const body: Record<string, unknown> = {
        windowDays,
        minMovePct,
        force: true,
      };
      if (passMinTier) body.minTier = passMinTier;
      const effectiveMoveType = passMoveType !== "all" ? passMoveType : (strategyFamily !== "all" ? strategyFamily : undefined);
      if (effectiveMoveType) body.moveType = effectiveMoveType;
      if (maxMoves && !isNaN(Number(maxMoves))) body.maxMoves = Number(maxMoves);

      const url = `${BASE}api/calibration/full/${symbol}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.status === 409 && typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId as number, symbol);
        return true;
      }
      if (!r.ok) {
        setPassErr(String(d.error ?? `HTTP ${r.status}`));
        return false;
      }
      if (typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId, symbol);
        setDetectResult((d.detectSummary as DetectResult | null | undefined) ?? null);
        await loadPreflight(symbol);
        return true;
      }
      setPassErr("Full calibration did not return a run id");
      return false;
    } catch (e: unknown) {
      setPassErr(e instanceof Error ? e.message : "Full calibration failed");
      return false;
    }
  };

  const effectiveScope: "detect" | "passes" | "full" = showDebugTools ? scope : "full";

  const runScope = async () => {
    if (effectiveScope === "detect") {
      await detectMoves();
    } else if (effectiveScope === "passes") {
      // Scope "Run All Passes" always forces passName="all" regardless of the pass selector,
      // so the selector only affects explicit single-pass reruns from run history.
      await runPasses("all");
    } else {
      await runFullCalibration();
    }
  };

  const doExport = async (key: string, endpoint: string, filename: string) => {
    setExportBusy(p => ({ ...p, [key]: true }));
    try {
      const d = await apiFetch(endpoint);
      downloadJson(d, filename);
    } catch (e: unknown) {
      alert(`Export failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setExportBusy(p => ({ ...p, [key]: false }));
    }
  };

  const updateRuntimeModel = async (action: "stage" | "promote") => {
    setRuntimeBusy(action);
    setRuntimeErr(null);
    setRuntimeNotice(null);
    try {
      const result = await apiFetch(`calibration/runtime-model/${symbol}/${action}`, { method: "POST" }) as {
        model?: RuntimeSymbolModelUi;
      };
      const runtime = await apiFetch(`calibration/runtime-model/${symbol}`).catch(() => null) as RuntimeModelStateUi | null;
      setRuntimeModel(runtime ?? null);
      const model = result?.model;
      const runId = model?.sourceRunId ?? runtime?.lifecycle?.[action === "stage" ? "stagedRunId" : "promotedRunId"] ?? "n/a";
      const actionTime = model?.promotedAt ?? runtime?.lifecycle?.[action === "stage" ? "stagedAt" : "promotedAt"] ?? null;
      const bucketCount = action === "stage"
        ? runtime?.lifecycle?.stagedTpBucketCount
        : runtime?.lifecycle?.promotedTpBucketCount;
      setRuntimeNotice(
        `${action === "stage" ? "Staged" : "Promoted"} ${symbol} runtime model from run ${runId} at ${formatRuntimeDate(actionTime)}. ` +
        `Dynamic TP buckets: ${bucketCount ?? 0}.`,
      );
    } catch (e: unknown) {
      setRuntimeErr(e instanceof Error ? e.message : `Runtime ${action} failed`);
    } finally {
      setRuntimeBusy(null);
    }
  };

  const runParityReport = async () => {
    setParityBusy(true);
    setParityErr(null);
    try {
      const report = await apiFetch(`calibration/runtime-model/${symbol}/parity-report?windowDays=${windowDays}`) as ParityReportUi;
      setParityReport(report);
    } catch (e: unknown) {
      setParityErr(e instanceof Error ? e.message : "Parity report failed");
    } finally {
      setParityBusy(false);
    }
  };

  const refreshOptimiserStatus = async (runId = optimiserRunId, silent = false) => {
    if (!runId) return;
    if (!silent) {
      setOptimiserBusy("refresh");
      setOptimiserErr(null);
    }
    try {
      const status = await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest/${runId}`) as Record<string, unknown>;
      setOptimiserStatus(status);
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Optimiser status failed");
    } finally {
      if (!silent) setOptimiserBusy(null);
    }
  };

  const runBacktestOptimiser = async () => {
    if (optimiserLockedByParity) {
      setOptimiserErr("Optimiser disabled: CRASH300 runtime does not recognise calibrated moves yet.");
      return;
    }
    setOptimiserBusy("run");
    setOptimiserErr(null);
    setRuntimeNotice(null);
    try {
      const started = await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays, maxIterations: 5, enableAiReview: false }),
      }) as { runId?: number };
      const runId = Number(started.runId);
      setOptimiserRunId(runId);
      setOptimiserStatus(started as unknown as Record<string, unknown>);
      setRuntimeNotice(`Backtest optimiser started for ${symbol}. Winner will be staged only, not promoted.`);
      window.setTimeout(() => void refreshOptimiserStatus(runId), 2500);
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Optimiser start failed");
    } finally {
      setOptimiserBusy(null);
    }
  };

  const cancelOptimiser = async () => {
    if (!optimiserRunId) return;
    setOptimiserBusy("cancel");
    setOptimiserErr(null);
    try {
      await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest/${optimiserRunId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "cancelled_from_research_ui" }),
      });
      await refreshOptimiserStatus(optimiserRunId);
      setRuntimeNotice(`Backtest optimiser cancellation requested for ${symbol} (run ${optimiserRunId}).`);
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Optimiser cancel failed");
    } finally {
      setOptimiserBusy(null);
    }
  };

  const stageOptimiserWinner = async () => {
    if (!optimiserRunId) return;
    setOptimiserBusy("stage");
    setOptimiserErr(null);
    try {
      const staged = await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest/${optimiserRunId}/stage-winner`, {
        method: "POST",
      }) as Record<string, unknown>;
      setOptimiserStatus(staged);
      const runtime = await apiFetch(`calibration/runtime-model/${symbol}`).catch(() => null) as RuntimeModelStateUi | null;
      setRuntimeModel(runtime ?? null);
      setRuntimeNotice("Optimised winner staged. Runtime is not promoted until you click Promote To Runtime.");
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Stage optimiser winner failed");
    } finally {
      setOptimiserBusy(null);
    }
  };

  const inferImportType = (filename: string, payload: Record<string, unknown>): "moves" | "passes" | "profile" | "comparison" | null => {
    const lower = filename.toLowerCase();
    if (lower.includes("calibration_moves_")) return "moves";
    if (lower.includes("calibration_passes_")) return "passes";
    if (lower.includes("calibration_profile_")) return "profile";
    if (lower.includes("calibration_comparison_")) return "comparison";
    if (Array.isArray(payload.moves) || Array.isArray(payload.detected_moves)) return "moves";
    if (Array.isArray(payload.runs) || payload.rawPassRecords || Array.isArray(payload.precursorPasses) || Array.isArray(payload.behaviorPasses)) return "passes";
    if (Array.isArray(payload.profiles)) return "profile";
    if (payload.aggregateDomain || payload.engineDomain || payload.scoringDomain) return "comparison";
    return null;
  };

  const importCalibrationFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImportBusy(true);
    setImportError(null);
    setImportMessage(null);
    const notes: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const text = await file.text();
        const payload = JSON.parse(text) as Record<string, unknown>;
        const resolvedType = importType === "auto" ? inferImportType(file.name, payload) : importType;
        if (!resolvedType) {
          notes.push(`${file.name}: skipped (could not infer import type)`);
          continue;
        }
        const response = await fetch(
          `${BASE}api/calibration/import/${symbol}?type=${resolvedType}&replace=${importReplace ? "true" : "false"}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          throw new Error(`${file.name}: ${String(body.error ?? `HTTP ${response.status}`)}`);
        }
        notes.push(`${file.name}: imported as ${resolvedType}`);
      }
      setImportMessage(notes.length > 0 ? notes.join(" | ") : "No files imported.");
      await Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadRuns(symbol),
        loadPreflight(symbol),
      ]);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImportBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const movesMagnitudeSummary = (() => {
    if (moves.length === 0) return null;
    const sorted = [...moves].map(m => m.movePct).sort((a, b) => a - b);
    const idx = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
    return {
      min: sorted[0],
      p25: idx(0.25),
      median: idx(0.5),
      p75: idx(0.75),
      p90: idx(0.9),
      max: sorted[sorted.length - 1],
      count: sorted.length,
    };
  })();

  const calibrationCoverage = calibProfile
    ? {
        source: "Synthesized calibration profile",
        targetMoves: calibProfile.targetMoves,
        capturedMoves: calibProfile.capturedMoves,
        missedMoves: calibProfile.missedMoves,
        fitScore: calibProfile.fitScore,
        avgMovePct: calibProfile.avgMovePct,
        avgCaptureablePct: calibProfile.avgCaptureablePct,
        avgHoldabilityScore: calibProfile.avgHoldabilityScore,
      }
    : aggregate?.overall
      ? {
          source: "Current engine replay aggregate",
          targetMoves: aggregate.overall.targetMoves,
          capturedMoves: aggregate.overall.capturedMoves,
          missedMoves: aggregate.overall.missedMoves,
          fitScore: aggregate.overall.fitScore,
          avgMovePct: aggregate.overall.avgMovePct,
          avgCaptureablePct: aggregate.overall.avgCaptureablePct,
          avgHoldabilityScore: aggregate.overall.avgHoldabilityScore,
      }
      : null;

  const nativeMoveScores = moves.every((m) => nativeExpansionType(m.moveType))
    ? moves.map((m) => Number(m.qualityScore ?? 0)).filter((v) => !isNaN(v)).sort((a, b) => a - b)
    : [];
  const moveRows = moves.map((m) => {
    const score = Number(m.qualityScore ?? 0);
    const relativeTier = nativeMoveScores.length >= 10 && !isNaN(score)
      ? relativeNativeTier(score, nativeMoveScores)
      : m.qualityTier;
    const qualityPercentile = nativeMoveScores.length >= 10 && !isNaN(score)
      ? relativeNativePercentile(score, nativeMoveScores)
      : null;
    return { ...m, relativeTier, qualityPercentile };
  });
  const displayedMoves = movesExpanded ? moveRows : moveRows.slice(0, 20);
  const optimiserRun = (optimiserStatus?.run ?? null) as Record<string, unknown> | null;
  const optimiserPhase = String(optimiserRun?.phase ?? "n/a");
  const optimiserHeartbeatRaw = optimiserRun?.lastHeartbeatAt;
  const optimiserHeartbeat = typeof optimiserHeartbeatRaw === "string" ? formatRuntimeDate(optimiserHeartbeatRaw) : "n/a";
  const optimiserIsRunning = String(optimiserRun?.status ?? "").toLowerCase() === "running";
  const optimiserWinner = (optimiserRun?.winnerMetrics ?? null) as Record<string, unknown> | null;
  const optimiserWinnerMetrics = (optimiserWinner?.metrics ?? null) as Record<string, unknown> | null;
  const optimiserBaseline = (optimiserRun?.baselineMetrics ?? null) as Record<string, unknown> | null;
  const optimiserCandidates = (optimiserStatus?.candidates ?? []) as Array<Record<string, unknown>>;
  const optimiserSelected = optimiserCandidates.find(c => c.selected === true);
  const optimiserFailureReason = String(
    optimiserStatus?.failureReason ??
    ((optimiserRun?.errorSummary as Record<string, unknown> | undefined)?.error ?? ""),
  ).trim();
  const optimiserFailureStack = String(
    optimiserStatus?.failureStack ??
    ((optimiserRun?.errorSummary as Record<string, unknown> | undefined)?.stack ?? ""),
  ).trim();
  const parityTotals = parityReport?.totals ?? null;
  const parityMatchedMoves = Number(parityTotals?.matchedMoves ?? 0);
  const parityHasAnyMatches = parityMatchedMoves > 0;
  const optimiserHasExistingRun = optimiserRunId != null || optimiserRun != null;
  const optimiserLockedByParity = !parityHasAnyMatches;
  const parityDiagnostics = parityReport?.diagnostics ?? null;
  const parityFailureRows = Object.entries(parityDiagnostics?.failureReasonCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityFamilyRows = Object.entries(parityDiagnostics?.selectedRuntimeFamilyCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityBucketRows = Object.entries(parityDiagnostics?.selectedBucketCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityDirectionRows = Object.entries(parityDiagnostics?.directionMatrixCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityGateRows = Object.entries(parityDiagnostics?.gateComponentFailures ?? {}).sort((a, b) => b[1] - a[1]);

  useEffect(() => {
    if (!optimiserRunId || !optimiserIsRunning) return;
    const id = window.setInterval(() => {
      void refreshOptimiserStatus(optimiserRunId, true);
    }, 2000);
    return () => window.clearInterval(id);
  }, [optimiserRunId, optimiserIsRunning]);

  return (
    <div className="space-y-5">

      {/*  Controls  */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        {/* Scope row */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Calibration Controls</h3>
          <button
            type="button"
            onClick={() => {
              setShowDebugTools(prev => {
                const next = !prev;
                if (!next) setScope("full");
                return next;
              });
            }}
            className="text-[11px] px-2.5 py-1 rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
          >
            {showDebugTools ? "Hide Debug Tools" : "Show Debug Tools"}
          </button>
        </div>

        {/* Shared controls */}
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Symbol</span>
            <select
              value={symbol}
              onChange={e => {
                const s = e.target.value;
                setSymbol(s);
                setDetectResult(null);
                setDetectErr(null);
                setStrategyFamily("all");
                setMoveTypeFilter("all");
              }}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {calibrationSymbols.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Window</span>
            <div className="text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">
              {windowLabel(windowDays)} (shared)
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Strategy Family</span>
            <select
              value={strategyFamily}
              onChange={e => setStrategyFamily(e.target.value)}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {strategyFamiliesForSymbol(symbol).map((family) => (
                <option key={family} value={family}>{formatMoveTypeLabel(family)}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Min Move %</span>
            <select
              value={minMovePct}
              onChange={e => setMinMovePct(Number(e.target.value))}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {[0.02, 0.03, 0.05, 0.08, 0.10].map(p => <option key={p} value={p}>{(p * 100).toFixed(0)}%</option>)}
            </select>
          </div>

          {showDebugTools && scope === "detect" && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer self-end pb-1.5">
              <input
                type="checkbox"
                checked={clearExisting}
                onChange={e => setClearExisting(e.target.checked)}
                className="accent-primary"
              />
              Clear existing
            </label>
          )}

          {/* Debug-only pass controls */}
          {showDebugTools && (scope === "passes" || scope === "full") && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Pass</span>
                <select
                  value={passName}
                  onChange={e => setPassName(e.target.value)}
                  className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                >
                  {PASS_NAMES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Min Tier</span>
                <select
                  value={passMinTier}
                  onChange={e => setPassMinTier(e.target.value)}
                  className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                >
                  <option value="">Any</option>
                  {TIERS.map(t => <option key={t} value={t}>Tier {t}+</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Max Moves</span>
                <input
                  type="number"
                  value={maxMoves}
                  onChange={e => setMaxMoves(e.target.value)}
                  placeholder="all"
                  className="w-20 text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                />
              </div>
            </>
          )}

          {showDebugTools && (
            <div className="flex items-center gap-1 bg-background border border-border/50 rounded-lg p-0.5 self-end">
              {(["full", "detect", "passes"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={cn(
                    "text-[11px] px-2.5 py-1 rounded-md transition-colors font-medium",
                    scope === s
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s === "detect" ? "Detect Moves Only" : s === "passes" ? "Run All Passes" : "Run Full Calibration"}
                </button>
              ))}
            </div>
          )}

          {/* Unified Run button */}
          <button
            onClick={runScope}
            disabled={detecting || passForThisSymbol}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50 self-end",
              effectiveScope === "full"
                ? "bg-emerald-600 text-white"
                : effectiveScope === "passes"
                  ? "bg-amber-500/80 text-black"
                  : "bg-primary text-primary-foreground"
            )}
          >
            {(detecting || passForThisSymbol) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {detecting ? "Detecting" : passForThisSymbol ? "Running calibration" :
              effectiveScope === "detect" ? "Detect Moves" : effectiveScope === "passes" ? "Run Calibration Pipeline" : "Run Full Calibration"}
          </button>

          <button
            onClick={() => { loadDomains(symbol, strategyFamily); loadMoves(symbol, moveTypeFilter); loadRuns(symbol); loadPreflight(symbol); }}
            disabled={aggLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border self-end"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", aggLoading && "animate-spin")} />
            Refresh
          </button>

          <button
            type="button"
            onClick={() => void resetCalibration()}
            disabled={resetBusy || detecting || passForThisSymbol}
            title="Delete moves, pass results, profiles, and run history for this symbol"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 self-end disabled:opacity-50"
          >
            {resetBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Clear calibration
          </button>
        </div>

        {/* Elapsed timer */}
        {(detecting || passForThisSymbol) && runElapsed > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
            <Loader2 className="w-3 h-3 animate-spin" />
            Elapsed: <strong className="text-foreground font-mono">{formatDurationCompact(runElapsed)}</strong>
          </div>
        )}

        <div className="rounded-lg border border-border/40 bg-muted/10 p-3 space-y-2">
          {(() => {
            const currentStage = (passStatus?.metaJson as { stage?: string } | null)?.stage;
            const reconcileRunning = passStatus?.status === "running" && currentStage === "Data Integrity";
            const readinessLabel = reconcileRunning
              ? "running reconcile"
              : preflight?.readyForCalibration
                ? "healthy"
                : "reconcile required";
            const readinessClass = reconcileRunning
              ? "text-sky-300 border-sky-500/30 bg-sky-500/10"
              : preflight?.readyForCalibration
                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                : "text-amber-300 border-amber-500/30 bg-amber-500/10";
            return (
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">Calibration Readiness</span>
            {preflightLoading ? (
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> checking
              </span>
            ) : (
              <span
                className={cn(
                  "text-[11px] px-2 py-0.5 rounded border",
                  readinessClass
                )}
              >
                {readinessLabel}
              </span>
            )}
          </div>
            );
          })()}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Last candle</div>
              <div className="font-mono text-foreground">
                {preflight?.latestCandleTs
                  ? new Date(preflight.latestCandleTs * 1000).toLocaleString()
                  : ""}
              </div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">1m candles</div>
              <div className="font-mono text-foreground">{preflight?.base1mCount?.toLocaleString?.() ?? ""}</div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Missing gaps</div>
              <div className="font-mono text-foreground">{preflight?.base1mGapCount ?? ""}</div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Interpolated</div>
              <div className="font-mono text-foreground">{preflight?.base1mInterpolatedCount ?? ""}</div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Coverage</div>
              <div className="font-mono text-foreground">{preflight?.base1mCoveragePct != null ? `${preflight.base1mCoveragePct}%` : ""}</div>
            </div>
          </div>
          {preflight?.recommendedAction && (
            <p className="text-[11px] text-muted-foreground">
              Recommended action: <span className="text-foreground font-mono">{preflight.recommendedAction}</span>
            </p>
          )}
        </div>

        {detectErr && <ErrorBox msg={detectErr} />}
        {detectResult && (
          <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">{detectResult.movesDetected} moves detected  {symbol} ({windowDays}d window)</span>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span>Candles scanned: <strong className="text-foreground">{detectResult.totalCandlesScanned?.toLocaleString()}</strong></span>
              <span>Interpolated excluded: <strong className="text-foreground">{detectResult.interpolatedExcluded}</strong></span>
              <span>Saved to DB: <strong className="text-foreground">{detectResult.savedToDb}</strong></span>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(detectResult.movesByType ?? {}).map(([type, cnt]) => (
                <span key={type} className={cn("px-1.5 py-0.5 rounded text-[10px] border", TYPE_COLORS[type] ?? TYPE_COLORS.unknown)}>
                  {type}: {cnt as number}
                </span>
              ))}
              {Object.entries(detectResult.movesByTier ?? {}).map(([tier, cnt]) => (
                <span key={tier} className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
                  Tier {tier}: {cnt as number}
                </span>
              ))}
            </div>
          </div>
        )}

        {passErr && <ErrorBox msg={passErr} />}

        {passStatus && (
          <div className={cn(
            "rounded-lg border p-3 space-y-1.5",
            passStatus.status === "completed" ? "bg-green-500/10 border-green-500/20" :
            passStatus.status === "failed"    ? "bg-red-500/10 border-red-500/20" :
            "bg-primary/5 border-primary/20"
          )}>
            <div className="flex items-center gap-2">
              {passForThisSymbol && passStatus?.status === "running" && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              )}
              {passStatus.status === "completed" && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
              {passStatus.status === "failed"    && <XCircle    className="w-3.5 h-3.5 text-red-400"   />}
              <span className="text-xs font-semibold text-foreground">
                {passStatus.status === "running"   ? "Calibration running" :
                 passStatus.status === "completed" ? "Calibration completed" :
                 passStatus.status === "failed"    ? "Pass run failed" :
                 `Status: ${passStatus.status}`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {["Data Integrity", "Move Detection", "Deterministic Enrichment", "Family Inference", "Bucket Model Synthesis", "Research Profile Complete"].map((stage) => {
                const currentStage = (passStatus.metaJson as { stage?: string } | null)?.stage ?? "";
                const isActive = currentStage === stage;
                const isDone = ["Research Profile Complete"].includes(stage)
                  ? passStatus.status === "completed"
                  : false;
                return (
                  <span
                    key={stage}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded border",
                      isDone
                        ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                        : isActive
                          ? "text-primary border-primary/40 bg-primary/10"
                          : "text-muted-foreground border-border/30 bg-background/40"
                    )}
                  >
                    {stage}
                  </span>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {passStatus.totalMoves    != null && <span>Total: <strong className="text-foreground">{passStatus.totalMoves}</strong></span>}
              {passStatus.processedMoves != null && <span>Processed: <strong className="text-foreground">{passStatus.processedMoves}</strong></span>}
              {passStatus.failedMoves   != null && (
                <span title="Number of pass-level errors recorded (same move can count more than once only if multiple passes error)">
                  Pass errors: <strong className="text-foreground">{passStatus.failedMoves}</strong>
                </span>
              )}
              {passStatus.passName                  && <span>Pass: <strong className="text-foreground">{passStatus.passName}</strong></span>}
              {(passStatus.metaJson as { progress?: { remainingMoves?: number } } | null)?.progress?.remainingMoves != null &&
                passStatus.status === "running" && (
                <span>Queue left: <strong className="text-foreground">{(passStatus.metaJson as { progress?: { remainingMoves?: number } }).progress?.remainingMoves}</strong></span>
              )}
            </div>
            {passStatus.status === "running" &&
              (passStatus.metaJson as { progress?: { label?: string } } | null)?.progress?.label && (
              <p className="text-[11px] font-mono text-primary">
                {(passStatus.metaJson as { progress?: { label?: string } }).progress?.label}
              </p>
            )}
            {(() => {
              const mj = passStatus.metaJson as { failure?: { kind?: string; moveId?: number; pass?: string; error?: string; hint?: string } } | null;
              const f = mj?.failure;
              if (!f || passStatus.status === "running") return null;
              return (
                <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] text-amber-100/90 space-y-1">
                  <p className="font-semibold text-amber-200">Run stopped  {f.kind ?? "failure"}</p>
                  {typeof f.moveId === "number" && <p className="font-mono">move id {f.moveId}{typeof f.pass === "string" ? `  ${f.pass}` : ""}</p>}
                  {typeof f.error === "string" && <p className="font-mono text-red-300/95 whitespace-pre-wrap">{f.error}</p>}
                  {typeof f.hint === "string" && <p className="text-muted-foreground">{f.hint}</p>}
                </div>
              );
            })()}
            {passStatus.errorSummary != null && (
              <p className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-all">
                {typeof passStatus.errorSummary === "string"
                  ? passStatus.errorSummary
                  : JSON.stringify(passStatus.errorSummary, null, 2)}
              </p>
            )}
          </div>
        )}
      </div>

      {/*  3-Domain Comparison  */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-0.5 mb-2">3-Domain Comparison</h3>
        {(aggLoading || domainLoading || engineLoading) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="w-4 h-4 animate-spin" />Loading calibration domains
          </div>
        )}
        {!(aggLoading || domainLoading || engineLoading) && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

            {/* Domain A  Current Engine Behavior (signal-first, from behavior layer) */}
            <DomainCard title="Current Engine Behavior" icon={<Activity className="w-3.5 h-3.5 text-amber-400" />}>
              {!behaviorProfile ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">No behavior profile available.</p>
                  <button
                    disabled={buildingProfile}
                    onClick={async () => {
                      setBuildingProfile(true);
                      try {
                        await apiFetch(`behavior/build/${symbol}`, { method: "POST" }).catch(() => null);
                        const beh = await apiFetch(`behavior/profile/${symbol}`).catch(() => null);
                        setBehaviorProfile(beh ?? null);
                      } catch (err) {
                        console.error("[BehaviorProfile] Build failed:", err);
                      } finally {
                        setBuildingProfile(false);
                      }
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border/50 text-muted-foreground text-[11px] hover:border-border hover:bg-muted/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {buildingProfile ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    {buildingProfile ? "Building" : "Build Behavior Profile"}
                  </button>
                </div>
              ) : (
                <>
                  <StatRow label="Total trades" value={behaviorProfile.totalTrades} />
                  <StatRow label="Signals fired" value={behaviorProfile.totalSignalsFired} />
                  <StatRow label="Blocked" value={behaviorProfile.totalBlocked} />
                  <StatRow label="Win rate" value={`${(behaviorProfile.overallWinRate * 100).toFixed(1)}%`} />
                  <StatRow label="Block rate" value={`${(behaviorProfile.overallBlockedRate * 100).toFixed(1)}%`} />
                  <StatRow label="Rec. scan cadence" value={`${behaviorProfile.recommendedScanCadenceMins}min`} />
                  {(behaviorProfile.engineProfiles ?? []).length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-1.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Engines</p>
                      {(behaviorProfile.engineProfiles ?? []).map(ep => (
                        <div key={ep.engineName} className="space-y-0.5">
                          <p className="text-[10px] font-mono font-semibold text-foreground truncate">{ep.engineName}</p>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Trades / WR</span>
                            <span className="font-mono text-foreground">{ep.tradeCount}  {(ep.winRate * 100).toFixed(1)}%</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Avg PnL % (extracted)</span>
                            <span className={cn("font-mono", ep.avgPnlPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                              {(ep.avgPnlPct * 100).toFixed(2)}%
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Signals/day</span>
                            <span className="font-mono text-foreground">{ep.signalFrequencyPerDay.toFixed(2)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {aggregate?.overall?.avgMfe != null && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20">
                      <StatRow
                        label="Avg MFE (structural)"
                        value={`${aggregate.overall.avgMfe.toFixed(2)}%`}
                      />
                      <p className="text-[9px] text-muted-foreground/60 mt-0.5">From behavior pass  max favorable excursion per move</p>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Updated {new Date(behaviorProfile.lastUpdated).toLocaleDateString()}
                  </p>
                </>
              )}
            </DomainCard>

            {/* Domain B  Target Moves (sourced from /api/calibration/moves/:symbol  constraint #9) */}
            <DomainCard title="Target Moves" icon={<Target className="w-3.5 h-3.5 text-primary" />}>
              {!targetMovesStats ? (
                <p className="text-[11px] text-muted-foreground">No moves detected. Run "Detect Moves" first.</p>
              ) : (
                <>
                  <StatRow label="Total moves" value={targetMovesStats.totalMoves} />
                  <StatRow
                    label="Median magnitude %"
                    value={targetMovesStats.medianMagnitudePct != null
                      ? `${(targetMovesStats.medianMagnitudePct * 100).toFixed(2)}%`
                      : ""}
                  />
                  <StatRow
                    label="Median raw quality score"
                    value={targetMovesStats.medianQualityScore != null
                      ? targetMovesStats.medianQualityScore.toFixed(1)
                      : ""}
                  />
                  {/* Avg hold from aggregate (computed from same moves table) */}
                  {aggregate?.overall && (
                    <>
                      <StatRow label="Avg move %" value={`${aggregate.overall.avgMovePct.toFixed(1)}%`} />
                      <StatRow label="Avg hold (hrs)" value={aggregate.overall.avgHoldHours?.toFixed(1) ?? ""} />
                      <StatRow label="Direction up/down" value={`${aggregate.overall.directionSplit?.up ?? 0} / ${aggregate.overall.directionSplit?.down ?? 0}`} />
                    </>
                  )}
                  <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">By family</p>
                    {Object.entries(targetMovesStats.moveTypeDistribution).map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between text-[11px]">
                        <TypePill type={type} />
                        <span className="font-mono text-foreground">{count}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 pt-1.5 border-t border-border/20">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Quality dist.</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(targetMovesStats.qualityDistribution).map(([tier, cnt]) => (
                        <span key={tier} className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
                          {tier}: {cnt}
                        </span>
                      ))}
                    </div>
                  </div>
                  {aggregate?.overall && Object.keys(aggregate.overall.leadInShapes ?? {}).length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Lead-in shapes</p>
                      {Object.entries(aggregate.overall.leadInShapes).slice(0, 4).map(([shape, cnt]) => (
                        <div key={shape} className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">{shape}</span>
                          <span className="font-mono text-foreground">{cnt as number}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </DomainCard>

            {/* Domain C  Recommended Calibration (from stored profile, post AI passes) */}
            <DomainCard title="Recommended Calibration" icon={<Zap className="w-3.5 h-3.5 text-sky-400" />}>
              {!calibProfile && !researchProfile ? (
                <p className="text-[11px] text-muted-foreground">No calibration profile yet. Detect moves then run the calibration pipeline to populate.</p>
              ) : !calibProfile && researchProfile ? (
                <>
                  <StatRow label="Status" value={researchProfile.researchStatus ?? "research_complete"} />
                  <StatRow label="Move count" value={researchProfile.moveCount ?? ""} />
                  <StatRow label="Entry model" value={researchProfile.recommendedEntryModel ?? ""} />
                  <StatRow label="Est. trades / month" value={researchProfile.estimatedTradesPerMonth?.toFixed?.(1) ?? ""} />
                  <StatRow label="Scan cadence" value={researchProfile.recommendedScanIntervalSeconds ? formatDurationCompact(researchProfile.recommendedScanIntervalSeconds) : ""} />
                  <StatRow label="Engine recommendation" value={researchProfile.engineTypeRecommendation ?? ""} />
                  {researchProfile.moveFamilyDistribution && Object.keys(researchProfile.moveFamilyDistribution).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border/20">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Move family distribution</p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(researchProfile.moveFamilyDistribution).map(([family, count]) => (
                          <span key={family} className="text-[10px] px-1.5 py-0.5 rounded border border-sky-500/20 bg-sky-500/10 text-sky-200">
                            {family}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : ((calibProfile: CalibrationProfile) => (
                <>
                  <StatRow label="Fit score" value={`${(calibProfile.fitScore * 100).toFixed(1)}%`} />
                  <StatRow label="Target / captured" value={`${calibProfile.capturedMoves} / ${calibProfile.targetMoves}`} />
                  <StatRow label="Avg move %" value={`${calibProfile.avgMovePct.toFixed(1)}%`} />
                  <StatRow label="Avg hold (hrs)" value={calibProfile.avgHoldingHours.toFixed(1)} />
                  <StatRow label="Avg capturable %" value={`${(calibProfile.avgCaptureablePct * 100).toFixed(1)}%`} />
                  <StatRow label="Holdability score" value={calibProfile.avgHoldabilityScore.toFixed(2)} />
                  {calibProfile.feeddownSchema && (() => {
                    const fd = calibProfile.feeddownSchema as Record<string, unknown>;
                    const families = Array.isArray(fd["familiesDiscovered"]) ? fd["familiesDiscovered"] as unknown[] : [];
                    const bucketModels = Array.isArray(fd["bucketModels"]) ? fd["bucketModels"] as Array<Record<string, unknown>> : [];
                    if (families.length === 0 && bucketModels.length === 0) return null;
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-cyan-400/80 uppercase tracking-wide cursor-pointer hover:text-cyan-300">
                          Deterministic Family And Bucket Models
                        </summary>
                        {families.length > 0 && (
                          <div className="mt-1">
                            <p className="text-[10px] text-muted-foreground mb-0.5">Families discovered from data</p>
                            <div className="flex flex-wrap gap-1">
                              {families.map((family, i) => (
                                <span key={`${String(family)}-${i}`} className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
                                  {String(family)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {bucketModels.length > 0 && (
                          <div className="mt-1 space-y-1">
                            <p className="text-[10px] text-muted-foreground mb-0.5">Bucket models</p>
                            {bucketModels.slice(0, 8).map((bucket, i) => (
                              <div key={`${String(bucket["strategyFamily"] ?? "bucket")}-${String(bucket["movePctBucket"] ?? i)}`} className="bg-muted/20 rounded p-1.5 space-y-0.5">
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-foreground font-medium">{String(bucket["strategyFamily"] ?? "unknown")}</span>
                                  <span className="font-mono text-cyan-300">{String(bucket["movePctBucket"] ?? "all")}</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-muted-foreground">Move count</span>
                                  <span className="font-mono text-foreground">{String(bucket["moveCount"] ?? "-")}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </details>
                    );
                  })()}
                  {/* Pass 1: Precursor Card */}
                  {calibProfile.precursorSummary && (() => {
                    const ps = calibProfile.precursorSummary as Record<string, unknown>;
                    const topConditions: unknown[] = (ps["topConditions"] ?? ps["conditions"] ?? ps["leadInPatterns"] ?? []) as unknown[];
                    const avgBars = ps["avgLeadInBars"] ?? ps["avgBars"] ?? ps["lookbackBars"];
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-amber-400/80 uppercase tracking-wide cursor-pointer hover:text-amber-300">
                          Pass 1  Precursor Conditions
                        </summary>
                        <div className="mt-1 space-y-0.5">
                          {avgBars != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Avg lead-in bars</span>
                              <span className="font-mono text-foreground">{String(avgBars)}</span>
                            </div>
                          )}
                          {Array.isArray(topConditions) && topConditions.length > 0 && (
                            <div className="mt-0.5">
                              <p className="text-[10px] text-muted-foreground mb-0.5">Top conditions</p>
                              {topConditions.slice(0, 5).map((c, i) => (
                                <p key={i} className="text-[11px] text-foreground bg-muted/20 rounded px-1 py-0.5 mb-0.5">
                                  {typeof c === "string" ? c : JSON.stringify(c)}
                                </p>
                              ))}
                            </div>
                          )}
                          {avgBars == null && (!Array.isArray(topConditions) || topConditions.length === 0) && (
                            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 overflow-x-auto max-h-20 whitespace-pre-wrap break-all">
                              {JSON.stringify(calibProfile.precursorSummary, null, 2)}
                            </pre>
                          )}
                        </div>
                      </details>
                    );
                  })()}
                  {/* Pass 2: Trigger Zone Card */}
                  {calibProfile.triggerSummary && (() => {
                    const ts2 = calibProfile.triggerSummary as Record<string, unknown>;
                    const triggerType = ts2["triggerType"] ?? ts2["type"] ?? ts2["entrySignalType"];
                    const confirmBars = ts2["confirmationBars"] ?? ts2["confirmBars"];
                    const invalidation = ts2["invalidationConditions"] ?? ts2["invalidation"];
                    const entryConditions: unknown[] = (ts2["entryConditions"] ?? ts2["conditions"] ?? []) as unknown[];
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-sky-400/80 uppercase tracking-wide cursor-pointer hover:text-sky-300">
                          Pass 2  Trigger Zone (In-Move Behavior)
                        </summary>
                        <div className="mt-1 space-y-0.5">
                          {triggerType != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Trigger type</span>
                              <span className="font-mono text-foreground">{String(triggerType)}</span>
                            </div>
                          )}
                          {confirmBars != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Confirm bars</span>
                              <span className="font-mono text-foreground">{String(confirmBars)}</span>
                            </div>
                          )}
                          {Array.isArray(entryConditions) && entryConditions.length > 0 && (
                            <div className="mt-0.5">
                              <p className="text-[10px] text-muted-foreground mb-0.5">Entry conditions</p>
                              {entryConditions.slice(0, 4).map((c, i) => (
                                <p key={i} className="text-[11px] text-foreground bg-muted/20 rounded px-1 py-0.5 mb-0.5">
                                  {typeof c === "string" ? c : JSON.stringify(c)}
                                </p>
                              ))}
                            </div>
                          )}
                          {invalidation != null && (
                            <div className="mt-0.5">
                              <span className="text-[10px] text-muted-foreground">Invalidation: </span>
                              <span className="text-[11px] text-red-400">{typeof invalidation === "string" ? invalidation : JSON.stringify(invalidation)}</span>
                            </div>
                          )}
                          {triggerType == null && (!Array.isArray(entryConditions) || entryConditions.length === 0) && (
                            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 overflow-x-auto max-h-20 whitespace-pre-wrap break-all">
                              {JSON.stringify(calibProfile.triggerSummary, null, 2)}
                            </pre>
                          )}
                        </div>
                      </details>
                    );
                  })()}
                  {/* Pass 3: In-Move Behavior Card  behavior pass structural metrics */}
                  <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                    <summary className="text-[10px] text-violet-400/80 uppercase tracking-wide cursor-pointer hover:text-violet-300">
                      Pass 3  In-Move Behavior
                    </summary>
                    <div className="mt-1 space-y-0.5">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Avg capturable %</span>
                        <span className="font-mono text-foreground">{(calibProfile.avgCaptureablePct * 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Avg holdability</span>
                        <span className="font-mono text-foreground">{calibProfile.avgHoldabilityScore.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Avg hold (hrs)</span>
                        <span className="font-mono text-foreground">{calibProfile.avgHoldingHours.toFixed(1)}</span>
                      </div>
                      {aggregate?.overall?.avgMfe != null && (
                        <div className="flex justify-between text-[11px]">
                          <span className="text-muted-foreground">Avg MFE</span>
                          <span className="font-mono text-emerald-400">{aggregate.overall.avgMfe.toFixed(2)}%</span>
                        </div>
                      )}
                      {aggregate?.overall?.behaviorPatterns && Object.keys(aggregate.overall.behaviorPatterns).length > 0 && (
                        <div className="mt-0.5">
                          <p className="text-[10px] text-muted-foreground mb-0.5">Move behavior patterns</p>
                          {Object.entries(aggregate.overall.behaviorPatterns)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 5)
                            .map(([pattern, cnt]) => (
                              <div key={pattern} className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground capitalize">{pattern}</span>
                                <span className="font-mono text-foreground">{cnt}</span>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </details>
                  {calibProfile.feeddownSchema && (() => {
                    const fd = calibProfile.feeddownSchema as Record<string, unknown>;
                    const scanCadence = fd["scanCadenceMins"] ?? fd["scanCadenceRecommendation"] ?? fd["scanCadence"];
                    const memWindow = fd["memoryWindowDays"] ?? fd["lookbackDays"] ?? fd["memoryWindow"];
                    const entryModel = fd["entryModel"] ?? fd["entryModelSummary"] ?? fd["entryModelDescription"];
                    const tradeMgmt = fd["tradeManagement"] ?? fd["tradeManagementModel"] ?? fd["tradeManagementDescription"];
                    const knownKeys = new Set(["scanCadenceMins","scanCadenceRecommendation","scanCadence","memoryWindowDays","lookbackDays","memoryWindow","entryModel","entryModelSummary","entryModelDescription","tradeManagement","tradeManagementModel","tradeManagementDescription"]);
                    const remainderKeys = Object.keys(fd).filter(k => !knownKeys.has(k));
                    return (
                      <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-1">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Recommended Settings</p>
                        {scanCadence != null && (
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Scan cadence</span>
                            <span className="font-mono text-foreground">{String(scanCadence)}</span>
                          </div>
                        )}
                        {memWindow != null && (
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Memory window</span>
                            <span className="font-mono text-foreground">{String(memWindow)}</span>
                          </div>
                        )}
                        {entryModel != null && (
                          <div className="mt-1">
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Entry model</span>
                            <p className="text-[11px] text-foreground mt-0.5 bg-muted/20 rounded p-1">
                              {typeof entryModel === "string" ? entryModel : JSON.stringify(entryModel)}
                            </p>
                          </div>
                        )}
                        {tradeMgmt != null && (
                          <div className="mt-1">
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Trade management</span>
                            <p className="text-[11px] text-foreground mt-0.5 bg-muted/20 rounded p-1">
                              {typeof tradeMgmt === "string" ? tradeMgmt : JSON.stringify(tradeMgmt)}
                            </p>
                          </div>
                        )}
                        {remainderKeys.length > 0 && (
                          <details className="mt-1">
                            <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                              More fields ({remainderKeys.length})
                            </summary>
                            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 mt-1 overflow-x-auto max-h-28 whitespace-pre-wrap break-all">
                              {JSON.stringify(Object.fromEntries(remainderKeys.map(k => [k, fd[k]])), null, 2)}
                            </pre>
                          </details>
                        )}
                        {!scanCadence && !memWindow && !entryModel && !tradeMgmt && (
                          <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
                            {JSON.stringify(calibProfile.feeddownSchema, null, 2)}
                          </pre>
                        )}
                      </div>
                    );
                  })()}
                  {/* Pass 4: Best Extraction Path Card */}
                  {(() => {
                    const ps = calibProfile.profitabilitySummary;
                    if (!ps || !ps.paths || ps.paths.length === 0) return null;
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-emerald-400/80 uppercase tracking-wide cursor-pointer hover:text-emerald-300">
                          Pass 4  Best Extraction Path
                        </summary>
                        <div className="mt-1 space-y-1.5">
                          {ps.topPath && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Top path</span>
                              <span className="font-mono text-emerald-400">{ps.topPath}</span>
                            </div>
                          )}
                          {ps.estimatedFitAdjustedReturn != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Est. fit-adj. return</span>
                              <span className="font-mono text-foreground">
                                {(ps.estimatedFitAdjustedReturn * 100).toFixed(1)}%
                              </span>
                            </div>
                          )}
                          {ps.paths.slice(0, 4).map((path, i) => (
                            <div key={path.name ?? i} className="bg-muted/20 rounded p-1.5 space-y-0.5">
                              <p className="text-[10px] font-semibold text-foreground">{path.name}</p>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">Monthly return</span>
                                <span className={cn("font-mono", path.estimatedMonthlyReturnPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                                  {(path.estimatedMonthlyReturnPct * 100).toFixed(1)}%
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">Capturable  hold</span>
                                <span className="font-mono text-foreground">
                                  {(path.captureablePct * 100).toFixed(0)}%  {path.holdDays}d
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">Confidence</span>
                                <span className="font-mono text-foreground">{path.confidence}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })()}
                  {engines.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-1">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Engine coverage</p>
                      {engines.map((eng) => (
                        <div key={eng.engineName ?? "unknown"} className="space-y-0.5">
                          <p className="text-[10px] font-semibold text-foreground truncate">{eng.engineName ?? ""}</p>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Matched / fire rate</span>
                            <span className="font-mono text-foreground">{eng.matchedMoves}  {(eng.fireRate * 100).toFixed(1)}%</span>
                          </div>
                          {(eng.topMissReasons?.length ?? 0) > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              Miss: {(eng.topMissReasons ?? []).slice(0, 2).join("  ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Built {new Date(calibProfile.generatedAt).toLocaleDateString()}  window {calibProfile.windowDays}d
                  </p>
                </>
              ))(calibProfile as CalibrationProfile)}
            </DomainCard>

          </div>
        )}
      </div>

      {/*  Honest Fit & Profitability  */}
      {(calibrationCoverage || calibProfile?.profitabilitySummary) && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Target className="w-3.5 h-3.5 text-primary" />
            Honest Fit &amp; Profitability
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Fit stats */}
            <div className="space-y-0.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Move Coverage</p>
              {calibrationCoverage && (
                <>
                  <StatRow label="Source" value={calibrationCoverage.source} />
                  <StatRow label="Target moves" value={calibrationCoverage.targetMoves} />
                  <StatRow label="Captured moves" value={calibrationCoverage.capturedMoves} />
                  <StatRow label="Missed moves" value={calibrationCoverage.missedMoves} />
                  <StatRow label="Fit score" value={`${(calibrationCoverage.fitScore * 100).toFixed(1)}%`} />
                  <StatRow label="Avg move %" value={`${calibrationCoverage.avgMovePct.toFixed(2)}%`} />
                  <StatRow label="Avg capturable %" value={`${(calibrationCoverage.avgCaptureablePct * 100).toFixed(1)}%`} />
                  <StatRow
                    label="Avg extracted (est.)"
                    value={`${(calibrationCoverage.avgMovePct * calibrationCoverage.avgCaptureablePct).toFixed(2)}%`}
                  />
                  <StatRow label="Holdability score" value={calibrationCoverage.avgHoldabilityScore.toFixed(2)} />
                  {calibProfile && aggregate?.overall && aggregate.overall.capturedMoves !== calibProfile.capturedMoves && (
                    <p className="text-[10px] text-amber-300/90 pt-1">
                      Current engine replay is {aggregate.overall.capturedMoves}/{aggregate.overall.targetMoves}; synthesized calibration is shown above.
                    </p>
                  )}
                  {behaviorProfile && (
                    <StatRow label="Engine win rate" value={`${(behaviorProfile.overallWinRate * 100).toFixed(1)}%`} />
                  )}
                </>
              )}
              {(aggregate?.overall?.missReasons?.length ?? 0) > 0 && (
                <div className="mt-2 pt-2 border-t border-border/20">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Miss reasons</p>
                  {(aggregate!.overall.missReasons ?? []).slice(0, 4).map((mr) => (
                    <div key={mr.reason} className="flex justify-between text-[11px]">
                      <span className="text-muted-foreground truncate max-w-[180px]">{mr.reason}</span>
                      <span className="font-mono text-foreground">{mr.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Profitability paths */}
            <div className="space-y-0.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Profitability Paths</p>
              {!calibProfile?.profitabilitySummary ? (
                <p className="text-[11px] text-muted-foreground">Run AI passes (extraction) to generate profitability estimates.</p>
              ) : (
                <>
                  <StatRow label="Top path" value={calibProfile.profitabilitySummary.topPath ?? ""} />
                  <StatRow
                    label="Fit-adjusted return"
                    value={calibProfile.profitabilitySummary.estimatedFitAdjustedReturn != null
                      ? `${(calibProfile.profitabilitySummary.estimatedFitAdjustedReturn * 100).toFixed(1)}%/mo`
                      : ""}
                  />
                  {(calibProfile.profitabilitySummary.paths ?? []).map((path) => (
                    <div key={path.name} className="mt-1.5 pt-1.5 border-t border-border/20">
                      <p className="text-[10px] font-semibold text-foreground mb-0.5">{path.name}</p>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Monthly return</span>
                        <span className={cn("font-mono", path.estimatedMonthlyReturnPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                          {(path.estimatedMonthlyReturnPct * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Annualized</span>
                        <span className="font-mono text-foreground">
                          {(path.estimatedMonthlyReturnPct * 12 * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Capturable %</span>
                        <span className="font-mono text-foreground">{(path.captureablePct * 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Hold (days)</span>
                        <span className="font-mono text-foreground">{path.holdDays.toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Confidence</span>
                        <span className="font-mono text-foreground">{path.confidence}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {researchProfile && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-primary" />
              Research Profile Output
            </h3>
            <span
              className={cn(
                "text-[11px] px-2 py-0.5 rounded border font-medium",
                domain === "active"
                  ? "text-sky-300 border-sky-500/30 bg-sky-500/10"
                  : researchProfile.researchStatus === "engine_candidate"
                    ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                    : researchProfile.researchStatus === "not_worth_building"
                      ? "text-red-300 border-red-500/30 bg-red-500/10"
                      : "text-amber-300 border-amber-500/30 bg-amber-500/10"
              )}
            >
              {domain === "active"
                ? "Engine Refinement Ready"
                : researchProfile.researchStatus === "engine_candidate"
                  ? "Engine Candidate"
                  : researchProfile.researchStatus === "not_worth_building"
                    ? "Not Worth Building"
                    : "Research Complete"}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-0.5">
              <StatRow label="Move count" value={researchProfile.moveCount ?? ""} />
              <StatRow label="Estimated trades / month" value={researchProfile.estimatedTradesPerMonth?.toFixed?.(1) ?? ""} />
              <StatRow label="Scan cadence" value={researchProfile.recommendedScanIntervalSeconds ? formatDurationCompact(researchProfile.recommendedScanIntervalSeconds) : ""} />
              <StatRow label="Entry model" value={researchProfile.recommendedEntryModel ?? ""} />
              <StatRow
                label="Hold duration bands"
                value={(() => {
                  const h = researchProfile.recommendedHoldProfile ?? {};
                  const p25 = Number(h.p25Hours ?? 0);
                  const p50 = Number(h.p50Hours ?? 0);
                  const p75 = Number(h.p75Hours ?? 0);
                  return `${p25.toFixed(1)}h / ${p50.toFixed(1)}h / ${p75.toFixed(1)}h`;
                })()}
              />
            </div>
            <div className="space-y-0.5">
              <StatRow
                label="TP model"
                value={formatModelDetails(researchProfile.recommendedTpModel, "tp") || "n/a"}
              />
              <StatRow
                label="SL model"
                value={formatModelDetails(researchProfile.recommendedSlModel, "sl") || "n/a"}
              />
              <StatRow
                label="Trailing model"
                value={formatModelDetails(researchProfile.recommendedTrailingModel, "trailing") || "n/a"}
              />
              <StatRow label="Profitability summary" value={researchProfile.estimatedFitAdjustedMonthlyReturnPct != null ? `${researchProfile.estimatedFitAdjustedMonthlyReturnPct.toFixed(2)}%/mo` : ""} />
              <StatRow label="Engine recommendation" value={researchProfile.engineTypeRecommendation ?? ""} />
            </div>
          </div>
          {(researchProfile.moveFamilyDistribution && Object.keys(researchProfile.moveFamilyDistribution).length > 0) && (
            <div className="pt-2 border-t border-border/20">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Move family distribution</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(researchProfile.moveFamilyDistribution).map(([family, count]) => (
                  <span key={family} className="px-1.5 py-0.5 rounded border border-border/40 text-[10px] text-foreground bg-muted/20">
                    {family}: {count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-sky-400" />
            Runtime Feeddown
          </h3>
          <span
            className={cn(
              "text-[11px] px-2 py-0.5 rounded border font-medium",
              runtimeModel?.lifecycle?.hasPromotedModel
                ? runtimeModel.lifecycle.driftPendingPromotion
                  ? "text-amber-300 border-amber-500/30 bg-amber-500/10"
                  : "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                : "text-slate-300 border-border/40 bg-muted/20"
            )}
          >
            {runtimeModel?.lifecycle?.hasPromotedModel
              ? runtimeModel.lifecycle.driftPendingPromotion
                ? "Promotion stale"
                : "Runtime promoted"
              : "Research only"}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Latest Research</p>
            <StatRow label="Run" value={runtimeModel?.lifecycle?.latestRunId ?? researchProfile?.lastRunId ?? "n/a"} />
            <StatRow label="Entry model" value={runtimeModel?.researchProfile?.recommendedEntryModel ?? researchProfile?.recommendedEntryModel ?? "n/a"} />
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Staged Model</p>
            <StatRow label="Run" value={runtimeModel?.lifecycle?.stagedRunId ?? "none"} />
            <StatRow label="Entry model" value={runtimeModel?.stagedModel?.entryModel ?? "n/a"} />
            <StatRow label="Staged at" value={formatRuntimeDate(runtimeModel?.lifecycle?.stagedAt ?? runtimeModel?.stagedModel?.promotedAt)} />
            <StatRow label="TP buckets" value={runtimeModel?.lifecycle?.stagedTpBucketCount ?? 0} />
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Promoted Runtime</p>
            <StatRow label="Run" value={runtimeModel?.lifecycle?.promotedRunId ?? "none"} />
            <StatRow label="Source" value={runtimeModel?.lifecycle?.runtimeSource ?? "none"} />
            <StatRow label="Promoted at" value={formatRuntimeDate(runtimeModel?.lifecycle?.promotedAt ?? runtimeModel?.promotedModel?.promotedAt)} />
            <StatRow label="TP buckets" value={runtimeModel?.lifecycle?.promotedTpBucketCount ?? 0} />
          </div>
        </div>

        {runtimeErr && <ErrorBox msg={runtimeErr} />}
        {runtimeNotice && <SuccessBox msg={runtimeNotice} />}
        {runtimeModel?.lifecycle?.hasStagedModel && runtimeModel?.lifecycle?.hasPromotedModel && runtimeModel.lifecycle.promotedMatchesStaged === false && (
          <ErrorBox msg="Staged model is newer than promoted runtime. Backtest/live is not using the staged model until you click Promote To Runtime." />
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => updateRuntimeModel("stage")}
            disabled={runtimeBusy !== null || !researchProfile}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/30 text-xs text-sky-200 bg-sky-500/10 hover:bg-sky-500/15 disabled:opacity-50"
            title="Compile the latest research profile into a staged runtime model without changing live runtime ownership"
          >
            {runtimeBusy === "stage" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            Stage Research Model
          </button>
          <button
            type="button"
            onClick={() => updateRuntimeModel("promote")}
            disabled={runtimeBusy !== null || !researchProfile}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-xs text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/15 disabled:opacity-50"
            title="Promote the currently staged runtime model into the runtime store used by backtest/live"
          >
            {runtimeBusy === "promote" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Promote To Runtime
          </button>
          <button
            type="button"
            onClick={() => void runParityReport()}
            disabled={parityBusy || runtimeBusy !== null || !runtimeModel?.lifecycle?.hasPromotedModel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-500/30 text-xs text-indigo-200 bg-indigo-500/10 hover:bg-indigo-500/15 disabled:opacity-50"
            title="Run CRASH300 parity report with one verdict per calibrated move"
          >
            {parityBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Run Parity
          </button>
          <p className="text-[11px] text-muted-foreground self-center">
            Promotion is the explicit handoff from research into the model layer above the V3 engine.
          </p>
        </div>

        <div className="rounded-lg border border-border/30 bg-muted/10 p-3">
          <p className="text-[11px] font-semibold text-foreground mb-2">CRASH300 workflow</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-1 text-[11px] text-muted-foreground">
            <span>1. Run Full Calibration</span>
            <span>2. Stage Research Model</span>
            <span>3. Promote Staged Runtime Model</span>
            <span>4. Run Parity</span>
            <span>5. Run Backtest</span>
            <span>6. Run Paper</span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Optimiser is optional and stays locked until parity reports at least one matched move.
          </p>
        </div>

        {parityErr && <ErrorBox msg={parityErr} />}
        {parityReport && (
          <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs font-semibold text-indigo-200">CRASH300 Parity Diagnostics</p>
              <span className={cn(
                "text-[11px] px-2 py-0.5 rounded border",
                parityHasAnyMatches
                  ? "text-emerald-200 border-emerald-500/30 bg-emerald-500/10"
                  : "text-amber-200 border-amber-500/30 bg-amber-500/10",
              )}>
                matched {parityMatchedMoves}/{Number(parityTotals?.totalMoves ?? 0)}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">No candidate</span><p className="font-mono">{Number(parityTotals?.noCandidate ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Family mismatch</span><p className="font-mono">{Number(parityTotals?.familyMismatch ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Direction mismatch</span><p className="font-mono">{Number(parityTotals?.directionMismatch ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Bucket mismatch</span><p className="font-mono">{Number(parityTotals?.bucketMismatch ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Setup evidence failed</span><p className="font-mono">{Number(parityTotals?.setupEvidenceFailed ?? 0)}</p></div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Top failure reasons</p>
                {parityFailureRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityFailureRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Direction matrix</p>
                {parityDirectionRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityDirectionRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Selected runtime family</p>
                {parityFamilyRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityFamilyRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Selected bucket</p>
                {parityBucketRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityBucketRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5 md:col-span-2">
                <p className="text-muted-foreground mb-1">Top failing gate components</p>
                <p className="font-mono">no_coordinator_output: {Number(parityDiagnostics?.noCoordinatorOutput ?? 0)} | runtime_calibrated_setup_weak: {Number(parityDiagnostics?.runtimeCalibratedSetupWeak ?? 0)}</p>
                {parityGateRows.length === 0 ? <p className="font-mono text-muted-foreground mt-1">n/a</p> : parityGateRows.map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-xs font-semibold text-cyan-200">Backtest Calibration Optimiser</p>
              <p className="text-[11px] text-muted-foreground">
                Runs V3 backtest candidates against calibrated moves. Winners are staged only, never auto-promoted.
              </p>
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded border border-cyan-500/25 text-cyan-200 bg-cyan-500/10">
              {String(optimiserRun?.status ?? optimiserStatus?.status ?? "not run")}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runBacktestOptimiser}
              disabled={optimiserBusy !== null || !runtimeModel?.lifecycle?.hasPromotedModel || optimiserLockedByParity}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/30 text-xs text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/15 disabled:opacity-50"
            >
              {optimiserBusy === "run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BarChart2 className="w-3.5 h-3.5" />}
              Run Optimiser
            </button>
            {optimiserHasExistingRun && (
              <>
                <button
                  type="button"
                  onClick={cancelOptimiser}
                  disabled={optimiserBusy !== null || !optimiserRunId || !optimiserIsRunning}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-xs text-red-300 bg-red-500/10 hover:bg-red-500/15 disabled:opacity-50"
                >
                  {optimiserBusy === "cancel" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                  Cancel Optimiser
                </button>
                <button
                  type="button"
                  onClick={() => void refreshOptimiserStatus()}
                  disabled={optimiserBusy !== null || !optimiserRunId}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/40 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {optimiserBusy === "refresh" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Refresh Optimiser
                </button>
                <button
                  type="button"
                  onClick={stageOptimiserWinner}
                  disabled={optimiserBusy !== null || !optimiserRunId || !optimiserSelected}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-xs text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/15 disabled:opacity-50"
                >
                  {optimiserBusy === "stage" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  Stage Optimised Winner
                </button>
              </>
            )}
          </div>
          {optimiserLockedByParity && (
            <ErrorBox msg="Optimiser disabled: CRASH300 runtime does not recognise calibrated moves yet." />
          )}
          {!optimiserHasExistingRun && (
            <p className="text-[11px] text-muted-foreground">
              Optimiser run controls (refresh/cancel/stage) will appear after a valid optimiser run exists.
            </p>
          )}

          {optimiserErr && <ErrorBox msg={optimiserErr} />}
          {optimiserRun && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[11px]">
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Phase</span>
                <p className="font-mono text-foreground">{optimiserPhase}</p>
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Iteration</span>
                <p className="font-mono text-foreground">{String(optimiserRun?.currentIteration ?? "n/a")}</p>
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Candidate</span>
                <p className="font-mono text-foreground">{String(optimiserRun?.currentCandidate ?? "n/a")}</p>
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Heartbeat</span>
                <p className="font-mono text-foreground">{optimiserHeartbeat}</p>
              </div>
            </div>
          )}
          {optimiserFailureReason && (
            <ErrorBox msg={`Optimiser failed: ${optimiserFailureReason}`} />
          )}
          {optimiserFailureStack && (
            <details className="rounded border border-border/30 bg-background/30 p-2">
              <summary className="text-[11px] text-muted-foreground cursor-pointer">Failure stack trace</summary>
              <pre className="mt-2 text-[10px] overflow-x-auto whitespace-pre-wrap text-red-300 font-mono">
                {optimiserFailureStack}
              </pre>
            </details>
          )}

          {(optimiserBaseline || optimiserWinnerMetrics) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-border/30 bg-background/30 p-3 space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Baseline</p>
                <StatRow label="Profit factor" value={Number(optimiserBaseline?.profitFactor ?? 0).toFixed(2)} />
                <StatRow label="Total P&L" value={`${(Number(optimiserBaseline?.totalPnlPct ?? 0) * 100).toFixed(2)}%`} />
                <StatRow label="Win rate" value={`${(Number(optimiserBaseline?.winRate ?? 0) * 100).toFixed(1)}%`} />
                <StatRow label="Drawdown" value={`${(Number(optimiserBaseline?.maxDrawdownPct ?? 0) * 100).toFixed(1)}%`} />
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Selected Winner</p>
                <StatRow label="Candidate" value={String(optimiserWinner?.params ? (optimiserWinner.params as Record<string, unknown>).key ?? "winner" : "winner")} />
                <StatRow label="Profit factor" value={Number(optimiserWinnerMetrics?.profitFactor ?? 0).toFixed(2)} />
                <StatRow label="Total P&L" value={`${(Number(optimiserWinnerMetrics?.totalPnlPct ?? 0) * 100).toFixed(2)}%`} />
                <StatRow label="Win rate" value={`${(Number(optimiserWinnerMetrics?.winRate ?? 0) * 100).toFixed(1)}%`} />
                <StatRow label="Drawdown" value={`${(Number(optimiserWinnerMetrics?.maxDrawdownPct ?? 0) * 100).toFixed(1)}%`} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/*  Detected Moves List  */}
      <div className="rounded-xl border border-border/50 bg-card">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">Detected Moves</span>
            <span className="text-[11px] text-muted-foreground">({moveRows.length} shown)</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={moveTypeFilter}
              onChange={e => setMoveTypeFilter(e.target.value)}
              className="text-[11px] bg-background border border-border/50 rounded px-1.5 py-1 text-foreground focus:outline-none"
            >
              {moveTypesFilterForSymbol(symbol).map(t => (
                <option key={t} value={t}>{t === "all" ? "All types" : formatMoveTypeLabel(t)}</option>
              ))}
            </select>
          </div>
        </div>

        {movesLoading && (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />Loading moves
          </div>
        )}

        {!movesLoading && movesMagnitudeSummary && (
          <div className="px-4 py-2.5 border-b border-border/20 bg-muted/10">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
              <span className="text-muted-foreground uppercase tracking-wide text-[10px] font-medium self-center">Magnitude</span>
              <span>Min: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.min * 100).toFixed(2)}%</strong></span>
              <span>P25: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.p25 * 100).toFixed(2)}%</strong></span>
              <span>Median: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.median * 100).toFixed(2)}%</strong></span>
              <span>P75: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.p75 * 100).toFixed(2)}%</strong></span>
              <span>P90: <strong className="font-mono text-primary">{(movesMagnitudeSummary.p90 * 100).toFixed(2)}%</strong></span>
              <span>Max: <strong className="font-mono text-emerald-400">{(movesMagnitudeSummary.max * 100).toFixed(2)}%</strong></span>
            </div>
          </div>
        )}

        {!movesLoading && moves.length === 0 && (
          <div className="px-4 py-6 text-center">
            <Target className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">No moves found. Run "Detect Moves" first or adjust filters.</p>
          </div>
        )}

        {!movesLoading && moves.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/30 text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-3 py-2 font-medium">Tier</th>
                    <th className="text-left px-3 py-2 font-medium">Dir</th>
                    <th className="text-left px-3 py-2 font-medium">Move %</th>
                    <th className="text-left px-3 py-2 font-medium">Hold (h)</th>
                    <th className="text-left px-3 py-2 font-medium">Quality %</th>
                    <th className="text-left px-3 py-2 font-medium">Lead-in</th>
                    <th className="text-left px-3 py-2 font-medium">Start</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedMoves.map((m) => (
                    <tr key={m.id} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-1.5"><TypePill type={m.moveType} /></td>
                      <td className="px-3 py-1.5"><TierPill tier={m.relativeTier} /></td>
                      <td className="px-3 py-1.5">
                        {m.direction === "up"
                          ? <TrendingUp   className="w-3.5 h-3.5 text-emerald-400" />
                          : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.movePct != null ? `${(m.movePct * 100).toFixed(1)}%` : ""}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.holdingMinutes != null ? (m.holdingMinutes / 60).toFixed(1) : ""}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.qualityPercentile != null
                          ? `${m.qualityPercentile}%`
                          : m.qualityScore != null ? m.qualityScore.toFixed(0) : ""}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{m.leadInShape ?? ""}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {m.startTs ? new Date(m.startTs * 1000).toLocaleDateString() : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {moveRows.length > 10 && (
              <button
                onClick={() => setMovesExpanded(p => !p)}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground hover:text-foreground border-t border-border/30 transition-colors"
              >
                {movesExpanded
                  ? <><ChevronUp className="w-3.5 h-3.5" />Show less</>
                  : <><ChevronDown className="w-3.5 h-3.5" />Show all {moveRows.length} moves</>}
              </button>
            )}
          </>
        )}
      </div>

      {/*  Export Buttons  */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Export Calibration Data</h3>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => doExport("moves", `calibration/export/${symbol}?type=moves`, `calibration_moves_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["moves"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export all detected structural moves for this symbol"
          >
            {exportBusy["moves"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Detected Moves
          </button>

          <button
            onClick={() => doExport("passes", `calibration/export/${symbol}?type=passes`, `calibration_passes_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["passes"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export all AI pass run records for this symbol"
          >
            {exportBusy["passes"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Pass Results
          </button>

          <button
            onClick={() => doExport("profile", `calibration/export/${symbol}?type=profile`, `calibration_profile_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["profile"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export stored calibration profiles (all move types) for this symbol"
          >
            {exportBusy["profile"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Calibration Profile
          </button>

          <button
            onClick={() => doExport("comparison", `calibration/export/${symbol}?type=comparison`, `calibration_comparison_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["comparison"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export 3-domain comparison summary (aggregate + engine + scoring + health)"
          >
            {exportBusy["comparison"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Comparison Summary
          </button>

          <button
            onClick={() => doExport("parity", `calibration/runtime-model/${symbol}/parity-report?windowDays=${windowDays}`, `calibration_parity_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["parity"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export per-move CRASH300 parity verdicts using the symbol-service runtime flow"
          >
            {exportBusy["parity"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Parity Report
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          All exports are read-only research artifacts. None of these outputs are connected to live execution.
        </p>
        <div className="border-t border-border/30 pt-3 space-y-2">
          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Import Calibration Data</h4>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Type</span>
              <select
                value={importType}
                onChange={e => setImportType(e.target.value as typeof importType)}
                className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="auto">Auto detect</option>
                <option value="moves">Detected moves</option>
                <option value="passes">Pass results</option>
                <option value="profile">Calibration profile</option>
                <option value="comparison">Comparison</option>
              </select>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer pb-1">
              <input
                type="checkbox"
                checked={importReplace}
                onChange={e => setImportReplace(e.target.checked)}
                className="accent-primary"
              />
              Replace existing
            </label>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              className="hidden"
              onChange={e => void importCalibrationFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importBusy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            >
              {importBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              {importBusy ? "Importing..." : "Import JSON Files"}
            </button>
          </div>
          {importMessage && <SuccessBox msg={importMessage} />}
          {importError && <ErrorBox msg={importError} />}
        </div>
      </div>

      {/*  Run History  */}
      <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
        <button
          onClick={() => {
            if (!runsExpanded) loadRuns(symbol);
            setRunsExpanded(v => !v);
          }}
          className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/10 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">Run History</span>
            {runs.length > 0 && (
              <span className="text-[11px] text-muted-foreground">({runs.length} runs)</span>
            )}
          </div>
          <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", runsExpanded && "rotate-180")} />
        </button>

        {runsExpanded && (
          <div className="border-t border-border/30">
            {runsLoading && (
              <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />Loading run history
              </div>
            )}
            {!runsLoading && runs.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-muted-foreground">No AI pass runs recorded yet for {symbol}.</p>
              </div>
            )}
            {!runsLoading && runs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/30 text-muted-foreground">
                      <th className="text-left px-4 py-2 font-medium">ID</th>
                      <th className="text-left px-3 py-2 font-medium">Pass</th>
                      <th className="text-left px-3 py-2 font-medium">Status</th>
                      <th className="text-left px-3 py-2 font-medium">Moves</th>
                      <th className="text-left px-3 py-2 font-medium">Processed</th>
                      <th className="text-left px-3 py-2 font-medium">Failed</th>
                      <th className="text-left px-3 py-2 font-medium">Elapsed</th>
                      <th className="text-left px-3 py-2 font-medium">Window</th>
                      <th className="text-left px-3 py-2 font-medium">Started</th>
                      <th className="text-left px-3 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 20).map((run) => {
                      const elapsedSec = run.startedAt && run.completedAt
                        ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
                        : null;
                      return (
                      <tr
                        key={run.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => void openRunHistoryDetail(run.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void openRunHistoryDetail(run.id);
                          }
                        }}
                        className={cn(
                          "border-b border-border/20 transition-colors cursor-pointer",
                          historyDetailId === run.id ? "bg-muted/30" : "hover:bg-muted/20",
                        )}
                      >
                        <td className="px-4 py-1.5 font-mono text-muted-foreground">#{run.id}</td>
                        <td className="px-3 py-1.5 font-mono text-foreground">{run.passName}</td>
                        <td className="px-3 py-1.5">
                          <span className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border",
                            run.status === "completed" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/25" :
                            run.status === "partial"   ? "text-amber-400 bg-amber-500/10 border-amber-500/25" :
                            run.status === "failed"    ? "text-red-400 bg-red-500/10 border-red-500/25" :
                            "text-sky-400 bg-sky-500/10 border-sky-500/25"
                          )}>
                            {run.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-foreground">{run.totalMoves ?? ""}</td>
                        <td className="px-3 py-1.5 font-mono text-foreground">{run.processedMoves ?? ""}</td>
                        <td className="px-3 py-1.5 font-mono text-foreground">{run.failedMoves ?? ""}</td>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">
                          {elapsedSec !== null ? formatDurationCompact(elapsedSec) : ""}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">{run.windowDays}d</td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {run.startedAt ? new Date(run.startedAt).toLocaleString() : ""}
                        </td>
                        <td className="px-3 py-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPassName(run.passName);
                              setShowDebugTools(true);
                              setScope("passes");
                              void runPasses(run.passName);
                            }}
                            disabled={passForThisSymbol || detecting}
                            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border/50 text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-40 transition-colors"
                            title={`Rerun pass "${run.passName}"`}
                          >
                            <RefreshCw className="w-3 h-3" />
                            Rerun
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                {historyDetailId != null && (
                  <div className="border-t border-border/30 px-4 py-3 space-y-2 bg-muted/5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground">Selected run #{historyDetailId}</span>
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => { setHistoryDetailId(null); setHistoryDetail(null); }}
                      >
                        Close
                      </button>
                    </div>
                    {historyDetailLoading && (
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading run details
                      </div>
                    )}
                    {!historyDetailLoading && historyDetail && (
                      <div className="space-y-2 text-[11px]">
                        <div className="flex flex-wrap gap-3 text-muted-foreground">
                          <span>Status: <strong className="text-foreground">{historyDetail.status}</strong></span>
                          {historyDetail.passName != null && (
                            <span>Pass: <strong className="text-foreground">{String(historyDetail.passName)}</strong></span>
                          )}
                          {historyDetail.totalMoves != null && (
                            <span>Moves: <strong className="text-foreground">{historyDetail.totalMoves}</strong></span>
                          )}
                          {historyDetail.processedMoves != null && (
                            <span>Processed: <strong className="text-foreground">{historyDetail.processedMoves}</strong></span>
                          )}
                          {historyDetail.failedMoves != null && (
                            <span>Failed: <strong className="text-foreground">{historyDetail.failedMoves}</strong></span>
                          )}
                        </div>
                        {historyDetail.errorSummary != null && (
                          <p className="text-red-400 font-mono break-all">
                            {typeof historyDetail.errorSummary === "string"
                              ? historyDetail.errorSummary
                              : JSON.stringify(historyDetail.errorSummary)}
                          </p>
                        )}
                        <div>
                          <span className="text-muted-foreground block mb-1">meta_json (progress, model, etc.)</span>
                          <pre className="text-[10px] overflow-x-auto p-2 rounded bg-background/80 border border-border/40 max-h-56 overflow-y-auto whitespace-pre-wrap">
                            {JSON.stringify(historyDetail.metaJson ?? {}, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

//  Tab Navigation 

type TabId = "ai" | "backtest" | "calibration";
type DomainTabId = "active" | "research";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "ai",          label: "AI Analysis",       icon: <Brain     className="w-3.5 h-3.5" /> },
  { id: "backtest",    label: "Backtest",           icon: <BarChart2 className="w-3.5 h-3.5" /> },
  { id: "calibration", label: "Move Calibration",   icon: <Target    className="w-3.5 h-3.5" /> },
];
const DOMAIN_TABS: { id: DomainTabId; label: string }[] = [
  { id: "active", label: "Active Symbols" },
  { id: "research", label: "New Symbols" },
];

//  Main Page 

export default function Research() {
  const [activeDomain, setActiveDomain] = useState<DomainTabId>("active");
  const [activeTab, setActiveTab] = useState<TabId>("ai");
  const [sharedWindowDays, setSharedWindowDays] = useState<number>(365);

  return (
    <CalibrationRunProvider>
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FlaskConical className="w-6 h-6 text-primary" />
          Research
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Active and new-symbol research domains with full-calibration workflow
        </p>
        <div className="mt-2">
          <a
            href={`${BASE}reports/deep-research-report.md`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border/50 hover:border-primary/50 hover:text-primary transition-colors"
            title="Open Deep Research Report"
          >
            <FileText className="w-3.5 h-3.5" />
            Open Deep Research Report
          </a>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border/30 pb-2">
        {DOMAIN_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveDomain(tab.id)}
            className={cn(
              "px-3 py-1.5 text-xs rounded-md border transition-colors",
              activeDomain === tab.id
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border/60"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground uppercase tracking-wide">Research Window</span>
        <select
          value={sharedWindowDays}
          onChange={e => setSharedWindowDays(Number(e.target.value))}
          className="text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary focus:outline-none focus:border-primary/60"
        >
          {RESEARCH_WINDOWS.map(w => <option key={w.days} value={w.days}>{w.label}</option>)}
        </select>
      </div>

      {/* Nested task tabs */}
      <div className="flex items-center gap-0.5 border-b border-border/30">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors",
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border/50"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "ai"          && <AiAnalysisTab domain={activeDomain} windowDays={sharedWindowDays} />}
      {activeTab === "backtest"    && <BacktestTab domain={activeDomain} windowDays={sharedWindowDays} />}
      {activeTab === "calibration" && <MoveCalibrationTab domain={activeDomain} windowDays={sharedWindowDays} />}
    </div>
    </CalibrationRunProvider>
  );
}

