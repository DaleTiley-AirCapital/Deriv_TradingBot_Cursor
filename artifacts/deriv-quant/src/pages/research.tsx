import React, { useState } from "react";
import {
  useGetBacktestResults,
  useRunBacktest,
  useAnalyseBacktest,
  useGetBacktestTrades,
  useGetBacktestCandles,
  getGetBacktestResultsQueryKey,
} from "@workspace/api-client-react";
import type { BacktestAnalysis, BacktestRun, BacktestTrade, OhlcCandle } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Input, Label, Select } from "@/components/ui-elements";
import { formatCurrency, formatNumber, formatPercent, cn } from "@/lib/utils";
import { Play, Search, Beaker, Brain, Lightbulb, X, CheckCircle2, ChevronRight, ChevronLeft, BarChart2, TrendingUp, List } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ComposedChart,
  LineChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Scatter,
  ReferenceLine,
  Cell,
} from "recharts";

const STRATEGY_INFO: Record<string, { label: string; description: string; indicator: string }> = {
  "trend_continuation": {
    label: "Trend Continuation",
    description: "Identifies a strong prevailing trend, then waits for a short counter-move (pullback) before entering in the trend direction. Works best on Boom/Crash indices during sustained directional runs.",
    indicator: "RSI(14) + EMA(20) confirmation — enters when price is within 1% of EMA and RSI is between 40–65",
  },
  "mean_reversion": {
    label: "Mean Reversion",
    description: "Detects when price has moved too far, too fast — using RSI extremes, momentum divergence, and liquidity sweep setups — and bets on a snap-back. Suited for Volatility indices and rangy Boom/Crash phases.",
    indicator: "RSI(14) extremes + Z-score + swing breach/reclaim for liquidity sweeps",
  },
  "breakout_expansion": {
    label: "Breakout / Expansion",
    description: "Monitors Bollinger Band width compression (low volatility squeezes), then enters the first large expansion candle in the breakout direction. Also captures volatility expansion moves after compression.",
    indicator: "BB width + ATR rank expansion + body size confirmation",
  },
  "spike_event": {
    label: "Spike / Event",
    description: "Estimates the probability of an imminent spike on Boom or Crash indices using tick-rate analysis and inter-spike timing models. Positions are sized conservatively given the high uncertainty of spike timing.",
    indicator: "Probabilistic spike model — fires at ~15% frequency; direction follows symbol type (Boom=long, Crash=short)",
  },
};

function AIAnalysisPanel({ analysis, onClose }: { analysis: BacktestAnalysis; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
    >
      <Card className="border-2 border-violet-500/30 bg-violet-500/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm">
              <Brain className="w-4 h-4 text-violet-400" />
              AI Analysis
            </span>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <h4 className="font-semibold text-foreground mb-1">Summary</h4>
            <p className="text-muted-foreground">{analysis.summary}</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="font-semibold text-green-400 mb-1">What Worked</h4>
              <p className="text-muted-foreground">{analysis.whatWorked}</p>
            </div>
            <div>
              <h4 className="font-semibold text-red-400 mb-1">What Didn't Work</h4>
              <p className="text-muted-foreground">{analysis.whatDidNot}</p>
            </div>
          </div>
          {analysis.suggestions.length > 0 && (
            <div>
              <h4 className="font-semibold text-amber-400 mb-2 flex items-center gap-1">
                <Lightbulb className="w-3 h-3" />
                Suggestions
              </h4>
              <ul className="space-y-1">
                {analysis.suggestions.map((s, i) => (
                  <li key={i} className="text-muted-foreground flex items-start gap-2">
                    <span className="text-amber-400 font-mono text-xs mt-0.5">{i + 1}.</span>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function EquityCurveChart({ metricsJson }: { metricsJson: unknown }) {
  const metrics = metricsJson as { equityCurve?: { ts: string; equity: number }[] } | null;
  const curve = metrics?.equityCurve;
  if (!curve || curve.length < 2) {
    return <div className="text-muted-foreground text-sm text-center py-8">No equity curve data available.</div>;
  }

  const data = curve.map((p, i) => ({
    idx: i,
    equity: Math.round(p.equity * 100) / 100,
    label: new Date(p.ts).toLocaleDateString(),
  }));

  const minEquity = Math.min(...data.map(d => d.equity));
  const maxEquity = Math.max(...data.map(d => d.equity));
  const startEquity = data[0].equity;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis dataKey="idx" tick={false} />
        <YAxis
          domain={[minEquity * 0.98, maxEquity * 1.02]}
          tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
          tick={{ fontSize: 10, fill: "#9ca3af" }}
          width={55}
        />
        <Tooltip
          formatter={(v: number) => [`$${v.toFixed(2)}`, "Equity"]}
          labelFormatter={(l) => `Step ${l}`}
          contentStyle={{ background: "#1f2937", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }}
        />
        <ReferenceLine y={startEquity} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
        <Line
          type="monotone"
          dataKey="equity"
          stroke="#10b981"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function CandlestickWithTrades({ candles, trades }: { candles: OhlcCandle[]; trades: BacktestTrade[] }) {
  if (!candles || candles.length === 0) {
    return <div className="text-muted-foreground text-sm text-center py-8">Loading candle data...</div>;
  }

  const sample = candles.length > 200 ? candles.slice(Math.floor(candles.length / 2) - 100, Math.floor(candles.length / 2) + 100) : candles;

  const data = sample.map((c, i) => {
    const isUp = c.close >= c.open;
    return {
      idx: i,
      ts: c.ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      candleBody: [Math.min(c.open, c.close), Math.max(c.open, c.close)] as [number, number],
      wick: [c.low, c.high] as [number, number],
      isUp,
      label: new Date(c.ts).toLocaleDateString(),
    };
  });

  const tradeEntries = trades
    .filter(t => {
      const ts = new Date(t.entryTs).getTime();
      const firstTs = new Date(sample[0].ts).getTime();
      const lastTs = new Date(sample[sample.length - 1].ts).getTime();
      return ts >= firstTs && ts <= lastTs;
    })
    .map(t => {
      const entryTs = new Date(t.entryTs).getTime();
      const closest = sample.reduce((best, c, i) => {
        const diff = Math.abs(new Date(c.ts).getTime() - entryTs);
        return diff < best.diff ? { idx: i, diff } : best;
      }, { idx: 0, diff: Infinity });
      return {
        idx: closest.idx,
        price: t.entryPrice,
        isWin: (t.pnl ?? 0) > 0,
        type: "entry",
        direction: t.direction,
        pnl: t.pnl,
      };
    });

  const tradeExits = trades
    .filter(t => t.exitTs && t.exitPrice != null)
    .filter(t => {
      const ts = new Date(t.exitTs!).getTime();
      const firstTs = new Date(sample[0].ts).getTime();
      const lastTs = new Date(sample[sample.length - 1].ts).getTime();
      return ts >= firstTs && ts <= lastTs;
    })
    .map(t => {
      const exitTs = new Date(t.exitTs!).getTime();
      const closest = sample.reduce((best, c, i) => {
        const diff = Math.abs(new Date(c.ts).getTime() - exitTs);
        return diff < best.diff ? { idx: i, diff } : best;
      }, { idx: 0, diff: Infinity });
      return {
        idx: closest.idx,
        price: t.exitPrice as number,
        isWin: (t.pnl ?? 0) > 0,
        type: "exit",
        pnl: t.pnl,
      };
    });

  const allPrices = sample.flatMap(c => [c.high, c.low]);
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const pad = (maxP - minP) * 0.05;

  const CustomCandlestickBar = (props: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    payload?: { open: number; close: number; high: number; low: number; isUp: boolean };
    yScale?: (v: number) => number;
  }) => {
    const { x = 0, width = 8, payload, yScale } = props;
    if (!payload || !yScale) return null;
    const { open, close, high, low, isUp } = payload;
    const color = isUp ? "#10b981" : "#ef4444";
    const bodyTop = yScale(Math.max(open, close));
    const bodyBottom = yScale(Math.min(open, close));
    const bodyHeight = Math.max(bodyBottom - bodyTop, 1);
    const wickTop = yScale(high);
    const wickBottom = yScale(low);
    const center = x + width / 2;
    const barWidth = Math.max(width - 2, 2);
    return (
      <g>
        <line x1={center} y1={wickTop} x2={center} y2={bodyTop} stroke={color} strokeWidth={1} />
        <rect x={x + 1} y={bodyTop} width={barWidth} height={bodyHeight} fill={color} rx={0.5} />
        <line x1={center} y1={bodyBottom} x2={center} y2={wickBottom} stroke={color} strokeWidth={1} />
      </g>
    );
  };

  const CustomEntryDot = (props: { cx?: number; cy?: number; payload?: { isWin: boolean; direction: string } }) => {
    const { cx = 0, cy = 0, payload } = props;
    if (!payload) return null;
    const color = "#22c55e";
    return (
      <g>
        <polygon
          points={`${cx},${cy - 8} ${cx - 5},${cy + 2} ${cx + 5},${cy + 2}`}
          fill={color}
          stroke="rgba(0,0,0,0.5)"
          strokeWidth={0.5}
        />
      </g>
    );
  };

  const CustomExitDot = (props: { cx?: number; cy?: number; payload?: { isWin: boolean } }) => {
    const { cx = 0, cy = 0, payload } = props;
    if (!payload) return null;
    const color = payload.isWin ? "#10b981" : "#ef4444";
    return (
      <g>
        <polygon
          points={`${cx},${cy + 8} ${cx - 5},${cy - 2} ${cx + 5},${cy - 2}`}
          fill={color}
          stroke="rgba(0,0,0,0.5)"
          strokeWidth={0.5}
        />
      </g>
    );
  };

  return (
    <div className="text-xs text-muted-foreground mb-1">
      <div className="flex items-center gap-4 mb-2">
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-green-500 rounded-sm" /> Up candle</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-red-500 rounded-sm" /> Down candle</span>
        <span className="flex items-center gap-1 text-green-400">▲ Entry</span>
        <span className="flex items-center gap-1 text-green-400">▽ Profitable exit</span>
        <span className="flex items-center gap-1 text-red-400">▽ Loss exit</span>
      </div>
      <ResponsiveContainer width="100%" height={250}>
        <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="idx" tick={false} />
          <YAxis
            domain={[minP - pad, maxP + pad]}
            tickFormatter={(v) => v.toFixed(2)}
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            width={60}
            scale="linear"
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload;
              if (!d) return null;
              return (
                <div style={{ background: "#1f2937", border: "1px solid rgba(255,255,255,0.1)", padding: "6px 10px", fontSize: 11 }}>
                  <div className="font-medium mb-1">{new Date(d.ts).toLocaleDateString()}</div>
                  <div>O: {d.open?.toFixed(4)} H: {d.high?.toFixed(4)}</div>
                  <div>L: {d.low?.toFixed(4)} C: {d.close?.toFixed(4)}</div>
                </div>
              );
            }}
          />
          <Bar dataKey="close" shape={<CustomCandlestickBar />} isAnimationActive={false}>
            {data.map((_, i) => (
              <Cell key={i} fill={data[i].isUp ? "#10b981" : "#ef4444"} />
            ))}
          </Bar>
          <Scatter
            data={tradeEntries}
            dataKey="price"
            shape={<CustomEntryDot />}
            isAnimationActive={false}
          />
          <Scatter
            data={tradeExits}
            dataKey="price"
            shape={<CustomExitDot />}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function BacktestDetailPanel({ run, onClose }: { run: BacktestRun; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"overview" | "chart" | "trades" | "ai">("overview");
  const { data: trades, isLoading: tradesLoading } = useGetBacktestTrades(run.id);
  const { data: candles, isLoading: candlesLoading } = useGetBacktestCandles(run.id);
  const { mutate: analyseBacktest, isPending: analysing } = useAnalyseBacktest();
  const [analysis, setAnalysis] = useState<BacktestAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const stratInfo = STRATEGY_INFO[run.strategyName] ?? { label: run.strategyName, description: "", indicator: "" };
  const config = run.configJson as { allocationMode?: string } | null | undefined;
  const metricsJson = run.metricsJson;

  const handleAnalyse = () => {
    setAnalysisError(null);
    analyseBacktest(
      { id: run.id },
      {
        onSuccess: (data) => setAnalysis(data),
        onError: (err: unknown) => {
          const error = err as { data?: { error?: string }; message?: string };
          setAnalysisError(error?.data?.error || error?.message || "AI analysis failed. Check your OpenAI API key in Settings.");
        },
      }
    );
  };

  const tabs = [
    { id: "overview" as const, label: "Overview", icon: BarChart2 },
    { id: "chart" as const, label: "Price Chart", icon: TrendingUp },
    { id: "trades" as const, label: "Trade List", icon: List },
    { id: "ai" as const, label: "AI Analysis", icon: Brain },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, x: "100%" }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 200 }}
      className="fixed top-0 right-0 h-full w-full max-w-3xl bg-background border-l border-border z-50 flex flex-col shadow-2xl"
    >
      <div className="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
        <div>
          <h2 className="font-semibold text-foreground text-base">Backtest #{run.id} — {stratInfo.label}</h2>
          <p className="text-muted-foreground text-xs mt-0.5">{run.symbol} · {new Date(run.createdAt).toLocaleDateString()}</p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex border-b border-border flex-shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2",
              activeTab === tab.id
                ? "border-violet-500 text-violet-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === "overview" && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Strategy Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground leading-relaxed">{stratInfo.description}</p>
                {stratInfo.indicator && (
                  <div className="bg-violet-500/10 border border-violet-500/20 rounded px-3 py-2 text-xs text-violet-300">
                    <span className="font-medium text-violet-400">Signal: </span>{stratInfo.indicator}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Parameters Used</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-muted/30 rounded px-3 py-2">
                    <div className="text-muted-foreground text-xs">Initial Capital</div>
                    <div className="font-medium">{formatCurrency(run.initialCapital)}</div>
                  </div>
                  <div className="bg-muted/30 rounded px-3 py-2">
                    <div className="text-muted-foreground text-xs">Risk Allocation</div>
                    <div className="font-medium capitalize">{config?.allocationMode ?? "balanced"}</div>
                  </div>
                  <div className="bg-muted/30 rounded px-3 py-2">
                    <div className="text-muted-foreground text-xs">Position Size</div>
                    <div className="font-medium">
                      {config?.allocationMode === "aggressive" ? "40%" : config?.allocationMode === "conservative" ? "15%" : "25%"}
                    </div>
                  </div>
                  <div className="bg-muted/30 rounded px-3 py-2">
                    <div className="text-muted-foreground text-xs">Hold Logic</div>
                    <div className="font-medium">Hold until SL/TP hit (max 120 h)</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Performance Metrics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  {[
                    { label: "Net Profit", value: formatCurrency(run.netProfit), positive: (run.netProfit ?? 0) > 0, negative: (run.netProfit ?? 0) < 0 },
                    { label: "Total Return", value: formatPercent(run.totalReturn), positive: (run.totalReturn ?? 0) > 0, negative: (run.totalReturn ?? 0) < 0 },
                    { label: "Win Rate", value: formatPercent(run.winRate) },
                    { label: "Profit Factor", value: formatNumber(run.profitFactor) },
                    { label: "Max Drawdown", value: formatPercent(run.maxDrawdown), negative: true },
                    { label: "Sharpe Ratio", value: formatNumber(run.sharpeRatio) },
                    { label: "Trade Count", value: String(run.tradeCount ?? 0) },
                    { label: "Avg Hold (h)", value: formatNumber(run.avgHoldingHours) },
                    { label: "Expectancy", value: formatCurrency(run.expectancy) },
                  ].map(m => (
                    <div key={m.label} className="bg-muted/30 rounded px-3 py-2">
                      <div className="text-muted-foreground text-xs">{m.label}</div>
                      <div className={cn("font-medium mono-num text-sm", m.positive ? "profit" : m.negative ? "loss" : "")}>
                        {m.value}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="w-3.5 h-3.5" />
                  Equity Curve
                </CardTitle>
              </CardHeader>
              <CardContent>
                <EquityCurveChart metricsJson={metricsJson} />
              </CardContent>
            </Card>
          </>
        )}

        {activeTab === "chart" && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5" />
                Candlestick Chart — {run.symbol}
                {tradesLoading || candlesLoading ? <span className="text-xs text-muted-foreground ml-2">Loading...</span> : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {candlesLoading ? (
                <div className="text-muted-foreground text-sm text-center py-12">Loading candle data...</div>
              ) : (
                <CandlestickWithTrades candles={candles ?? []} trades={trades ?? []} />
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === "trades" && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <List className="w-3.5 h-3.5" />
                Individual Trades ({trades?.length ?? 0})
              </CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              {tradesLoading ? (
                <div className="text-muted-foreground text-sm text-center py-12 px-4">Loading trades...</div>
              ) : !trades || trades.length === 0 ? (
                <div className="text-muted-foreground text-sm text-center py-12 px-4">No trade records found for this backtest.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Entry Time</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Exit Time</th>
                      <th className="px-3 py-2 text-muted-foreground font-medium">Dir</th>
                      <th className="text-right px-3 py-2 text-muted-foreground font-medium">Entry $</th>
                      <th className="text-right px-3 py-2 text-muted-foreground font-medium">Exit $</th>
                      <th className="text-right px-3 py-2 text-muted-foreground font-medium">P&L</th>
                      <th className="px-3 py-2 text-muted-foreground font-medium">Exit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => {
                      const isWin = (t.pnl ?? 0) > 0;
                      return (
                        <tr key={t.id} className="border-b border-border/50 hover:bg-muted/20">
                          <td className="px-3 py-1.5 mono-num text-muted-foreground">
                            {new Date(t.entryTs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td className="px-3 py-1.5 mono-num text-muted-foreground">
                            {t.exitTs ? new Date(t.exitTs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            <span className={cn("px-1.5 py-0.5 rounded text-xs font-medium", t.direction === "long" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400")}>
                              {t.direction === "long" ? "L" : "S"}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right mono-num">{t.entryPrice.toFixed(4)}</td>
                          <td className="px-3 py-1.5 text-right mono-num">{t.exitPrice != null ? t.exitPrice.toFixed(4) : "—"}</td>
                          <td className={cn("px-3 py-1.5 text-right mono-num font-medium", isWin ? "profit" : "loss")}>
                            {t.pnl != null ? (t.pnl > 0 ? "+" : "") + formatCurrency(t.pnl) : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            <span className={cn(
                              "px-1.5 py-0.5 rounded text-xs font-medium",
                              t.exitReason === "TP" ? "bg-green-500/20 text-green-400" :
                              t.exitReason === "SL" ? "bg-red-500/20 text-red-400" :
                              "bg-amber-500/20 text-amber-400"
                            )}>
                              {t.exitReason ?? "—"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        )}

        {activeTab === "ai" && (
          <div className="space-y-4">
            {!analysis && (
              <Card>
                <CardContent className="py-8 text-center space-y-3">
                  <Brain className="w-8 h-8 text-violet-400 mx-auto" />
                  <p className="text-muted-foreground text-sm">Get AI-powered insights on this backtest's performance.</p>
                  <Button
                    variant="primary"
                    onClick={handleAnalyse}
                    isLoading={analysing}
                    className="mx-auto"
                  >
                    <Brain className="w-4 h-4 mr-2" />
                    Run AI Analysis
                  </Button>
                  {analysisError && (
                    <p className="text-red-400 text-xs mt-2">{analysisError}</p>
                  )}
                </CardContent>
              </Card>
            )}
            {analysis && (
              <AnimatePresence>
                <AIAnalysisPanel
                  analysis={analysis}
                  onClose={() => setAnalysis(null)}
                />
              </AnimatePresence>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

const PAGE_SIZE = 40;

export default function Research() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const { data: paginatedData, isLoading } = useGetBacktestResults({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const results = paginatedData?.data;
  const totalResults = paginatedData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalResults / PAGE_SIZE));

  const { mutate: runBacktest, isPending } = useRunBacktest({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBacktestResultsQueryKey() });
      }
    }
  });

  const [form, setForm] = useState({
    strategyName: "trend_continuation",
    symbol: "BOOM1000",
    initialCapital: 10000,
    allocationMode: "balanced" as "conservative" | "balanced" | "aggressive"
  });

  const [selectedRun, setSelectedRun] = useState<BacktestRun | null>(null);

  const handleRun = (e: React.FormEvent) => {
    e.preventDefault();
    runBacktest({ data: form });
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Research</h1>
          <p className="page-subtitle">Multi-strategy backtesting engine with AI analysis</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Beaker className="w-4 h-4" />
                New Backtest Run
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleRun} className="space-y-4">
                <div className="space-y-2">
                  <Label>Strategy</Label>
                  <Select
                    value={form.strategyName}
                    onChange={e => setForm({...form, strategyName: e.target.value})}
                  >
                    <option value="trend_continuation">Trend Continuation</option>
                    <option value="mean_reversion">Mean Reversion</option>
                    <option value="breakout_expansion">Breakout / Expansion</option>
                    <option value="spike_event">Spike / Event</option>
                  </Select>
                  {STRATEGY_INFO[form.strategyName] && (
                    <p className="text-xs text-muted-foreground leading-relaxed pt-1">
                      {STRATEGY_INFO[form.strategyName].description}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Symbol</Label>
                  <Select
                    value={form.symbol}
                    onChange={e => setForm({...form, symbol: e.target.value})}
                  >
                    <optgroup label="Boom/Crash">
                      <option value="BOOM1000">Boom 1000</option>
                      <option value="CRASH1000">Crash 1000</option>
                      <option value="BOOM900">Boom 900</option>
                      <option value="CRASH900">Crash 900</option>
                      <option value="BOOM600">Boom 600</option>
                      <option value="CRASH600">Crash 600</option>
                      <option value="BOOM500">Boom 500</option>
                      <option value="CRASH500">Crash 500</option>
                      <option value="BOOM300">Boom 300</option>
                      <option value="CRASH300">Crash 300</option>
                    </optgroup>
                    <optgroup label="Volatility">
                      <option value="R_10">Volatility 10</option>
                      <option value="R_25">Volatility 25</option>
                      <option value="R_50">Volatility 50</option>
                      <option value="R_75">Volatility 75</option>
                      <option value="R_100">Volatility 100</option>
                    </optgroup>
                    <optgroup label="Bull/Bear">
                      <option value="RDBULL">Bull Market</option>
                      <option value="RDBEAR">Bear Market</option>
                    </optgroup>
                    <optgroup label="Jump">
                      <option value="JD10">Jump 10</option>
                      <option value="JD25">Jump 25</option>
                      <option value="JD50">Jump 50</option>
                      <option value="JD75">Jump 75</option>
                      <option value="JD100">Jump 100</option>
                    </optgroup>
                    <optgroup label="Step">
                      <option value="stpRNG">Step Index</option>
                      <option value="STP2">Step 200</option>
                      <option value="STP3">Step 300</option>
                      <option value="STP4">Step 400</option>
                      <option value="STP5">Step 500</option>
                    </optgroup>
                    <optgroup label="Range Break">
                      <option value="RDBR100">Range Break 100</option>
                      <option value="RDBR200">Range Break 200</option>
                    </optgroup>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Initial Capital ($)</Label>
                  <Input
                    type="number"
                    value={form.initialCapital}
                    onChange={e => setForm({...form, initialCapital: Number(e.target.value)})}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Risk Allocation</Label>
                  <Select
                    value={form.allocationMode}
                    onChange={e => setForm({...form, allocationMode: e.target.value as "conservative" | "balanced" | "aggressive"})}
                  >
                    <option value="conservative">Conservative</option>
                    <option value="balanced">Balanced</option>
                    <option value="aggressive">Aggressive</option>
                  </Select>
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  className="w-full mt-4"
                  isLoading={isPending}
                >
                  <Play className="w-4 h-4 mr-2" />
                  Execute Backtest
                </Button>
              </form>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="lg:col-span-2">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="w-4 h-4" />
                Recent Results
              </CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Strategy</th>
                    <th>Symbol</th>
                    <th className="text-right">Net Profit</th>
                    <th className="text-right">Win Rate</th>
                    <th className="text-right">Max DD</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">Loading...</td></tr>
                  ) : !results || results.length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">No backtests run yet.</td></tr>
                  ) : (
                    results.map((run) => (
                      <tr
                        key={run.id}
                        className={cn(
                          "cursor-pointer hover:bg-muted/30 transition-colors",
                          selectedRun?.id === run.id ? "bg-violet-500/10" : ""
                        )}
                        onClick={() => setSelectedRun(run)}
                      >
                        <td className="mono-num text-muted-foreground">#{run.id}</td>
                        <td className="font-medium">{run.strategyName}</td>
                        <td>{run.symbol}</td>
                        <td className={cn("text-right mono-num", run.netProfit && run.netProfit > 0 ? "profit" : run.netProfit && run.netProfit < 0 ? "loss" : "")}>
                          {formatCurrency(run.netProfit)}
                        </td>
                        <td className="text-right mono-num">{formatPercent(run.winRate)}</td>
                        <td className="text-right mono-num loss">{formatPercent(run.maxDrawdown)}</td>
                        <td>
                          <Badge variant={
                            run.status === 'failed' ? 'destructive' :
                            run.status === 'running' ? 'warning' : 'default'
                          }>
                            {run.status}
                          </Badge>
                        </td>
                        <td>
                          <button
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                            onClick={(e) => { e.stopPropagation(); setSelectedRun(run); }}
                          >
                            View Details
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {totalResults > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border/50">
                <p className="text-xs text-muted-foreground tabular-nums">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalResults)} of {totalResults}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage(p => p - 1)}
                    className="h-8 px-3 text-xs"
                  >
                    <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Prev
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Page {page + 1} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(p => p + 1)}
                    className="h-8 px-3 text-xs"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </motion.div>
      </div>

      <AnimatePresence>
        {selectedRun && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 z-40"
              onClick={() => setSelectedRun(null)}
            />
            <BacktestDetailPanel
              run={selectedRun}
              onClose={() => setSelectedRun(null)}
            />
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
