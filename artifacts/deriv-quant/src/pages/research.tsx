import { useState, useRef, useEffect, useCallback, createContext, useContext, type ReactNode } from "react";
import {
  FlaskConical, Brain, Play, RefreshCw,
  Loader2, CheckCircle, XCircle,
  FileText, Clock, BarChart2, ChevronRight, Download, Activity,
  Target, Zap, TrendingUp, TrendingDown, Search, ChevronDown, ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  /** Polling active for an in-flight server run */
  isPassRunActive: boolean;
  beginPassRun: (runId: number, symbol: string) => void;
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
    setRunId(rid);
    setSymbol(sym);
    setStatus(null);
  }, []);

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
          setRunId(null);
          setSymbol(null);
        }
      } catch {
        /* transient network errors — keep polling */
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
    isPassRunActive: runId !== null,
    beginPassRun,
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
const ACTIVE = ["CRASH300", "BOOM300", "R_75", "R_100"];
const BACKTEST_SYMBOLS = ["all", "CRASH300", "BOOM300", "R_75", "R_100"];

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

function SymbolSelect({ value, onChange, label }: { value: string; onChange: (s: string) => void; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
      >
        {ALL_SYMBOLS.map(s => (
          <option key={s} value={s}>{s}{ACTIVE.includes(s) ? " ●" : ""}</option>
        ))}
      </select>
    </div>
  );
}

// ─── AI Analysis Tab ─────────────────────────────────────────────────────────

function AiAnalysisTab() {
  const [symbol, setSymbol] = useState("CRASH300");
  const [windowDays, setWindowDays] = useState(90);
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
            Produces a research report. <strong className="text-foreground">Sync mode blocks until complete (~10–30s).</strong>
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <SymbolSelect value={symbol} onChange={s => { setSymbol(s); setResult(null); }} label="Symbol:" />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Window:</span>
            {([30, 90, 180, 270, 365] as const).map((d, i) => {
              const labels = ["1 month", "3 months", "6 months", "9 months", "12 months"];
              return (
                <button key={d} onClick={() => setWindowDays(d)}
                  className={cn("px-2 py-1 rounded border text-xs transition-colors",
                    windowDays === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                  {labels[i]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={runSync}
            disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? "Analyzing…" : "Run Sync Analysis"}
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
            <h3 className="text-sm font-semibold">Research Report — {symbol}</h3>
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

// ─── Backtest Tab ─────────────────────────────────────────────────────────────

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

interface V3Result {
  symbol: string;
  startTs: number;
  endTs: number;
  totalBars: number;
  trades: V3Trade[];
  summary: V3Summary;
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
    max_duration: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  };
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium border", colors[reason] ?? "bg-muted/30 text-muted-foreground border-border/30")}>
      {reason.replace(/_/g, " ")}
    </span>
  );
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

function SymbolBacktestSection({ result }: { result: V3Result }) {
  const s = result.summary;
  const trades = result.trades;
  const [showAll, setShowAll] = useState(false);
  const displayTrades = showAll ? trades : trades.slice(0, 30);

  return (
    <div className="space-y-4">
      {/* Summary grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SummaryCard label="Trades" value={String(s.tradeCount)} sub={`${s.winCount}W / ${s.lossCount}L`} />
        <SummaryCard label="Win rate" value={pct(s.winRate)} />
        <SummaryCard label="Avg P&L" value={pct(s.avgPnlPct)} />
        <SummaryCard label="Total P&L" value={pct(s.totalPnlPct)} />
        <SummaryCard label="Profit factor" value={isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"} />
        <SummaryCard label="Max drawdown" value={pct(s.maxDrawdownPct)} />
        <SummaryCard label="Avg hold" value={holdLabel(s.avgHoldBars)} />
        <SummaryCard label="Leg1 hit rate" value={pct(s.leg1HitRate)} />
      </div>

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
          {Object.entries(s.byExitReason).map(([reason, count]) => (
            <span key={reason} className="flex items-center gap-1">
              <ExitReasonBadge reason={reason} />
              <span className="text-[10px] text-muted-foreground">×{count}</span>
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

function BacktestTab() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const toDateStr = (d: Date) => d.toISOString().slice(0, 10);

  const [symbol, setSymbol] = useState("R_75");
  const [startDate, setStartDate] = useState(toDateStr(thirtyDaysAgo));
  const [endDate, setEndDate] = useState(toDateStr(now));
  const [minScore, setMinScore] = useState("");
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<Record<string, V3Result> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setResults(null);
    setElapsed(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      const startTs = Math.floor(new Date(startDate).getTime() / 1000);
      const endTs = Math.floor(new Date(endDate + "T23:59:59").getTime() / 1000);
      const body: Record<string, unknown> = { symbol, startTs, endTs };
      if (minScore !== "" && !isNaN(Number(minScore))) {
        body.minScore = Number(minScore);
      }

      const d = await apiFetch("backtest/v3/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setResults(d.results as Record<string, V3Result>);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
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
      params: { symbol, startDate, endDate, minScore: minScore || "engine-default" },
      symbols: Object.fromEntries(
        Object.entries(results).map(([sym, r]) => [sym, {
          totalBars: r.totalBars,
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
      r.trades.map(t => ({ symbol: sym, ...t }))
    ).sort((a, b) => (a.entryTs ?? 0) - (b.entryTs ?? 0));
    downloadJson({
      exported_at: new Date().toISOString(),
      params: { symbol, startDate, endDate, minScore: minScore || "engine-default" },
      total_trades: allTrades.length,
      trades: allTrades,
    }, `bt-trades-${timestamp}.json`);
  }

  async function exportSignals() {
    setErr(null);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const startTs = Math.floor(new Date(startDate + "T00:00:00Z").getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate   + "T23:59:59Z").getTime() / 1000);
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

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">V3 Isolated Backtest Engine</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Replays historical 1m candles through the live V3 engines (CRASH300, BOOM300, R_75, R_100) with a hybrid exit model.
            Spike hazard is set to neutral — a conservative assumption for backtesting. All scoring and engine logic is identical to live.
            <strong className="text-foreground"> Running all symbols over 30 days takes ~60s.</strong>
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Symbol</label>
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {BACKTEST_SYMBOLS.map(s => (
                <option key={s} value={s}>{s === "all" ? "All (4 symbols)" : s}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">End date</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Min score override</label>
            <input
              type="number"
              min="0"
              max="100"
              placeholder="e.g. 55"
              value={minScore}
              onChange={e => setMinScore(e.target.value)}
              className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={run}
            disabled={running}
            className="flex items-center gap-1.5 px-4 py-2 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {running
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <BarChart2 className="w-3.5 h-3.5" />}
            {running ? `Running… ${elapsed}s` : "Run Backtest"}
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
            </>
          )}

          {/* Signals export is gated only on valid date inputs — includes blocked + allowed, not just executed trades */}
          {startDate && endDate && (
            <button
              onClick={exportSignals}
              className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
              title="Export all live signal decisions (allowed + blocked + executed) for the selected date range from the signal log"
            >
              <Download className="w-3.5 h-3.5" />
              Export Signals JSON
            </button>
          )}

          {running && (
            <p className="text-xs text-muted-foreground">
              Loading candles and replaying bars — this may take up to 2 minutes for all symbols.
            </p>
          )}
        </div>

        {err && <ErrorBox msg={err} />}
      </div>

      {/* Results */}
      {results !== null && (
        <div className="space-y-5">
          {totalTrades === 0 ? (
            <div className="rounded-xl border border-border/30 bg-card p-6 text-center">
              <BarChart2 className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">0 trades returned</p>
              <p className="text-xs text-muted-foreground mt-1">
                No signals passed engine gates in the selected range ({startDate} → {endDate}).
                Try a wider date range or lower min score.
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
                      {result.totalBars.toLocaleString()} bars · {result.trades.length} trades
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
                — {r.totalBars.toLocaleString()} bars processed, 0 trades
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Move Calibration support types ──────────────────────────────────────────

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

// ─── Move Calibration Tab ─────────────────────────────────────────────────────

const CALIB_SYMBOLS = ["BOOM300", "CRASH300", "R_75", "R_100"];
const PASS_NAMES = ["all", "precursor", "trigger", "behavior", "extraction"];
const MOVE_TYPES_FILTER_GENERIC = ["all", "breakout", "continuation", "reversal", "unknown"];
function moveTypesFilterForSymbol(sym: string): string[] {
  if (sym === "BOOM300") return ["all", "boom_expansion"];
  if (sym === "CRASH300") return ["all", "crash_expansion"];
  return MOVE_TYPES_FILTER_GENERIC;
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
};

function formatMoveTypeLabel(type: string): string {
  if (type === "boom_expansion") return "Boom Expansion";
  if (type === "crash_expansion") return "Crash Expansion";
  return type;
}

function TierPill({ tier }: { tier: string }) {
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
      {tier}
    </span>
  );
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
    <div className="flex items-center justify-between py-1 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono font-medium text-foreground">{value}</span>
    </div>
  );
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

function MoveCalibrationTab() {
  const calibRun = useCalibrationRun();
  const [symbol, setSymbol] = useState("BOOM300");
  const [windowDays, setWindowDays] = useState(90);
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
  const [domainLoading, setDomainLoading] = useState(false);

  const [engines, setEngines] = useState<EngineRow[]>([]);
  const [engineLoading, setEngineLoading] = useState(false);

  const [moves, setMoves] = useState<DetectedMove[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const [moveTypeFilter, setMoveTypeFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState<string>("");
  const [movesExpanded, setMovesExpanded] = useState(false);

  const [scope, setScope] = useState<"detect" | "passes" | "full">("detect");
  const [runElapsed, setRunElapsed] = useState(0);
  const prevCalibStatusRef = useRef<string | undefined>(undefined);

  const [passName, setPassName] = useState("all");
  const [passMinTier, setPassMinTier] = useState("");
  const [passMoveType, setPassMoveType] = useState("all");
  const [maxMoves, setMaxMoves] = useState("");
  const [passErr, setPassErr] = useState<string | null>(null);

  const passForThisSymbol = calibRun.isPassRunActive && calibRun.symbol === symbol;
  const passStatus = calibRun.symbol === symbol ? calibRun.status : null;

  const [historyDetailId, setHistoryDetailId] = useState<number | null>(null);
  const [historyDetail, setHistoryDetail] = useState<PassStatusResult | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);

  const [runs, setRuns] = useState<PassRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsExpanded, setRunsExpanded] = useState(false);

  const [exportBusy, setExportBusy] = useState<Record<string, boolean>>({});

  const loadDomains = useCallback(async (sym: string, family?: string) => {
    setAggLoading(true);
    setDomainLoading(true);
    setEngineLoading(true);
    const profilePath = (family && family !== "all") ? family : "all";
    try {
      const [agg, eng, beh, calib, rawMovesResp] = await Promise.all([
        apiFetch(`calibration/aggregate/${sym}`).catch(() => null),
        apiFetch(`calibration/engine/${sym}`).catch(() => null),
        apiFetch(`behavior/profile/${sym}`).catch(() => null),
        apiFetch(`calibration/profile/${sym}/${profilePath}`).catch(() => null),
        apiFetch(`calibration/moves/${sym}`).catch(() => null),
      ]);
      setAggregate(agg);
      setEngines(eng?.engines ?? []);
      setBehaviorProfile(beh ?? null);
      setCalibProfile(calib ?? null);

      // Compute Target Moves stats directly from the moves endpoint (constraint #9 — source: /api/calibration/moves/:symbol)
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
        const qualityDist = rawMoves.reduce<Record<string, number>>((acc, m) => {
          const t = String(m.qualityTier ?? "?");
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

  const loadMoves = useCallback(async (sym: string, type?: string, tier?: string) => {
    setMovesLoading(true);
    try {
      const params = new URLSearchParams();
      if (type && type !== "all") params.set("moveType", type);
      if (tier) params.set("minTier", tier);
      const qs = params.toString();
      const d = await apiFetch(`calibration/moves/${sym}${qs ? "?" + qs : ""}`);
      setMoves(d.moves ?? []);
    } catch {
      setMoves([]);
    } finally {
      setMovesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDomains(symbol, strategyFamily);
    loadMoves(symbol, moveTypeFilter, tierFilter);
    loadRuns(symbol);
  }, [symbol]);

  useEffect(() => {
    setHistoryDetailId(null);
    setHistoryDetail(null);
  }, [symbol]);

  useEffect(() => {
    loadMoves(symbol, moveTypeFilter, tierFilter);
  }, [moveTypeFilter, tierFilter]);

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
        loadMoves(symbol, moveTypeFilter, tierFilter),
        loadRuns(symbol),
      ]);
    }
    prevCalibStatusRef.current = st;
  }, [calibRun.status?.status, calibRun.symbol, symbol, strategyFamily, moveTypeFilter, tierFilter, loadDomains, loadMoves, loadRuns]);

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
        loadMoves(symbol, moveTypeFilter, tierFilter),
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
      const body: Record<string, unknown> = { windowDays, passName: pn };
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

  const runScope = async () => {
    if (scope === "detect") {
      await detectMoves();
    } else if (scope === "passes") {
      // Scope "Run All Passes" always forces passName="all" regardless of the pass selector,
      // so the selector only affects explicit single-pass reruns from run history.
      await runPasses("all");
    } else {
      // Full Calibration: detect first, then run all passes
      const ok = await detectMoves();
      if (ok) await runPasses("all");
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

  const displayedMoves = movesExpanded ? moves : moves.slice(0, 20);

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

  return (
    <div className="space-y-5">

      {/* ── Controls ── */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        {/* Scope row */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Calibration Controls</h3>
          <div className="flex items-center gap-1 bg-background border border-border/50 rounded-lg p-0.5">
            {(["detect", "passes", "full"] as const).map((s) => (
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
                {s === "detect" ? "Detect Moves Only" : s === "passes" ? "Run All Passes" : "Full Calibration"}
              </button>
            ))}
          </div>
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
              {CALIB_SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Window</span>
            <select
              value={windowDays}
              onChange={e => setWindowDays(Number(e.target.value))}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              <option value={30}>1 month</option>
              <option value={90}>3 months</option>
              <option value={180}>6 months</option>
              <option value={270}>9 months</option>
              <option value={365}>12 months</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Strategy Family</span>
            <select
              value={strategyFamily}
              onChange={e => setStrategyFamily(e.target.value)}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              <option value="all">All families</option>
              {symbol === "BOOM300" && <option value="boom_expansion">Boom Expansion</option>}
              {symbol === "CRASH300" && <option value="crash_expansion">Crash Expansion</option>}
              {(symbol === "R_75" || symbol === "R_100") && (
                <>
                  <option value="reversal">Reversal</option>
                  <option value="continuation">Continuation</option>
                  <option value="breakout">Breakout</option>
                </>
              )}
            </select>
          </div>

          {/* Detect-specific controls */}
          {(scope === "detect" || scope === "full") && (
            <>
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
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer self-end pb-1.5">
                <input
                  type="checkbox"
                  checked={clearExisting}
                  onChange={e => setClearExisting(e.target.checked)}
                  className="accent-primary"
                />
                Clear existing
              </label>
            </>
          )}

          {/* Pass-specific controls */}
          {(scope === "passes" || scope === "full") && (
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

          {/* Unified Run button */}
          <button
            onClick={runScope}
            disabled={detecting || passForThisSymbol}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50 self-end",
              scope === "full"
                ? "bg-emerald-600 text-white"
                : scope === "passes"
                ? "bg-amber-500/80 text-black"
                : "bg-primary text-primary-foreground"
            )}
          >
            {(detecting || passForThisSymbol) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {detecting ? "Detecting…" : passForThisSymbol ? "Running passes…" :
              scope === "detect" ? "Detect Moves" : scope === "passes" ? "Run AI Passes" : "Run Full Calibration"}
          </button>

          <button
            onClick={() => { loadDomains(symbol, strategyFamily); loadMoves(symbol, moveTypeFilter, tierFilter); loadRuns(symbol); }}
            disabled={aggLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border self-end"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", aggLoading && "animate-spin")} />
            Refresh
          </button>
        </div>

        {/* Elapsed timer */}
        {(detecting || passForThisSymbol) && runElapsed > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
            <Loader2 className="w-3 h-3 animate-spin" />
            Elapsed: <strong className="text-foreground font-mono">{runElapsed}s</strong>
            {passForThisSymbol && passStatus && (
              <span className="ml-2 text-foreground">
                ·{" "}
                {(passStatus.metaJson as { progress?: { label?: string } } | null)?.progress?.label
                  ?? `${passStatus.processedMoves ?? 0}/${passStatus.totalMoves ?? "—"} moves · ${passStatus.passName ?? "all"}`}
              </span>
            )}
          </div>
        )}

        {detectErr && <ErrorBox msg={detectErr} />}
        {detectResult && (
          <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">{detectResult.movesDetected} moves detected — {symbol} ({windowDays}d window)</span>
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
                {passStatus.status === "running"   ? "Passes running…" :
                 passStatus.status === "completed" ? "Passes completed" :
                 passStatus.status === "failed"    ? "Pass run failed" :
                 `Status: ${passStatus.status}`}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {passStatus.totalMoves    != null && <span>Total: <strong className="text-foreground">{passStatus.totalMoves}</strong></span>}
              {passStatus.processedMoves != null && <span>Processed: <strong className="text-foreground">{passStatus.processedMoves}</strong></span>}
              {passStatus.failedMoves   != null && <span>Failed: <strong className="text-foreground">{passStatus.failedMoves}</strong></span>}
              {passStatus.passName                  && <span>Pass: <strong className="text-foreground">{passStatus.passName}</strong></span>}
            </div>
            {passStatus.status === "running" &&
              (passStatus.metaJson as { progress?: { label?: string } } | null)?.progress?.label && (
              <p className="text-[11px] font-mono text-primary">
                {(passStatus.metaJson as { progress?: { label?: string } }).progress?.label}
              </p>
            )}
            {passStatus.errorSummary != null && (
              <p className="text-[11px] text-red-400">
                {typeof passStatus.errorSummary === "string"
                  ? passStatus.errorSummary
                  : JSON.stringify(passStatus.errorSummary)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── 3-Domain Comparison ── */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-0.5 mb-2">3-Domain Comparison</h3>
        {(aggLoading || domainLoading || engineLoading) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="w-4 h-4 animate-spin" />Loading calibration domains…
          </div>
        )}
        {!(aggLoading || domainLoading || engineLoading) && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

            {/* Domain A — Current Engine Behavior (signal-first, from behavior layer) */}
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
                    {buildingProfile ? "Building…" : "Build Behavior Profile"}
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
                            <span className="font-mono text-foreground">{ep.tradeCount} · {(ep.winRate * 100).toFixed(1)}%</span>
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
                      <p className="text-[9px] text-muted-foreground/60 mt-0.5">From behavior pass · max favorable excursion per move</p>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Updated {new Date(behaviorProfile.lastUpdated).toLocaleDateString()}
                  </p>
                </>
              )}
            </DomainCard>

            {/* Domain B — Target Moves (sourced from /api/calibration/moves/:symbol — constraint #9) */}
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
                      : "—"}
                  />
                  <StatRow
                    label="Median quality score"
                    value={targetMovesStats.medianQualityScore != null
                      ? targetMovesStats.medianQualityScore.toFixed(1)
                      : "—"}
                  />
                  {/* Avg hold from aggregate (computed from same moves table) */}
                  {aggregate?.overall && (
                    <>
                      <StatRow label="Avg move %" value={`${aggregate.overall.avgMovePct.toFixed(1)}%`} />
                      <StatRow label="Avg hold (hrs)" value={aggregate.overall.avgHoldHours?.toFixed(1) ?? "—"} />
                      <StatRow label="Direction up/down" value={`${aggregate.overall.directionSplit?.up ?? 0} / ${aggregate.overall.directionSplit?.down ?? 0}`} />
                    </>
                  )}
                  <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">By family</p>
                    {Object.entries(targetMovesStats.moveTypeDistribution).map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between text-[11px]">
                        <TypePill type={type} />
                        <span className="font-mono text-foreground">{count}×</span>
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

            {/* Domain C — Recommended Calibration (from stored profile, post AI passes) */}
            <DomainCard title="Recommended Calibration" icon={<Zap className="w-3.5 h-3.5 text-sky-400" />}>
              {!calibProfile ? (
                <p className="text-[11px] text-muted-foreground">No calibration profile yet. Detect moves then run AI passes to populate.</p>
              ) : (
                <>
                  <StatRow label="Fit score" value={`${(calibProfile.fitScore * 100).toFixed(1)}%`} />
                  <StatRow label="Target / captured" value={`${calibProfile.capturedMoves} / ${calibProfile.targetMoves}`} />
                  <StatRow label="Avg move %" value={`${calibProfile.avgMovePct.toFixed(1)}%`} />
                  <StatRow label="Avg hold (hrs)" value={calibProfile.avgHoldingHours.toFixed(1)} />
                  <StatRow label="Avg capturable %" value={`${(calibProfile.avgCaptureablePct * 100).toFixed(1)}%`} />
                  <StatRow label="Holdability score" value={calibProfile.avgHoldabilityScore.toFixed(2)} />
                  {/* Pass 1: Precursor Card */}
                  {calibProfile.precursorSummary && (() => {
                    const ps = calibProfile.precursorSummary as Record<string, unknown>;
                    const topConditions: unknown[] = (ps["topConditions"] ?? ps["conditions"] ?? ps["leadInPatterns"] ?? []) as unknown[];
                    const avgBars = ps["avgLeadInBars"] ?? ps["avgBars"] ?? ps["lookbackBars"];
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-amber-400/80 uppercase tracking-wide cursor-pointer hover:text-amber-300">
                          Pass 1 · Precursor Conditions
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
                          Pass 2 · Trigger Zone (In-Move Behavior)
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
                  {/* Pass 3: In-Move Behavior Card — behavior pass structural metrics */}
                  <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                    <summary className="text-[10px] text-violet-400/80 uppercase tracking-wide cursor-pointer hover:text-violet-300">
                      Pass 3 · In-Move Behavior
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
                          Pass 4 · Best Extraction Path
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
                                <span className="text-muted-foreground">Capturable · hold</span>
                                <span className="font-mono text-foreground">
                                  {(path.captureablePct * 100).toFixed(0)}% · {path.holdDays}d
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
                          <p className="text-[10px] font-semibold text-foreground truncate">{eng.engineName ?? "—"}</p>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Matched / fire rate</span>
                            <span className="font-mono text-foreground">{eng.matchedMoves} · {(eng.fireRate * 100).toFixed(1)}%</span>
                          </div>
                          {(eng.topMissReasons?.length ?? 0) > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              Miss: {(eng.topMissReasons ?? []).slice(0, 2).join(" · ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Built {new Date(calibProfile.generatedAt).toLocaleDateString()} · window {calibProfile.windowDays}d
                  </p>
                </>
              )}
            </DomainCard>

          </div>
        )}
      </div>

      {/* ── Honest Fit & Profitability ── */}
      {(aggregate?.overall?.capturedMoves !== undefined || calibProfile?.profitabilitySummary) && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Target className="w-3.5 h-3.5 text-primary" />
            Honest Fit &amp; Profitability
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Fit stats */}
            <div className="space-y-0.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Move Coverage</p>
              {aggregate?.overall && (
                <>
                  <StatRow label="Target moves" value={aggregate.overall.targetMoves} />
                  <StatRow label="Captured moves" value={aggregate.overall.capturedMoves} />
                  <StatRow label="Missed moves" value={aggregate.overall.missedMoves} />
                  <StatRow label="Fit score" value={`${(aggregate.overall.fitScore * 100).toFixed(1)}%`} />
                  <StatRow label="Avg move %" value={`${aggregate.overall.avgMovePct.toFixed(2)}%`} />
                  <StatRow label="Avg capturable %" value={`${(aggregate.overall.avgCaptureablePct * 100).toFixed(1)}%`} />
                  <StatRow
                    label="Avg extracted (est.)"
                    value={`${(aggregate.overall.avgMovePct * aggregate.overall.avgCaptureablePct).toFixed(2)}%`}
                  />
                  <StatRow label="Holdability score" value={aggregate.overall.avgHoldabilityScore.toFixed(2)} />
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
                  <StatRow label="Top path" value={calibProfile.profitabilitySummary.topPath ?? "—"} />
                  <StatRow
                    label="Fit-adjusted return"
                    value={calibProfile.profitabilitySummary.estimatedFitAdjustedReturn != null
                      ? `${(calibProfile.profitabilitySummary.estimatedFitAdjustedReturn * 100).toFixed(1)}%/mo`
                      : "—"}
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

      {/* ── Detected Moves List ── */}
      <div className="rounded-xl border border-border/50 bg-card">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">Detected Moves</span>
            <span className="text-[11px] text-muted-foreground">({moves.length} shown)</span>
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
            <select
              value={tierFilter}
              onChange={e => setTierFilter(e.target.value)}
              className="text-[11px] bg-background border border-border/50 rounded px-1.5 py-1 text-foreground focus:outline-none"
            >
              <option value="">All tiers</option>
              {TIERS.map(t => <option key={t} value={t}>Tier {t}+</option>)}
            </select>
          </div>
        </div>

        {movesLoading && (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />Loading moves…
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
                    <th className="text-left px-3 py-2 font-medium">Quality</th>
                    <th className="text-left px-3 py-2 font-medium">Lead-in</th>
                    <th className="text-left px-3 py-2 font-medium">Start</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedMoves.map((m) => (
                    <tr key={m.id} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-1.5"><TypePill type={m.moveType} /></td>
                      <td className="px-3 py-1.5"><TierPill tier={m.qualityTier} /></td>
                      <td className="px-3 py-1.5">
                        {m.direction === "up"
                          ? <TrendingUp   className="w-3.5 h-3.5 text-emerald-400" />
                          : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.movePct != null ? `${(m.movePct * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.holdingMinutes != null ? (m.holdingMinutes / 60).toFixed(1) : "—"}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.qualityScore != null ? m.qualityScore.toFixed(0) : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{m.leadInShape ?? "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {m.startTs ? new Date(m.startTs * 1000).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {moves.length > 10 && (
              <button
                onClick={() => setMovesExpanded(p => !p)}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground hover:text-foreground border-t border-border/30 transition-colors"
              >
                {movesExpanded
                  ? <><ChevronUp className="w-3.5 h-3.5" />Show less</>
                  : <><ChevronDown className="w-3.5 h-3.5" />Show all {moves.length} moves</>}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Export Buttons ── */}
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
        </div>
        <p className="text-[11px] text-muted-foreground">
          All exports are read-only research artifacts. None of these outputs are connected to live execution.
        </p>
      </div>

      {/* ── Run History ── */}
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
                <Loader2 className="w-4 h-4 animate-spin" />Loading run history…
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
                        <td className="px-3 py-1.5 font-mono text-foreground">{run.totalMoves ?? "—"}</td>
                        <td className="px-3 py-1.5 font-mono text-foreground">{run.processedMoves ?? "—"}</td>
                        <td className="px-3 py-1.5 font-mono text-foreground">{run.failedMoves ?? "—"}</td>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">
                          {elapsedSec !== null ? `${elapsedSec}s` : "—"}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">{run.windowDays}d</td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPassName(run.passName);
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
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading run details…
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

// ─── Tab Navigation ───────────────────────────────────────────────────────────

type TabId = "ai" | "backtest" | "calibration";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "ai",          label: "AI Analysis",       icon: <Brain     className="w-3.5 h-3.5" /> },
  { id: "backtest",    label: "Backtest",           icon: <BarChart2 className="w-3.5 h-3.5" /> },
  { id: "calibration", label: "Move Calibration",   icon: <Target    className="w-3.5 h-3.5" /> },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Research() {
  const [activeTab, setActiveTab] = useState<TabId>("ai");

  return (
    <CalibrationRunProvider>
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FlaskConical className="w-6 h-6 text-primary" />
          Research
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          AI market analysis · V3 isolated backtest engine — Export moved to Data console
        </p>
      </div>

      {/* Tab bar */}
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

      {activeTab === "ai"          && <AiAnalysisTab />}
      {activeTab === "backtest"    && <BacktestTab />}
      {activeTab === "calibration" && <MoveCalibrationTab />}
    </div>
    </CalibrationRunProvider>
  );
}
