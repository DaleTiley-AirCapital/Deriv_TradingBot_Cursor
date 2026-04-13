import { useState, useRef, useEffect } from "react";
import {
  FlaskConical, Brain, Play, RefreshCw,
  Loader2, CheckCircle, XCircle,
  FileText, Clock, BarChart2, ChevronRight, Download,
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

// ─── Tab Navigation ───────────────────────────────────────────────────────────

type TabId = "ai" | "backtest";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "ai", label: "AI Analysis", icon: <Brain className="w-3.5 h-3.5" /> },
  { id: "backtest", label: "Backtest", icon: <BarChart2 className="w-3.5 h-3.5" /> },
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

      {activeTab === "ai" && <AiAnalysisTab />}
      {activeTab === "backtest" && <BacktestTab />}
    </div>
  );
}
