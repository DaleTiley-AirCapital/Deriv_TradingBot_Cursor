import { useState, useRef, useEffect, useCallback } from "react";
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
  const [windowDays, setWindowDays] = useState(365);
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
            Runs a GPT-4o structured analysis on stored candle data for the selected symbol.
            Extracts swing patterns, move size distribution, frequency, and behavioral drift.
            Produces a research report. <strong className="text-foreground">Sync mode blocks until complete (~10–30s).</strong>
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <SymbolSelect value={symbol} onChange={s => { setSymbol(s); setResult(null); }} label="Symbol:" />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Window:</span>
            {[90, 180, 365].map(d => (
              <button key={d} onClick={() => setWindowDays(d)}
                className={cn("px-2 py-1 rounded border text-xs transition-colors",
                  windowDays === d ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                {d}d
              </button>
            ))}
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

// ─── Behavior Model Tab ───────────────────────────────────────────────────────

const BEHAVIOR_SYMBOL_ENGINES: Record<string, string[]> = {
  BOOM300:  ["boom_expansion_engine"],
  CRASH300: ["crash_expansion_engine"],
  R_75:     ["r75_reversal_engine", "r75_continuation_engine", "r75_breakout_engine"],
  R_100:    ["r100_reversal_engine", "r100_continuation_engine", "r100_breakout_engine"],
};

interface EngineProfile {
  symbol: string;
  engineName: string;
  tradeCount: number;
  winRate: number;
  avgHoldBars: number;
  avgHoldHours: number;
  avgPnlPct: number;
  profitFactor: number;
  avgMfePct: number;
  mfePctP50: number;
  mfePctP75: number;
  mfePctP90: number;
  avgMaePct: number;
  maePctP50: number;
  barsToMfeP50: number;
  extensionProbability: number;
  bePromotionRate: number;
  trailingActivationRate: number;
  byExitReason: Record<string, number>;
  bySlStage: Record<string, number>;
  signalsFired: number;
  blockedByGateCount: number;
  blockedRate: number;
  byRegime: Record<string, { count: number; wins: number; winRate: number }>;
  dominantRegime: string;
  dominantEntryType: string;
  signalFrequencyPerDay: number;
  recommendedMemoryWindowBars: number;
  recommendedScanCadenceMins: number;
  scoreP50: number;
  scoreP75: number;
  sampleDays: number;
  sources: string[];
}

interface BehaviorProfileSummary {
  symbol: string;
  engineProfiles: EngineProfile[];
  totalTrades: number;
  totalSignalsFired: number;
  totalBlocked: number;
  overallWinRate: number;
  overallBlockedRate: number;
  recommendedScanCadenceMins: number;
  lastUpdated: string;
}

function MetricRow({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-border/15 last:border-0">
      <span className="text-[11px] text-muted-foreground w-44 shrink-0">{label}</span>
      <span className="text-[11px] font-mono text-foreground">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground ml-1">{sub}</span>}
    </div>
  );
}

function EngineProfileCard({ ep }: { ep: EngineProfile }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-border/30 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full px-3 py-2.5 bg-muted/10 flex items-center justify-between hover:bg-muted/15 transition-colors"
      >
        <span className="text-xs font-medium font-mono">{ep.engineName}</span>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{ep.tradeCount} trades</span>
          <span className={ep.winRate >= 0.5 ? "text-green-400" : "text-red-400"}>
            {(ep.winRate * 100).toFixed(1)}% WR
          </span>
          <span>{ep.sampleDays}d sample</span>
          <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-90")} />
        </div>
      </button>
      {open && (
        <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-1 mb-0.5">Trade Quality</p>
            <MetricRow label="Trades" value={ep.tradeCount} />
            <MetricRow label="Win rate" value={`${(ep.winRate * 100).toFixed(1)}%`} />
            <MetricRow label="Avg P&L" value={`${(ep.avgPnlPct * 100).toFixed(2)}%`} />
            <MetricRow label="Profit factor" value={isFinite(ep.profitFactor) ? ep.profitFactor.toFixed(2) : "∞"} />
            <MetricRow label="Avg hold" value={`${ep.avgHoldHours.toFixed(1)}h`} sub={`${ep.avgHoldBars.toFixed(0)} bars`} />

            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-3 mb-0.5">MFE / MAE Distribution</p>
            <MetricRow label="MFE P50 / P75 / P90" value={`${(ep.mfePctP50 * 100).toFixed(2)}% / ${(ep.mfePctP75 * 100).toFixed(2)}% / ${(ep.mfePctP90 * 100).toFixed(2)}%`} />
            <MetricRow label="MAE P50 (avg adverse)" value={`${(ep.maePctP50 * 100).toFixed(2)}% avg`} />
            <MetricRow label="Time to peak MFE (P50)" value={`${ep.barsToMfeP50} bars`} sub="≈ mins" />
            <MetricRow label="Extension probability" value={`${(ep.extensionProbability * 100).toFixed(1)}%`} sub="≥50% of proj move" />
            <MetricRow label="Breakeven promotion rate" value={`${(ep.bePromotionRate * 100).toFixed(1)}%`} />
            <MetricRow label="Trailing activation rate" value={`${(ep.trailingActivationRate * 100).toFixed(1)}%`} />
          </div>

          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-1 mb-0.5">Signals &amp; Gating</p>
            <MetricRow label="Signals fired" value={ep.signalsFired} />
            <MetricRow label="Blocked by gate" value={ep.blockedByGateCount} />
            <MetricRow label="Block rate" value={`${(ep.blockedRate * 100).toFixed(1)}%`} />
            <MetricRow label="Signal freq / day" value={ep.signalFrequencyPerDay.toFixed(2)} />

            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-3 mb-0.5">Runtime Guidance</p>
            <MetricRow label="Recommended memory window" value={`${ep.recommendedMemoryWindowBars} bars`} sub="≈ mins" />
            <MetricRow label="Recommended scan cadence" value={`${ep.recommendedScanCadenceMins} min`} />
            <MetricRow label="Score P50 / P75" value={`${ep.scoreP50.toFixed(1)} / ${ep.scoreP75.toFixed(1)}`} />
            <MetricRow label="Dominant regime" value={ep.dominantRegime || "—"} />
            <MetricRow label="Dominant entry type" value={ep.dominantEntryType || "—"} />

            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-3 mb-0.5">Exit Distribution</p>
            {Object.entries(ep.byExitReason).map(([reason, count]) => (
              <MetricRow key={reason} label={reason.replace(/_/g, " ")} value={count} />
            ))}

            {Object.keys(ep.bySlStage).length > 0 && (
              <>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-3 mb-0.5">SL Stage at Exit</p>
                {Object.entries(ep.bySlStage).map(([stage, count]) => (
                  <MetricRow key={stage} label={stage.replace(/_/g, " ")} value={count} />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BehaviorModelTab() {
  const behaviorSymbols = Object.keys(BEHAVIOR_SYMBOL_ENGINES);
  const [symbol, setSymbol] = useState("BOOM300");
  const [engine, setEngine] = useState(BEHAVIOR_SYMBOL_ENGINES["BOOM300"][0]);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [profile, setProfile] = useState<BehaviorProfileSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function handleSymbolChange(sym: string) {
    setSymbol(sym);
    setEngine(BEHAVIOR_SYMBOL_ENGINES[sym][0]);
    setBuildMsg(null);
    setErr(null);
    setProfile(null);
  }

  useEffect(() => {
    fetchCachedProfile(symbol);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [symbol]);

  async function fetchCachedProfile(sym: string) {
    setLoading(true);
    setErr(null);
    setProfile(null);
    try {
      const d = await apiFetch(`behavior/profile/${sym}`);
      setProfile(d as BehaviorProfileSummary);
    } catch {
      // 404 = no profile yet — shown as empty state, not an error
    } finally {
      setLoading(false);
    }
  }

  async function runProfile() {
    setBuilding(true);
    setBuildMsg(null);
    setErr(null);
    setElapsed(0);
    const startTime = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    try {
      await apiFetch(`behavior/profile/${symbol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setBuildMsg(`Profile built for ${symbol}.`);
      await fetchCachedProfile(symbol);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBuilding(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  }

  async function exportProfileJson() {
    if (!profile) return;
    if (!profile.engineProfiles.some(ep => ep.engineName === engine)) return;
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    try {
      const data = await apiFetch(`behavior/export/${symbol}/${engine}`);
      downloadBehaviorJson(data, `behavior-profile-${symbol}-${engine}-${ts}.json`);
    } catch (e: any) {
      setErr(`Export failed: ${e?.message ?? "Unknown error"}`);
    }
  }

  function downloadBehaviorJson(data: unknown, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const engines = BEHAVIOR_SYMBOL_ENGINES[symbol] ?? [];

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Strategy Behavior Profile</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Derives per-engine behavioral profiles from historical backtest replay using the live V3 runtime.
            Shows MFE/MAE distributions, time-to-peak, extension probability, signal gating, and runtime guidance
            (scan cadence, memory window). Select a symbol and engine, then run to rebuild from the last 90 days.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Symbol:</span>
            <select
              value={symbol}
              onChange={e => handleSymbolChange(e.target.value)}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {behaviorSymbols.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Engine:</span>
            <select
              value={engine}
              onChange={e => setEngine(e.target.value)}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {engines.map(eng => <option key={eng} value={eng}>{eng}</option>)}
            </select>
          </div>

          <button
            onClick={runProfile}
            disabled={building}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {building ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {building ? `Building… ${elapsed}s` : "Run Profile"}
          </button>

          {profile && profile.engineProfiles.some(ep => ep.engineName === engine) && (
            <button
              onClick={exportProfileJson}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
              title={`Export behavioral profile for ${symbol} / ${engine}`}
            >
              <Download className="w-3.5 h-3.5" />
              Export Profile JSON
            </button>
          )}

          {building && (
            <span className="text-xs text-muted-foreground">
              Running V3 backtest replay to derive profile — this may take up to 90s.
            </span>
          )}
        </div>

        {err && <ErrorBox msg={err} />}
        {buildMsg && !err && <SuccessBox msg={buildMsg} />}
      </div>

      {loading && (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading profile…
        </div>
      )}

      {!loading && !profile && !building && (
        <div className="rounded-xl border border-border/30 bg-card p-8 text-center">
          <Activity className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">No profile data for {symbol}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Click <strong className="text-foreground">Run Profile</strong> to derive behavioral statistics
            from a 90-day backtest replay.
          </p>
        </div>
      )}

      {profile && (
        <div className="space-y-4">
          {/* Symbol-level summary */}
          <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                {profile.symbol} — Overview
              </h3>
              <span className="text-[10px] text-muted-foreground">
                Updated {new Date(profile.lastUpdated).toLocaleString()}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <SummaryCard label="Total Trades" value={String(profile.totalTrades)} />
              <SummaryCard label="Overall Win Rate" value={`${(profile.overallWinRate * 100).toFixed(1)}%`} />
              <SummaryCard label="Overall Block Rate" value={`${(profile.overallBlockedRate * 100).toFixed(1)}%`} />
              <SummaryCard label="Rec. Scan Cadence" value={`${profile.recommendedScanCadenceMins} min`} />
            </div>
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground flex-wrap">
              <span>Signals fired: <strong className="text-foreground">{profile.totalSignalsFired}</strong></span>
              <span>Signals blocked: <strong className="text-foreground">{profile.totalBlocked}</strong></span>
              <span>Engines: <strong className="text-foreground">{profile.engineProfiles.length}</strong></span>
            </div>
          </div>

          {/* Per-engine breakdown */}
          {profile.engineProfiles.length === 0 ? (
            <div className="rounded-xl border border-border/30 bg-card p-4 text-center">
              <p className="text-xs text-muted-foreground">No engine profiles derived — insufficient closed trade data.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-0.5">
                Engine Profiles
              </h3>
              {profile.engineProfiles.map(ep => (
                <EngineProfileCard key={ep.engineName} ep={ep} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Move Calibration Tab ─────────────────────────────────────────────────────

const CALIB_SYMBOLS = ["BOOM300", "CRASH300", "R_75", "R_100"];
const PASS_NAMES = ["all", "precursor", "trigger", "behavior", "extraction"];
const MOVE_TYPES_FILTER = ["all", "breakout", "continuation", "reversal", "unknown"];
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
};

function TierPill({ tier }: { tier: string }) {
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
      {tier}
    </span>
  );
}

function TypePill({ type }: { type: string }) {
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border", TYPE_COLORS[type] ?? TYPE_COLORS.unknown)}>
      {type}
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
    missReasons: Array<{ reason: string; count: number }>;
    engineCoverage: Record<string, { matched: number; fired: number; missRate: number }>;
    qualityDistribution: Record<string, number>;
    behaviorPatterns: Record<string, number>;
    leadInShapes: Record<string, number>;
    directionSplit: { up: number; down: number };
  };
  generatedAt: string;
}

interface TierData {
  count: number;
  avgMovePct: number;
  suggestedMinScore?: number;
  [key: string]: unknown;
}

interface ScoringResult {
  symbol: string;
  scores?: Record<string, number>;
  [key: string]: TierData | string | Record<string, number> | undefined;
}

interface HealthResult {
  symbol: string;
  avgHoldingHours?: number;
  p25HoldHours?: number;
  p50HoldHours?: number;
  p75HoldHours?: number;
  avgCaptureablePct: number;
  systemCompatibility?: string;
  topBehaviorPatterns: Array<{ pattern: string; count: number }>;
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

interface PassStatusResult {
  runId: number;
  status: string;
  passName?: string;
  totalMoves?: number;
  processedMoves?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  errors?: string[];
  errorSummary?: string;
  completedAt?: string;
}

function MoveCalibrationTab() {
  const [symbol, setSymbol] = useState("BOOM300");
  const [windowDays, setWindowDays] = useState(30);
  const [minMovePct, setMinMovePct] = useState(0.05);
  const [clearExisting, setClearExisting] = useState(true);

  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [detectErr, setDetectErr] = useState<string | null>(null);

  const [aggregate, setAggregate] = useState<AggregateResult | null>(null);
  const [aggLoading, setAggLoading] = useState(false);

  const [scoring, setScoring] = useState<ScoringResult | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);

  const [engines, setEngines] = useState<EngineRow[]>([]);
  const [engineLoading, setEngineLoading] = useState(false);

  const [moves, setMoves] = useState<DetectedMove[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const [moveTypeFilter, setMoveTypeFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState<string>("");
  const [movesExpanded, setMovesExpanded] = useState(false);

  const [passName, setPassName] = useState("all");
  const [passMinTier, setPassMinTier] = useState("");
  const [passMoveType, setPassMoveType] = useState("all");
  const [maxMoves, setMaxMoves] = useState("");
  const [passBusy, setPassBusy] = useState(false);
  const [passRunId, setPassRunId] = useState<number | null>(null);
  const [passStatus, setPassStatus] = useState<PassStatusResult | null>(null);
  const [passErr, setPassErr] = useState<string | null>(null);
  const passIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [exportBusy, setExportBusy] = useState<Record<string, boolean>>({});

  const loadDomains = useCallback(async (sym: string) => {
    setAggLoading(true);
    setDomainLoading(true);
    setEngineLoading(true);
    try {
      const [agg, sc, hl, eng] = await Promise.all([
        apiFetch(`calibration/aggregate/${sym}`).catch(() => null),
        apiFetch(`calibration/scoring/${sym}`).catch(() => null),
        apiFetch(`calibration/health/${sym}`).catch(() => null),
        apiFetch(`calibration/engine/${sym}`).catch(() => null),
      ]);
      setAggregate(agg);
      setScoring(sc);
      setHealth(hl);
      setEngines(eng?.engines ?? []);
    } finally {
      setAggLoading(false);
      setDomainLoading(false);
      setEngineLoading(false);
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
    loadDomains(symbol);
    loadMoves(symbol, moveTypeFilter, tierFilter);
  }, [symbol]);

  useEffect(() => {
    loadMoves(symbol, moveTypeFilter, tierFilter);
  }, [moveTypeFilter, tierFilter]);

  useEffect(() => {
    return () => { if (passIntervalRef.current) clearInterval(passIntervalRef.current); };
  }, []);

  const detectMoves = async () => {
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
        loadDomains(symbol),
        loadMoves(symbol, moveTypeFilter, tierFilter),
      ]);
    } catch (e: unknown) {
      setDetectErr(e instanceof Error ? e.message : "Detection failed");
    } finally {
      setDetecting(false);
    }
  };

  const pollPassStatus = (runId: number) => {
    if (passIntervalRef.current) clearInterval(passIntervalRef.current);
    passIntervalRef.current = setInterval(async () => {
      try {
        const s = await apiFetch(`calibration/run-status/${runId}`);
        setPassStatus(s);
        if (s.status === "completed" || s.status === "failed") {
          clearInterval(passIntervalRef.current!);
          setPassBusy(false);
          await Promise.all([loadDomains(symbol), loadMoves(symbol, moveTypeFilter, tierFilter)]);
        }
      } catch {}
    }, 4000);
  };

  const runPasses = async () => {
    setPassBusy(true);
    setPassErr(null);
    setPassStatus(null);
    try {
      const body: Record<string, unknown> = { windowDays, passName };
      if (passMinTier) body.minTier = passMinTier;
      if (passMoveType && passMoveType !== "all") body.moveType = passMoveType;
      if (maxMoves && !isNaN(Number(maxMoves))) body.maxMoves = Number(maxMoves);
      const d = await apiFetch(`calibration/run-passes/${symbol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (d.runId) {
        setPassRunId(d.runId);
        pollPassStatus(d.runId);
      } else {
        setPassStatus(d);
        setPassBusy(false);
        await Promise.all([loadDomains(symbol), loadMoves(symbol, moveTypeFilter, tierFilter)]);
      }
    } catch (e: unknown) {
      setPassErr(e instanceof Error ? e.message : "Pass run failed");
      setPassBusy(false);
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

  const displayedMoves = movesExpanded ? moves : moves.slice(0, 10);

  return (
    <div className="space-y-5">

      {/* ── Controls ── */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Move Detection Controls</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Symbol</span>
            <select
              value={symbol}
              onChange={e => { setSymbol(e.target.value); setDetectResult(null); setDetectErr(null); }}
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
              {[14, 30, 60, 90, 180].map(d => <option key={d} value={d}>{d}d</option>)}
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

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer self-end pb-1.5">
            <input
              type="checkbox"
              checked={clearExisting}
              onChange={e => setClearExisting(e.target.checked)}
              className="accent-primary"
            />
            Clear existing
          </label>

          <button
            onClick={detectMoves}
            disabled={detecting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50 self-end"
          >
            {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            {detecting ? "Detecting…" : "Detect Moves"}
          </button>

          <button
            onClick={() => { loadDomains(symbol); loadMoves(symbol, moveTypeFilter, tierFilter); }}
            disabled={aggLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border self-end"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", aggLoading && "animate-spin")} />
            Refresh
          </button>
        </div>

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

            {/* Domain A — Structural Moves */}
            <DomainCard title="Structural Moves" icon={<Target className="w-3.5 h-3.5 text-primary" />}>
              {!aggregate || aggregate.totalMoves === 0 ? (
                <p className="text-[11px] text-muted-foreground">No moves detected. Run "Detect Moves" first.</p>
              ) : (
                <>
                  <StatRow label="Total moves" value={aggregate.totalMoves} />
                  <StatRow label="Avg move %" value={`${(aggregate.overall?.avgMovePct * 100).toFixed(1)}%`} />
                  <StatRow label="Median move %" value={`${(aggregate.overall?.medianMovePct * 100).toFixed(1)}%`} />
                  <StatRow label="Avg hold (hrs)" value={aggregate.overall?.avgHoldHours?.toFixed(1)} />
                  <StatRow label="Direction up/down" value={`${aggregate.overall?.directionSplit?.up ?? 0} / ${aggregate.overall?.directionSplit?.down ?? 0}`} />
                  <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">By move type</p>
                    {Object.entries(aggregate.byMoveType ?? {}).map(([type, stats]) => (
                      <div key={type} className="flex items-center justify-between text-[11px]">
                        <TypePill type={type} />
                        <span className="font-mono text-foreground">{stats.count}× · {(stats.avgMovePct * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Quality dist.</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(aggregate.overall?.qualityDistribution ?? {}).map(([tier, cnt]) => (
                        <span key={tier} className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
                          {tier}: {cnt as number}
                        </span>
                      ))}
                    </div>
                  </div>
                  {Object.keys(aggregate.overall?.leadInShapes ?? {}).length > 0 && (
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
                  {aggregate.overall?.capturedMoves !== undefined && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Honest fit</p>
                      <StatRow label="Captured" value={`${aggregate.overall.capturedMoves} / ${aggregate.overall.targetMoves}`} />
                      <StatRow label="Fit score" value={`${(aggregate.overall.fitScore * 100).toFixed(1)}%`} />
                    </div>
                  )}
                </>
              )}
            </DomainCard>

            {/* Domain B — Behavior Model */}
            <DomainCard title="Behavior Model" icon={<Activity className="w-3.5 h-3.5 text-amber-400" />}>
              {!scoring && !health ? (
                <p className="text-[11px] text-muted-foreground">No behavior data yet.</p>
              ) : (
                <>
                  {scoring && (
                    <>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Tier breakdown</p>
                      {TIERS.map(t => {
                        const td = scoring[`tier${t}`] as TierData | undefined;
                        if (!td) return null;
                        return (
                          <div key={t} className="flex items-start gap-2 py-0.5">
                            <TierPill tier={t} />
                            <div className="flex-1 text-[11px] space-y-0">
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Count</span>
                                <span className="font-mono text-foreground">{td.count}</span>
                              </div>
                              {td.count > 0 && (
                                <>
                                  <div className="flex justify-between">
                                    <span className="text-muted-foreground">Avg move %</span>
                                    <span className="font-mono text-foreground">{(td.avgMovePct * 100).toFixed(1)}%</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-muted-foreground">Suggested min score</span>
                                    <span className="font-mono text-foreground">{td.suggestedMinScore ?? "—"}</span>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {health && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Trade health</p>
                      <StatRow label="Avg hold (hrs)" value={health.avgHoldingHours?.toFixed(1) ?? "—"} />
                      <StatRow label="p25 hold (hrs)" value={health.p25HoldHours?.toFixed(1) ?? "—"} />
                      <StatRow label="p50 hold (hrs)" value={health.p50HoldHours?.toFixed(1) ?? "—"} />
                      <StatRow label="p75 hold (hrs)" value={health.p75HoldHours?.toFixed(1) ?? "—"} />
                      <StatRow label="Avg capturable %" value={`${(health.avgCaptureablePct * 100)?.toFixed(1)}%`} />
                      {health.systemCompatibility && (
                        <StatRow label="Compatibility" value={health.systemCompatibility} />
                      )}
                      {health.topBehaviorPatterns?.length > 0 && (
                        <div className="mt-1 pt-1 border-t border-border/20">
                          <p className="text-[10px] text-muted-foreground mb-0.5">Top patterns</p>
                          {health.topBehaviorPatterns.slice(0, 3).map((p) => (
                            <div key={p.pattern} className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground truncate max-w-[120px]">{p.pattern}</span>
                              <span className="font-mono text-foreground">{p.count}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </DomainCard>

            {/* Domain C — Engine Coverage */}
            <DomainCard title="Engine Coverage" icon={<Zap className="w-3.5 h-3.5 text-sky-400" />}>
              {engines.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No engine coverage data. Run AI passes first.</p>
              ) : (
                <div className="space-y-3">
                  {engines.map((eng) => (
                    <div key={eng.engineName ?? "unknown"} className="space-y-0.5">
                      <p className="text-[10px] font-semibold text-foreground">{eng.engineName ?? "—"}</p>
                      <StatRow label="Matched moves" value={eng.matchedMoves} />
                      <StatRow label="Would fire" value={eng.wouldFireCount} />
                      <StatRow label="Fire rate" value={`${(eng.fireRate * 100).toFixed(1)}%`} />
                      <StatRow label="Avg miss move %" value={`${(eng.avgMissMovePct * 100).toFixed(1)}%`} />
                      {(eng.topMissReasons?.length ?? 0) > 0 && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Miss: {(eng.topMissReasons ?? []).slice(0, 2).join(" · ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </DomainCard>

          </div>
        )}
      </div>

      {/* ── AI Passes ── */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Run AI Calibration Passes</h3>
        <div className="flex flex-wrap gap-3 items-end">
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
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Move Type</span>
            <select
              value={passMoveType}
              onChange={e => setPassMoveType(e.target.value)}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {MOVE_TYPES_FILTER.map(t => <option key={t} value={t}>{t}</option>)}
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

          <button
            onClick={runPasses}
            disabled={passBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/80 text-black text-xs font-medium hover:opacity-90 disabled:opacity-50 self-end"
          >
            {passBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {passBusy ? "Running passes…" : "Run AI Passes"}
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          AI passes use GPT-4o to analyze each detected move. "all" runs precursor → trigger → behavior → extraction in sequence.
          Expects detected moves to already exist. May take several minutes for large move sets.
        </p>

        {passErr && <ErrorBox msg={passErr} />}

        {passStatus && (
          <div className={cn(
            "rounded-lg border p-3 space-y-1.5",
            passStatus.status === "completed" ? "bg-green-500/10 border-green-500/20" :
            passStatus.status === "failed"    ? "bg-red-500/10 border-red-500/20" :
            "bg-primary/5 border-primary/20"
          )}>
            <div className="flex items-center gap-2">
              {passBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
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
              {passStatus.totalMoves  !== undefined && <span>Total: <strong className="text-foreground">{passStatus.totalMoves}</strong></span>}
              {passStatus.processed   !== undefined && <span>Processed: <strong className="text-foreground">{passStatus.processed}</strong></span>}
              {passStatus.succeeded   !== undefined && <span>Succeeded: <strong className="text-foreground">{passStatus.succeeded}</strong></span>}
              {passStatus.failed      !== undefined && <span>Failed: <strong className="text-foreground">{passStatus.failed}</strong></span>}
              {passStatus.passName                  && <span>Pass: <strong className="text-foreground">{passStatus.passName}</strong></span>}
            </div>
            {passStatus.errorSummary && (
              <p className="text-[11px] text-red-400">{passStatus.errorSummary}</p>
            )}
          </div>
        )}
      </div>

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
              {MOVE_TYPES_FILTER.map(t => <option key={t} value={t}>{t === "all" ? "All types" : t}</option>)}
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
            onClick={() => doExport("full", `calibration/export/${symbol}`, `calibration_full_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["full"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
          >
            {exportBusy["full"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Full Calibration
          </button>

          <button
            onClick={() => doExport("engine", `calibration/engine/${symbol}`, `calibration_engine_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["engine"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
          >
            {exportBusy["engine"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Engine Coverage
          </button>

          <button
            onClick={() => doExport("scoring", `calibration/scoring/${symbol}`, `calibration_scoring_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["scoring"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
          >
            {exportBusy["scoring"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Scoring Data
          </button>

          <button
            onClick={() => doExport("health", `calibration/health/${symbol}`, `calibration_health_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["health"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
          >
            {exportBusy["health"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Trade Health
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          All exports are read-only research artifacts. None of these outputs are connected to live execution.
        </p>
      </div>

    </div>
  );
}

// ─── Tab Navigation ───────────────────────────────────────────────────────────

type TabId = "ai" | "backtest" | "behavior" | "calibration";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "ai",          label: "AI Analysis",       icon: <Brain    className="w-3.5 h-3.5" /> },
  { id: "backtest",    label: "Backtest",           icon: <BarChart2 className="w-3.5 h-3.5" /> },
  { id: "behavior",    label: "Behavior Model",     icon: <Activity  className="w-3.5 h-3.5" /> },
  { id: "calibration", label: "Move Calibration",   icon: <Target    className="w-3.5 h-3.5" /> },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Research() {
  const [activeTab, setActiveTab] = useState<TabId>("ai");

  return (
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
      {activeTab === "behavior"    && <BehaviorModelTab />}
      {activeTab === "calibration" && <MoveCalibrationTab />}
    </div>
  );
}
