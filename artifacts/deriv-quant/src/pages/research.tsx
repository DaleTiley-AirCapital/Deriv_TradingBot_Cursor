import React, { useState } from "react";
import { useGetBacktestResults, useRunBacktest, useAnalyseBacktest, getGetBacktestResultsQueryKey } from "@workspace/api-client-react";
import type { BacktestAnalysis } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Input, Label, Select } from "@/components/ui-elements";
import { formatCurrency, formatNumber, formatPercent, cn } from "@/lib/utils";
import { Play, Search, Beaker, Brain, Lightbulb, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";

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

export default function Research() {
  const queryClient = useQueryClient();
  const { data: results, isLoading } = useGetBacktestResults();
  
  const { mutate: runBacktest, isPending } = useRunBacktest({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBacktestResultsQueryKey() });
      }
    }
  });

  const { mutate: analyseBacktest, isPending: analysing } = useAnalyseBacktest();

  const STRATEGY_INFO: Record<string, { label: string; description: string }> = {
    "trend-pullback": {
      label: "Trend Pullback",
      description: "Identifies a strong prevailing trend, then waits for a short counter-move (pullback) before entering in the trend direction. Works best on Boom/Crash indices during sustained directional runs.",
    },
    "exhaustion-rebound": {
      label: "Exhaustion Rebound",
      description: "Detects when price has moved too far, too fast — using RSI extremes and momentum divergence — and bets on a mean-reversion snap-back. Suited for Volatility indices and rangy Boom/Crash phases.",
    },
    "volatility-breakout": {
      label: "Volatility Breakout",
      description: "Monitors Bollinger Band width compression (low volatility squeezes), then enters the first large expansion candle in the breakout direction. Effective on all synthetic indices during consolidation periods.",
    },
    "spike-hazard": {
      label: "Spike Hazard",
      description: "Estimates the probability of an imminent spike on Boom or Crash indices using tick-rate analysis and inter-spike timing models. Positions are sized conservatively given the high uncertainty of spike timing.",
    },
  };

  const [form, setForm] = useState({
    strategyName: "trend-pullback",
    symbol: "BOOM1000",
    initialCapital: 10000,
    allocationMode: "balanced" as "conservative" | "balanced" | "aggressive"
  });

  const [analysingId, setAnalysingId] = useState<number | null>(null);
  const [analysisResults, setAnalysisResults] = useState<Record<number, BacktestAnalysis>>({});
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const handleAnalyse = (id: number) => {
    setAnalysingId(id);
    setAnalysisError(null);
    analyseBacktest(
      { id },
      {
        onSuccess: (data) => {
          setAnalysisResults(prev => ({ ...prev, [id]: data }));
          setAnalysingId(null);
        },
        onError: (err: unknown) => {
          const error = err as { data?: { error?: string }; message?: string };
          setAnalysisError(error?.data?.error || error?.message || "AI analysis failed. Check your OpenAI API key in Settings.");
          setAnalysingId(null);
        },
      }
    );
  };

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
                    <option value="trend-pullback">Trend Pullback</option>
                    <option value="exhaustion-rebound">Exhaustion Rebound</option>
                    <option value="volatility-breakout">Volatility Breakout</option>
                    <option value="spike-hazard">Spike Hazard</option>
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
                    <option value="BOOM1000">BOOM1000</option>
                    <option value="CRASH1000">CRASH1000</option>
                    <option value="BOOM500">BOOM500</option>
                    <option value="CRASH500">CRASH500</option>
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
                    <th>AI</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">Loading...</td></tr>
                  ) : results?.length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">No backtests run yet.</td></tr>
                  ) : (
                    results?.map((run) => (
                      <React.Fragment key={run.id}>
                        <tr>
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
                            {run.status === 'completed' && (
                              analysisResults[run.id] ? (
                                <button
                                  onClick={() => {
                                    const copy = { ...analysisResults };
                                    delete copy[run.id];
                                    setAnalysisResults(copy);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-violet-500/20 text-violet-400 border border-violet-500/30"
                                >
                                  <Brain className="w-3 h-3" />
                                  Hide
                                </button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  className="text-xs px-2 py-1 h-auto"
                                  onClick={() => handleAnalyse(run.id)}
                                  isLoading={analysingId === run.id}
                                >
                                  <Brain className="w-3 h-3 mr-1" />
                                  Analyse
                                </Button>
                              )
                            )}
                          </td>
                        </tr>
                        {analysisResults[run.id] && (
                          <tr>
                            <td colSpan={8} className="p-2">
                              <AIAnalysisPanel
                                analysis={analysisResults[run.id]}
                                onClose={() => {
                                  const copy = { ...analysisResults };
                                  delete copy[run.id];
                                  setAnalysisResults(copy);
                                }}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))
                  )}
                </tbody>
              </table>
              {analysisError && (
                <div className="p-4 text-sm text-red-400 bg-red-500/10 border-t border-red-500/20">
                  {analysisError}
                </div>
              )}
            </div>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
