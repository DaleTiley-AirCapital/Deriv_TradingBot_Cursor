import React, { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Input } from "@/components/ui-elements";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import {
  Database, Download, RefreshCw, Play, Brain, Send, X, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, XCircle, Loader2, BarChart2, TrendingUp, FileDown, Table,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

const BASE = import.meta.env.BASE_URL || "/";
const api = (path: string) => `${BASE}api${path}`;

const STRATEGY_LABELS: Record<string, string> = {
  trend_continuation: "Trend Continuation",
  mean_reversion: "Mean Reversion",
  spike_cluster_recovery: "Spike Cluster Recovery",
  swing_exhaustion: "Swing Exhaustion",
  trendline_breakout: "Trendline Breakout",
  all_strategies: "All Strategies",
};

interface SymbolStatus {
  symbol: string;
  tier: "active" | "data" | "research";
  count1m: number;
  count5m: number;
  totalCandles: number;
  oldestDate: string | null;
  newestDate: string | null;
  lastBacktestDate: string | null;
  status: "healthy" | "stale" | "no_data";
}

interface DataStatusResponse {
  symbols: SymbolStatus[];
  totalStorage: number;
  symbolCount: number;
}

interface StrategyBreakdown {
  strategyName: string;
  winRate: number;
  profitFactor: number;
  netProfit: number;
  tradeCount: number;
  avgHoldingHours?: number;
  backtestId: number;
}

interface BacktestHistoryRun {
  id: number;
  createdAt: string;
  netProfit: number;
  winRate: number;
  tradeCount: number;
  metricsJson: { strategyBreakdown?: StrategyBreakdown[]; equityCurve?: { ts: string; equity: number }[] } | null;
}

interface SSEProgress {
  phase: string;
  symbol?: string;
  message?: string;
  candles?: number;
  pct?: number;
  strategyName?: string;
  direction?: string;
  score?: number;
  dateLabel?: string;
  openPositions?: number;
  profitableStrategies?: Array<{ strategyName: string; winRate: number; netProfit: number; tradeCount: number }>;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "healthy") return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  if (status === "stale") return <AlertTriangle className="w-4 h-4 text-amber-400" />;
  return <XCircle className="w-4 h-4 text-red-400" />;
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === "healthy" ? "default" : status === "stale" ? "warning" : "destructive";
  return <Badge variant={variant}>{status === "no_data" ? "No Data" : status}</Badge>;
}

function EquityCurveChart({ metricsJson }: { metricsJson: unknown }) {
  const metrics = metricsJson as { equityCurve?: { ts: string; equity: number }[] } | null;
  const curve = metrics?.equityCurve;
  if (!curve || curve.length < 2) return <div className="text-muted-foreground text-sm text-center py-6">No equity curve data.</div>;

  const data = curve.map((p, i) => ({
    idx: i,
    equity: Math.round(p.equity * 100) / 100,
    label: new Date(p.ts).toLocaleDateString(),
  }));
  const minE = Math.min(...data.map(d => d.equity));
  const maxE = Math.max(...data.map(d => d.equity));
  const startE = data[0].equity;

  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis dataKey="idx" tick={false} />
        <YAxis
          domain={[minE * 0.98, maxE * 1.02]}
          tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
          tick={{ fontSize: 10, fill: "#9ca3af" }}
          width={55}
        />
        <Tooltip
          formatter={(v: number) => [`$${v.toFixed(2)}`, "Equity"]}
          contentStyle={{ background: "#1f2937", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }}
        />
        <ReferenceLine y={startE} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function AIChatPanel({ backtestId, onClose }: { backtestId: number; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const res = await fetch(api("/research/ai-chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backtestId, message: userMsg }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages(prev => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
      } else {
        setMessages(prev => [...prev, { role: "assistant", content: data.answer }]);
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Failed"}` }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, backtestId]);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
    >
      <Card className="border-2 border-violet-500/30 bg-violet-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-violet-400" />
              AI Chat — Backtest #{backtestId}
            </span>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div ref={scrollRef} className="max-h-64 overflow-y-auto space-y-2 text-sm">
            {messages.length === 0 && (
              <p className="text-muted-foreground text-xs">Ask anything about this backtest — performance patterns, trade analysis, improvement suggestions...</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn("rounded-lg px-3 py-2 text-sm", m.role === "user" ? "bg-primary/10 text-foreground ml-8" : "bg-muted/30 text-foreground mr-8")}>
                <p className="text-[10px] text-muted-foreground mb-0.5 font-medium">{m.role === "user" ? "You" : "AI"}</p>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <Loader2 className="w-3 h-3 animate-spin" /> Thinking...
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Ask about this backtest..."
              className="flex-1 text-sm"
            />
            <Button variant="primary" onClick={sendMessage} disabled={loading || !input.trim()} className="px-3">
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function DataStatusSection() {
  const [data, setData] = useState<DataStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [sseProgress, setSSEProgress] = useState<Record<string, SSEProgress>>({});
  const [backtestLog, setBacktestLog] = useState<Record<string, string[]>>({});
  const [runningSymbol, setRunningSymbol] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  const [zipping, setZipping] = useState<string | null>(null);

  const [symbolHistory, setSymbolHistory] = useState<Record<string, BacktestHistoryRun[]>>({});
  const [selectedRunId, setSelectedRunId] = useState<Record<string, number>>({});
  const [chatBacktestId, setChatBacktestId] = useState<number | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<Record<string, number>>({});

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api("/research/data-status"));
      const json = await res.json();
      setData(json);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const fetchHistory = useCallback(async (symbol: string): Promise<BacktestHistoryRun[]> => {
    try {
      const res = await fetch(api(`/research/backtest-history?symbol=${symbol}`));
      const json = await res.json();
      if (json.runs) {
        setSymbolHistory(prev => ({ ...prev, [symbol]: json.runs as BacktestHistoryRun[] }));
        return json.runs as BacktestHistoryRun[];
      }
    } catch { /* ignore */ }
    return [];
  }, []);

  useEffect(() => {
    if (expandedSymbol && !symbolHistory[expandedSymbol]) {
      fetchHistory(expandedSymbol);
    }
  }, [expandedSymbol, fetchHistory, symbolHistory]);

  const handleDownloadSimulate = useCallback(async (symbol: string) => {
    setRunningSymbol(symbol);
    setSSEProgress(prev => ({ ...prev, [symbol]: { phase: "starting", symbol, message: "Starting..." } }));

    try {
      const res = await fetch(api("/research/download-simulate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const evt = JSON.parse(line.slice(6)) as SSEProgress;
            setSSEProgress(prev => ({ ...prev, [symbol]: evt }));
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setSSEProgress(prev => ({ ...prev, [symbol]: { phase: "error", symbol, message: err instanceof Error ? err.message : "Failed" } }));
    } finally {
      setRunningSymbol(null);
      fetchStatus();
    }
  }, [fetchStatus]);

  const handleRerunBacktest = useCallback(async (symbol: string, historicYears: number = 1) => {
    setRerunning(symbol);
    setBacktestLog(prev => ({ ...prev, [symbol]: [] }));
    try {
      const res = await fetch(api("/research/rerun-backtest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, historicYears }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastJson: Record<string, unknown> | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            lastJson = parsed;
            if (parsed.phase === "error") {
              setSSEProgress(prev => ({ ...prev, [symbol]: { phase: "error", symbol, message: String(parsed.error ?? "Unknown error") } }));
            } else if (parsed.phase === "progress") {
              const msg = String(parsed.message ?? "");
              setSSEProgress(prev => ({
                ...prev,
                [symbol]: {
                  phase: "progress",
                  symbol,
                  message: msg,
                  pct: parsed.pct as number | undefined,
                  strategyName: parsed.strategyName as string | undefined,
                  direction: parsed.direction as string | undefined,
                  score: parsed.score as number | undefined,
                  openPositions: parsed.openPositions as number | undefined,
                },
              }));
              if (msg) {
                setBacktestLog(prev => ({
                  ...prev,
                  [symbol]: [...(prev[symbol] ?? []).slice(-29), msg],
                }));
              }
            } else if (parsed.phase !== "done") {
              setSSEProgress(prev => ({ ...prev, [symbol]: { phase: parsed.phase as string, symbol, message: String(parsed.message ?? ""), pct: parsed.pct as number | undefined } }));
            }
          } catch { /* malformed line — skip */ }
        }
      }

      if (lastJson && lastJson.phase === "done") {
        const json = lastJson;
        const profitableCount = (json.profitableStrategies as { netProfit: number }[] ?? []).filter(s => s.netProfit > 0).length;
        setSSEProgress(prev => ({
          ...prev,
          [symbol]: {
            phase: "backtest_complete",
            symbol,
            profitableStrategies: json.profitableStrategies as Array<{ strategyName: string; winRate: number; netProfit: number; tradeCount: number }> | undefined,
            message: String(json.message) || `Re-run complete: ${profitableCount} profitable strategies`,
          },
        }));
      } else if (!lastJson || lastJson.phase !== "error") {
        setSSEProgress(prev => ({ ...prev, [symbol]: { phase: "error", symbol, message: "No result received" } }));
      }
    } catch (err) {
      setSSEProgress(prev => ({ ...prev, [symbol]: { phase: "error", symbol, message: err instanceof Error ? err.message : "Failed" } }));
    } finally {
      setRerunning(null);
      fetchStatus();
      const newHistory = await fetchHistory(symbol);
      if (newHistory.length > 0) {
        setSelectedRunId(prev => ({ ...prev, [symbol]: newHistory[0].id }));
      }
    }
  }, [fetchStatus, fetchHistory]);

  const handleZipExport = useCallback(async (symbol: string) => {
    setZipping(symbol);
    try {
      const endDate = Math.floor(Date.now() / 1000);
      const startDate = endDate - 90 * 24 * 3600;
      const res = await fetch(api("/export/research"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe: "1m", startDate, endDate }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${symbol}_research_bundle.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch { /* ignore download errors */ } finally {
      setZipping(null);
    }
  }, []);

  const handlePrune = useCallback(async () => {
    setPruning(true);
    try {
      await fetch(api("/research/prune-data"), { method: "POST" });
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setPruning(false);
    }
  }, [fetchStatus]);

  if (loading && !data) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground mt-2">Loading data status...</p>
        </CardContent>
      </Card>
    );
  }

  const activeSymbols = data?.symbols.filter(s => s.tier === "active") ?? [];
  const otherSymbols = data?.symbols.filter(s => s.tier !== "active") ?? [];

  const renderSymbolCard = (sym: SymbolStatus, showBacktest: boolean) => {
    const progress = sseProgress[sym.symbol];
    const isRunning = runningSymbol === sym.symbol;
    const isRerunning = rerunning === sym.symbol;
    const isExpanded = expandedSymbol === sym.symbol;
    const history = symbolHistory[sym.symbol] ?? [];
    const period = selectedPeriod[sym.symbol] ?? 1;
    const activeRunId = selectedRunId[sym.symbol] ?? history[0]?.id;
    const activeRun = history.find(r => r.id === activeRunId);
    const strategies = activeRun?.metricsJson?.strategyBreakdown ?? [];

    return (
      <div
        key={sym.symbol}
        className={cn(
          "border rounded-lg p-3 transition-all",
          sym.status === "healthy" ? "border-green-500/20 bg-green-500/5" :
          sym.status === "stale" ? "border-amber-500/20 bg-amber-500/5" :
          "border-red-500/20 bg-red-500/5"
        )}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <StatusIcon status={sym.status} />
            <span className="font-medium text-sm">{sym.symbol}</span>
            {sym.tier === "data" && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-medium">STREAMING</span>
            )}
            {sym.tier === "research" && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-medium">RESEARCH</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <StatusBadge status={sym.status} />
            <button
              onClick={() => setExpandedSymbol(isExpanded ? null : sym.symbol)}
              className="text-muted-foreground hover:text-foreground p-0.5"
            >
              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground mb-2">
          <span>1m: {sym.count1m.toLocaleString()}</span>
          <span>5m: {sym.count5m.toLocaleString()}</span>
          {sym.oldestDate && <span>From: {new Date(sym.oldestDate).toLocaleDateString()}</span>}
          {sym.newestDate && <span>To: {new Date(sym.newestDate).toLocaleDateString()}</span>}
        </div>

        {sym.totalCandles > 0 && (
          <div className="flex gap-1.5 mb-2">
            <a
              href={api(`/research/export-candles?symbol=${encodeURIComponent(sym.symbol)}&format=excel`)}
              download
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
            >
              <Table className="w-3 h-3" />
              Excel
            </a>
            <a
              href={api(`/research/export-candles?symbol=${encodeURIComponent(sym.symbol)}&format=json`)}
              download
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
            >
              <FileDown className="w-3 h-3" />
              JSON
            </a>
            <button
              onClick={() => handleZipExport(sym.symbol)}
              disabled={zipping === sym.symbol}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-colors disabled:opacity-50"
            >
              {zipping === sym.symbol ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              ZIP
            </button>
          </div>
        )}

        {sym.lastBacktestDate && (
          <p className="text-[10px] text-muted-foreground">
            Last backtest: {new Date(sym.lastBacktestDate).toLocaleDateString()} {new Date(sym.lastBacktestDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
        )}

        {progress && progress.phase !== "complete" && (
          <div className={cn(
            "mt-2 px-2 py-1.5 rounded text-xs",
            progress.phase === "error" ? "bg-red-500/10 text-red-400" :
            progress.phase === "data_sufficient" ? "bg-emerald-500/10 text-emerald-400" :
            "bg-blue-500/10 text-blue-300"
          )}>
            {progress.message}
          </div>
        )}

        {progress?.phase === "backtest_complete" && progress.profitableStrategies && (
          <div className="mt-2 px-2 py-1.5 rounded text-xs bg-green-500/10 text-green-400">
            {progress.message || `${progress.profitableStrategies.filter(s => s.netProfit > 0).length} profitable strategies found`}
          </div>
        )}

        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 pt-3 border-t border-border/30 space-y-2"
            >
              {/* Action buttons row */}
              <div className="flex gap-2 items-center">
                {sym.totalCandles === 0 ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleDownloadSimulate(sym.symbol)}
                    disabled={isRunning || !!runningSymbol}
                    className="flex-1 text-xs h-7"
                  >
                    {isRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Download className="w-3 h-3 mr-1" />}
                    {isRunning ? "Running..." : showBacktest ? "Download & Simulate" : "Download Data"}
                  </Button>
                ) : showBacktest ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleRerunBacktest(sym.symbol, period)}
                      disabled={isRerunning || !!runningSymbol}
                      className="flex-1 text-xs h-7"
                    >
                      {isRerunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
                      {isRerunning ? "Running..." : "Re-run Backtest"}
                    </Button>
                    <select
                      className="bg-muted/30 border border-border/50 rounded px-2 py-1 text-xs text-foreground h-7"
                      value={period}
                      onChange={e => setSelectedPeriod(prev => ({ ...prev, [sym.symbol]: parseInt(e.target.value) }))}
                      disabled={isRerunning || !!runningSymbol}
                    >
                      <option value={1}>1 Year</option>
                      <option value={2}>2 Years</option>
                      <option value={3}>3 Years</option>
                      <option value={4}>4 Years</option>
                      <option value={5}>5 Years</option>
                    </select>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownloadSimulate(sym.symbol)}
                    disabled={isRunning || !!runningSymbol}
                    className="flex-1 text-xs h-7"
                  >
                    {isRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Download className="w-3 h-3 mr-1" />}
                    {isRunning ? "Updating..." : "Update Data"}
                  </Button>
                )}
              </div>

              {/* Download progress */}
              {isRunning && (
                <div className="space-y-1.5">
                  <div className="w-full h-1.5 bg-muted/30 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: progress?.phase === "backtest_start" || progress?.phase === "backtest_complete" ? "80%" : progress?.phase === "download_complete" ? "60%" : "30%", transition: "width 0.5s ease" }} />
                  </div>
                  <p className="text-[10px] text-blue-300">{progress?.message || "Starting..."}</p>
                </div>
              )}

              {/* Rerun progress + log */}
              {isRerunning && (
                <div className="space-y-1.5">
                  <div className="relative h-1.5 w-full bg-muted/30 rounded-full overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-blue-500 to-violet-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(progress?.pct ?? 0, 3)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-blue-300">
                    {progress?.pct != null
                      ? `${progress.pct}% — ${progress.message || "scanning…"}`
                      : (progress?.message || "Starting simulation…")}
                  </p>
                  {(backtestLog[sym.symbol]?.length ?? 0) > 0 && (
                    <div
                      ref={el => { if (el) el.scrollTop = el.scrollHeight; }}
                      className="max-h-28 overflow-y-auto space-y-0.5 rounded bg-black/20 border border-white/5 px-2 py-1.5 font-mono"
                    >
                      {(backtestLog[sym.symbol] ?? []).map((line, i) => (
                        <p
                          key={i}
                          className={`text-[9px] ${
                            line.includes("Signal:") ? "text-violet-300" :
                            line.includes("open position") ? "text-blue-300" :
                            "text-slate-500"
                          }`}
                        >
                          {line}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Inline backtest results (only for active symbols with history) */}
              {showBacktest && history.length > 0 && !isRerunning && (
                <div className="space-y-3 pt-2 border-t border-border/20">
                  {/* History header + run dropdown */}
                  <div className="flex items-center gap-2">
                    <BarChart2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">Backtest Results</span>
                    <div className="flex-1" />
                    <select
                      className="bg-muted/30 border border-border/50 rounded px-2 py-1 text-xs text-foreground"
                      value={activeRunId ?? ""}
                      onChange={e => setSelectedRunId(prev => ({ ...prev, [sym.symbol]: parseInt(e.target.value) }))}
                    >
                      {history.map((run, idx) => (
                        <option key={run.id} value={run.id}>
                          #{idx + 1} — {new Date(run.createdAt).toLocaleDateString()} ({formatCurrency(run.netProfit)}, {run.tradeCount} trades)
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Strategy breakdown table */}
                  {strategies.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">No strategy data for this run.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border/50">
                            <th className="text-left px-2 py-1.5 text-muted-foreground font-medium">Strategy</th>
                            <th className="text-right px-2 py-1.5 text-muted-foreground font-medium">Net Profit</th>
                            <th className="text-right px-2 py-1.5 text-muted-foreground font-medium">Win Rate</th>
                            <th className="text-right px-2 py-1.5 text-muted-foreground font-medium">PF</th>
                            <th className="text-right px-2 py-1.5 text-muted-foreground font-medium">Trades</th>
                            <th className="text-right px-2 py-1.5 text-muted-foreground font-medium">Avg Hold</th>
                            <th className="px-2 py-1.5"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {strategies.map(strat => (
                            <tr key={strat.strategyName} className={cn("border-b border-border/10 hover:bg-muted/10", strat.netProfit <= 0 && strat.tradeCount === 0 && "opacity-40")}>
                              <td className="px-2 py-1.5 font-medium">{STRATEGY_LABELS[strat.strategyName] ?? strat.strategyName}</td>
                              <td className={cn("px-2 py-1.5 text-right mono-num", strat.netProfit > 0 ? "text-green-400" : strat.netProfit < 0 ? "text-red-400" : "text-muted-foreground")}>{formatCurrency(strat.netProfit)}</td>
                              <td className="px-2 py-1.5 text-right mono-num">{strat.tradeCount > 0 ? formatPercent(strat.winRate) : "—"}</td>
                              <td className="px-2 py-1.5 text-right mono-num">{strat.tradeCount === 0 ? "—" : strat.profitFactor == null ? "—" : strat.profitFactor === Infinity ? "∞" : strat.profitFactor.toFixed(2)}</td>
                              <td className="px-2 py-1.5 text-right mono-num">{strat.tradeCount}</td>
                              <td className="px-2 py-1.5 text-right mono-num text-muted-foreground">{strat.avgHoldingHours != null && strat.tradeCount > 0 ? `${(strat.avgHoldingHours / 24).toFixed(1)}d` : "—"}</td>
                              <td className="px-2 py-1.5">
                                <button
                                  onClick={() => setChatBacktestId(strat.backtestId ?? activeRunId ?? null)}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-violet-400 hover:bg-violet-500/10 transition-colors"
                                >
                                  <Brain className="w-2.5 h-2.5" /> AI
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Equity curve */}
                  {activeRun && (
                    <EquityCurveChart metricsJson={activeRun.metricsJson} />
                  )}

                  {/* AI Chat panel */}
                  <AnimatePresence>
                    {chatBacktestId != null && (
                      <AIChatPanel
                        backtestId={chatBacktestId}
                        onClose={() => setChatBacktestId(null)}
                      />
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Empty state for active symbols with no history yet */}
              {showBacktest && history.length === 0 && !isRerunning && (
                <div className="pt-2 border-t border-border/20">
                  <p className="text-xs text-muted-foreground text-center py-2">
                    No backtest history. Run a backtest above to see results.
                  </p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-green-400" />
              Active Trading Symbols
              <span className="text-xs font-normal text-muted-foreground">({activeSymbols.length})</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {data?.totalStorage?.toLocaleString() ?? 0} total candles
              </span>
              <Button variant="outline" size="sm" onClick={handlePrune} disabled={pruning} className="text-xs h-7">
                {pruning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                Prune Old
              </Button>
              <Button variant="outline" size="sm" onClick={fetchStatus} disabled={loading} className="text-xs h-7">
                <RefreshCw className={cn("w-3 h-3 mr-1", loading && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </CardTitle>
          <p className="text-xs text-muted-foreground">Scanned for signals and traded. Download data and run backtests.</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {activeSymbols.map(sym => renderSymbolCard(sym, true))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-4 h-4 text-violet-400" />
            Research & Data Collection
            <span className="text-xs font-normal text-muted-foreground">({otherSymbols.length})</span>
          </CardTitle>
          <p className="text-xs text-muted-foreground">Data collection and research symbols. Download data manually for analysis.</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {otherSymbols.map(sym => renderSymbolCard(sym, false))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Research() {
  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="page-title">Research</h1>
        <p className="page-subtitle">Data health monitoring, per-symbol backtesting, and AI-powered analysis</p>
      </div>

      <DataStatusSection />
    </div>
  );
}
