import React, { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Input } from "@/components/ui-elements";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import {
  Database, Download, RefreshCw, Play, Brain, Send, X, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, XCircle, Loader2, BarChart2, TrendingUp,
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
  breakout_expansion: "Breakout / Expansion",
  spike_event: "Spike / Event",
  all_strategies: "All Strategies",
};

interface SymbolStatus {
  symbol: string;
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
  backtestId: number;
}

interface GroupedSymbol {
  symbol: string;
  latestBacktestId: number;
  latestBacktestDate: string;
  strategies: StrategyBreakdown[];
  portfolioNetProfit: number;
  portfolioWinRate: number;
}

interface SSEProgress {
  phase: string;
  symbol?: string;
  message?: string;
  candles?: number;
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

function DataStatusSection({ onBacktestComplete }: { onBacktestComplete?: () => void }) {
  const [data, setData] = useState<DataStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [sseProgress, setSSEProgress] = useState<Record<string, SSEProgress>>({});
  const [runningSymbol, setRunningSymbol] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);

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
      onBacktestComplete?.();
    }
  }, [fetchStatus, onBacktestComplete]);

  const handleRerunBacktest = useCallback(async (symbol: string) => {
    setRerunning(symbol);
    try {
      const res = await fetch(api("/research/rerun-backtest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const json = await res.json();
      if (json.error) {
        setSSEProgress(prev => ({ ...prev, [symbol]: { phase: "error", symbol, message: json.error } }));
      } else {
        setSSEProgress(prev => ({
          ...prev,
          [symbol]: {
            phase: "backtest_complete",
            symbol,
            profitableStrategies: json.profitableStrategies,
            message: json.profitableStrategies?.length > 0
              ? `Re-run complete: ${json.profitableStrategies.length} profitable strategies`
              : json.message || "No profitable strategies",
          },
        }));
      }
    } catch (err) {
      setSSEProgress(prev => ({ ...prev, [symbol]: { phase: "error", symbol, message: err instanceof Error ? err.message : "Failed" } }));
    } finally {
      setRerunning(null);
      fetchStatus();
      onBacktestComplete?.();
    }
  }, [fetchStatus, onBacktestComplete]);

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Database className="w-4 h-4" />
            Data Status
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
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {data?.symbols.map(sym => {
            const progress = sseProgress[sym.symbol];
            const isRunning = runningSymbol === sym.symbol;
            const isRerunning = rerunning === sym.symbol;
            const isExpanded = expandedSymbol === sym.symbol;

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
                    {progress.profitableStrategies.length} profitable strategies found
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
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleDownloadSimulate(sym.symbol)}
                          disabled={isRunning || !!runningSymbol}
                          className="flex-1 text-xs h-7"
                        >
                          {isRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Download className="w-3 h-3 mr-1" />}
                          {isRunning ? "Running..." : "Download & Simulate"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRerunBacktest(sym.symbol)}
                          disabled={isRerunning || sym.totalCandles === 0 || !!runningSymbol}
                          className="flex-1 text-xs h-7"
                        >
                          {isRerunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
                          {isRerunning ? "Running..." : "Re-run Backtest"}
                        </Button>
                      </div>
                      {isRunning && (
                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-muted/30 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: progress?.phase === "backtest_start" || progress?.phase === "backtest_complete" ? "80%" : progress?.phase === "download_complete" ? "60%" : "30%", transition: "width 0.5s ease" }} />
                          </div>
                          <p className="text-[10px] text-blue-300">{progress?.message || "Starting..."}</p>
                        </div>
                      )}
                      {isRerunning && (
                        <div className="space-y-1.5">
                          <div className="w-full h-1.5 bg-muted/30 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-500 rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite]" style={{ width: "40%" }} />
                          </div>
                          <p className="text-[10px] text-amber-300">Running backtest simulation...</p>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function GroupedResultsSection({ refreshTrigger }: { refreshTrigger: number }) {
  const [data, setData] = useState<{ symbols: GroupedSymbol[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [chatBacktestId, setChatBacktestId] = useState<number | null>(null);
  const [selectedBacktestRun, setSelectedBacktestRun] = useState<{ id: number; metricsJson: unknown } | null>(null);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api("/research/grouped-results"));
      const json = await res.json();
      setData(json);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchResults(); }, [fetchResults]);
  useEffect(() => { if (refreshTrigger > 0) fetchResults(); }, [refreshTrigger]);

  const loadBacktestDetail = useCallback(async (backtestId: number) => {
    try {
      const res = await fetch(api(`/backtest/results?limit=100&offset=0`));
      const json = await res.json();
      const allRuns = json.data as Array<{ id: number; metricsJson: unknown }>;
      const run = allRuns?.find(r => r.id === backtestId);
      if (run) setSelectedBacktestRun(run);
    } catch { /* ignore */ }
  }, []);

  if (loading && !data) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground mt-2">Loading backtest results...</p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.symbols || data.symbols.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <BarChart2 className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No backtest results yet. Run setup or use Download & Simulate above.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <BarChart2 className="w-5 h-5" />
          Backtest Results by Symbol
        </h2>
        <Button variant="outline" size="sm" onClick={fetchResults} disabled={loading} className="text-xs h-7">
          <RefreshCw className={cn("w-3 h-3 mr-1", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {data.symbols.map(sym => {
        const isExpanded = expandedSymbol === sym.symbol;

        return (
          <Card key={sym.symbol}>
            <div
              className="p-4 cursor-pointer hover:bg-muted/20 transition-colors"
              onClick={() => setExpandedSymbol(isExpanded ? null : sym.symbol)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-foreground">{sym.symbol}</span>
                  <Badge variant={(sym.portfolioNetProfit ?? 0) > 0 ? "default" : "destructive"}>
                    {(sym.portfolioNetProfit ?? 0) > 0 ? "+" : ""}{formatCurrency(sym.portfolioNetProfit)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {sym.strategies.length} profitable {sym.strategies.length === 1 ? "strategy" : "strategies"}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    WR: {formatPercent(sym.portfolioWinRate)}
                  </span>
                  <span className="text-xs text-muted-foreground text-right leading-tight">
                    <span>{new Date(sym.latestBacktestDate).toLocaleDateString()}</span>
                    <br />
                    <span className="text-[10px]">{new Date(sym.latestBacktestDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
              </div>
            </div>

            <AnimatePresence>
              {isExpanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="border-t border-border/50"
                >
                  <div className="p-4 space-y-4">
                    {sym.strategies.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">No profitable strategies found for this symbol.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border/50">
                              <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Strategy</th>
                              <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Net Profit</th>
                              <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Win Rate</th>
                              <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Profit Factor</th>
                              <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Trades</th>
                              <th className="px-3 py-2"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {sym.strategies.map(strat => (
                              <tr key={strat.strategyName} className="border-b border-border/20 hover:bg-muted/10">
                                <td className="px-3 py-2 font-medium">{STRATEGY_LABELS[strat.strategyName] ?? strat.strategyName}</td>
                                <td className="px-3 py-2 text-right mono-num profit">{formatCurrency(strat.netProfit)}</td>
                                <td className="px-3 py-2 text-right mono-num">{formatPercent(strat.winRate)}</td>
                                <td className="px-3 py-2 text-right mono-num">{strat.profitFactor == null ? "—" : strat.profitFactor === Infinity ? "∞" : strat.profitFactor.toFixed(2)}</td>
                                <td className="px-3 py-2 text-right mono-num">{strat.tradeCount}</td>
                                <td className="px-3 py-2 text-right">
                                  <button
                                    onClick={() => setChatBacktestId(strat.backtestId)}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-violet-400 hover:bg-violet-500/10 transition-colors"
                                  >
                                    <Brain className="w-3 h-3" /> AI Chat
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => loadBacktestDetail(sym.latestBacktestId)}
                      >
                        <TrendingUp className="w-3 h-3 mr-1" /> View Equity Curve
                      </Button>
                    </div>

                    {selectedBacktestRun?.id === sym.latestBacktestId && (
                      <div className="mt-2">
                        <EquityCurveChart metricsJson={selectedBacktestRun.metricsJson} />
                      </div>
                    )}

                    <AnimatePresence>
                      {chatBacktestId && sym.strategies.some(s => s.backtestId === chatBacktestId) && (
                        <AIChatPanel
                          backtestId={chatBacktestId}
                          onClose={() => setChatBacktestId(null)}
                        />
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        );
      })}
    </div>
  );
}

export default function Research() {
  const [resultsRefreshTrigger, setResultsRefreshTrigger] = useState(0);
  const handleBacktestComplete = useCallback(() => {
    setResultsRefreshTrigger(prev => prev + 1);
  }, []);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="page-title">Research</h1>
        <p className="page-subtitle">Data health monitoring, per-symbol backtesting, and AI-powered analysis</p>
      </div>

      <DataStatusSection onBacktestComplete={handleBacktestComplete} />
      <GroupedResultsSection refreshTrigger={resultsRefreshTrigger} />
    </div>
  );
}
