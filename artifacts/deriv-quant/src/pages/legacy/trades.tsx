import React, { useState, useMemo } from "react";
import { 
  useGetOpenTrades, 
  useGetTradeHistory, 
  useGetLivePositions,
  useGetDataStatus,
  useStopTrading,
  getGetOpenTradesQueryKey,
  getGetTradeHistoryQueryKey,
  getGetLivePositionsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge, Button } from "@/components/ui-elements";
import { formatCurrency, formatNumber, cn } from "@/lib/utils";
import { downloadCSV, downloadJSON } from "@/lib/export";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ArrowDownRight, Clock, Target, ShieldAlert, TrendingUp, Filter, Square, Download, X, Layers } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function formatHours(hours: number): string {
  if (hours <= 0) return "0h";
  const d = Math.floor(hours / 24);
  const h = Math.floor(hours % 24);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h`;
}

const SYMBOLS = ["BOOM1000","BOOM900","BOOM600","BOOM500","BOOM300","CRASH1000","CRASH900","CRASH600","CRASH500","CRASH300","R_75","R_100"];
const SIDES = ["buy","sell"];
const STRATEGIES = ["trend_continuation","mean_reversion","spike_cluster_recovery","swing_exhaustion","trendline_breakout"];

function FilterSelect({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[] | string[];
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
    >
      <option value="">{placeholder}</option>
      {options.map(opt => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}

export default function Trades() {
  const queryClient = useQueryClient();
  const [modeFilter, setModeFilter] = useState<string>("paper");
  const [symbolFilter, setSymbolFilter] = useState("");
  const [sideFilter, setSideFilter] = useState("");
  const [strategyFilter, setStrategyFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  
  const { data: status } = useGetDataStatus({ query: { refetchInterval: 3000 } });
  const { data: positions } = useGetLivePositions({ query: { refetchInterval: 2000 } });
  const { data: openTrades, isLoading: openLoading } = useGetOpenTrades({ query: { refetchInterval: 3000 } });
  const { data: historyTrades, isLoading: historyLoading } = useGetTradeHistory({ query: { refetchInterval: 10000 } });

  const { mutate: stopTrades, isPending: stopping } = useStopTrading({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOpenTradesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTradeHistoryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetLivePositionsQueryKey() });
      }
    }
  });

  const isTrading = status?.mode === 'paper' || status?.mode === 'live' || status?.mode === 'demo' || status?.mode === 'real' || status?.mode === 'multi';

  const hasGridFilters = symbolFilter || sideFilter || strategyFilter || dateFrom || dateTo;

  function applyGridFilters<T extends { symbol: string; side: string; strategyName?: string; entryTs: string | Date; mode?: string }>(items: T[]): T[] {
    return items.filter(t => {
      if (t.mode !== modeFilter) return false;
      if (symbolFilter && t.symbol !== symbolFilter) return false;
      if (sideFilter && t.side !== sideFilter) return false;
      if (strategyFilter && t.strategyName !== strategyFilter) return false;
      if (dateFrom) {
        const d = new Date(t.entryTs);
        if (d < new Date(dateFrom)) return false;
      }
      if (dateTo) {
        const d = new Date(t.entryTs);
        const end = new Date(dateTo);
        end.setDate(end.getDate() + 1);
        if (d >= end) return false;
      }
      return true;
    });
  }

  const filteredOpen = useMemo(() => {
    if (!openTrades) return [];
    return applyGridFilters(openTrades as any[]);
  }, [openTrades, modeFilter, symbolFilter, sideFilter, strategyFilter, dateFrom, dateTo]);

  const filteredHistory = useMemo(() => {
    if (!historyTrades) return [];
    return applyGridFilters(historyTrades as any[]);
  }, [historyTrades, modeFilter, symbolFilter, sideFilter, strategyFilter, dateFrom, dateTo]);

  const filteredPositions = useMemo(() => {
    if (!positions) return [];
    return positions.filter(p => p.mode === modeFilter);
  }, [positions, modeFilter]);

  const chartData = useMemo(() => {
    if (!filteredHistory.length) return [];
    let cum = 0;
    return [...filteredHistory].reverse().map(t => {
      cum += (t.pnl || 0);
      return { time: new Date(t.exitTs || t.entryTs).toLocaleTimeString(), pnl: cum };
    });
  }, [filteredHistory]);

  const totalFloatingPnl = filteredPositions.reduce((sum, p) => sum + p.floatingPnl, 0);

  function clearGridFilters() {
    setSymbolFilter("");
    setSideFilter("");
    setStrategyFilter("");
    setDateFrom("");
    setDateTo("");
  }

  function exportOpenCSV() {
    downloadCSV(filteredOpen.map(t => ({
      id: t.id, time: new Date(t.entryTs).toISOString(), symbol: t.symbol, side: t.side,
      strategy: t.strategyName, size: t.size, entryPrice: t.entryPrice, sl: t.sl, tp: t.tp, pnl: t.pnl, mode: t.mode,
    })), `open_trades_${modeFilter}`);
  }

  function exportHistoryCSV() {
    downloadCSV(filteredHistory.map(t => ({
      id: t.id, entryTime: new Date(t.entryTs).toISOString(), exitTime: t.exitTs ? new Date(t.exitTs).toISOString() : "",
      symbol: t.symbol, side: t.side, strategy: t.strategyName, size: t.size,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice, sl: t.sl, tp: t.tp, pnl: t.pnl, mode: t.mode,
    })), `trade_history_${modeFilter}`);
  }

  function exportHistoryJSON() {
    downloadJSON(filteredHistory, `trade_history_${modeFilter}`);
  }

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border/30">
      <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <FilterSelect value={symbolFilter} onChange={setSymbolFilter} options={SYMBOLS} placeholder="Symbol" />
      <FilterSelect value={sideFilter} onChange={setSideFilter} options={SIDES} placeholder="Side" />
      <FilterSelect value={strategyFilter} onChange={setStrategyFilter} options={STRATEGIES} placeholder="Strategy" />
      <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
        className="bg-card border border-border/50 rounded-md px-2 py-1 text-xs text-foreground focus:border-primary/50 focus:outline-none"
        placeholder="From" />
      <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
        className="bg-card border border-border/50 rounded-md px-2 py-1 text-xs text-foreground focus:border-primary/50 focus:outline-none"
        placeholder="To" />
      {hasGridFilters && (
        <button onClick={clearGridFilters}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-3 h-3" /> Clear
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Trades</h1>
          <p className="page-subtitle">Execution management and trade history</p>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" />
            {["paper", "demo", "real"].map(m => (
              <button
                key={m}
                onClick={() => setModeFilter(m)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium uppercase tracking-wider transition-all border",
                  modeFilter === m
                    ? "bg-primary/10 border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {m}
              </button>
            ))}
          </div>
          {isTrading && (
            <Button variant="destructive" onClick={() => stopTrades()} isLoading={stopping}>
              <Square className="w-3.5 h-3.5" fill="currentColor" />
              Stop All
            </Button>
          )}
        </div>
      </div>

      {filteredPositions.length > 0 && (() => {
        const grouped = new Map<string, typeof filteredPositions>();
        for (const p of filteredPositions) {
          const existing = grouped.get(p.symbol) || [];
          existing.push(p);
          grouped.set(p.symbol, existing);
        }

        return (
          <Card className="border-primary/15">
            <CardHeader>
              <CardTitle>
                <TrendingUp className="w-4 h-4 text-primary" />
                Live Positions ({filteredPositions.length})
              </CardTitle>
              <div className={cn("text-base font-bold font-mono tabular-nums", totalFloatingPnl >= 0 ? "text-success" : "text-destructive")}>
                {totalFloatingPnl >= 0 ? "+" : ""}{formatCurrency(totalFloatingPnl)}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="grid gap-3 p-4">
                {Array.from(grouped.entries()).map(([symbol, positions]) => (
                  <div key={symbol}>
                    {positions.length > 1 && (
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <Layers className="w-3.5 h-3.5 text-primary" />
                        <span className="text-xs font-semibold text-primary">{symbol}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {positions.length} positions (pyramided)
                        </Badge>
                        <span className={cn("text-xs font-bold font-mono tabular-nums ml-auto", positions.reduce((s, p) => s + p.floatingPnl, 0) >= 0 ? "text-success" : "text-destructive")}>
                          {positions.reduce((s, p) => s + p.floatingPnl, 0) >= 0 ? "+" : ""}
                          {formatCurrency(positions.reduce((s, p) => s + p.floatingPnl, 0))}
                        </span>
                      </div>
                    )}
                    {positions.map(p => (
                      <div key={p.id} className={cn("rounded-xl border border-border/60 p-4 bg-muted/15", positions.length > 1 ? "ml-4 mb-2" : "")}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2.5">
                            <Badge variant={p.side === 'buy' ? 'success' : 'destructive'}>
                              {p.side === 'buy' ? <ArrowUpRight className="w-3 h-3"/> : <ArrowDownRight className="w-3 h-3"/>}
                              {p.side}
                            </Badge>
                            <span className="font-semibold text-foreground">{p.symbol}</span>
                            <span className="text-xs text-muted-foreground">{p.strategyName}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className={cn("text-base font-bold font-mono tabular-nums", p.floatingPnl >= 0 ? "text-success" : "text-destructive")}>
                              {p.floatingPnl >= 0 ? "+" : ""}{formatCurrency(p.floatingPnl)}
                              <span className="text-xs font-normal ml-1 opacity-80">
                                ({p.floatingPnlPct >= 0 ? "+" : ""}{p.floatingPnlPct.toFixed(2)}%)
                              </span>
                            </div>
                            <Badge variant="outline">{p.mode}</Badge>
                          </div>
                        </div>

                        <div className="grid grid-cols-3 md:grid-cols-6 gap-4 text-xs">
                          {[
                            { label: "Entry", value: formatNumber(p.entryPrice, 4) },
                            { label: "Current", value: formatNumber(p.currentPrice, 4), colorClass: p.currentPrice > p.entryPrice ? "text-success" : p.currentPrice < p.entryPrice ? "text-destructive" : "" },
                            { label: "SL", value: formatNumber(p.sl, 4), colorClass: "text-destructive", icon: <ShieldAlert className="w-3 h-3 text-destructive" /> },
                            { label: "TP", value: formatNumber(p.tp, 4), colorClass: "text-success", icon: <Target className="w-3 h-3 text-success" /> },
                            { label: "Size", value: formatCurrency(p.size) },
                            { label: "Time Left", value: formatHours(p.hoursRemaining), colorClass: p.hoursRemaining < 12 ? "text-warning" : "", icon: <Clock className="w-3 h-3 text-warning" /> },
                          ].map(({ label, value, colorClass, icon }) => (
                            <div key={label}>
                              <span className="text-muted-foreground block mb-0.5 flex items-center gap-1">
                                {icon}{label}
                              </span>
                              <span className={cn("font-mono font-semibold tabular-nums", colorClass)}>{value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      <Card>
        <CardHeader>
          <CardTitle>Cumulative P&L</CardTitle>
        </CardHeader>
        <CardContent className="h-[220px] p-0 px-1">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(213 90% 62%)" stopOpacity={0.25}/>
                    <stop offset="95%" stopColor="hsl(213 90% 62%)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 13% 15%)" vertical={false} />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(220 16% 9%)', 
                    borderColor: 'hsl(220 13% 15%)', 
                    borderRadius: '8px',
                    fontSize: '12px'
                  }}
                  itemStyle={{ color: 'hsl(220 15% 92%)', fontFamily: 'monospace' }}
                  formatter={(val: number) => [formatCurrency(val), 'Cumulative P&L']}
                />
                <Area type="monotone" dataKey="pnl" stroke="hsl(213 90% 62%)" strokeWidth={1.5} fillOpacity={1} fill="url(#colorPnl)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              No trade data yet
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Open Positions ({filteredOpen.length})
          </CardTitle>
          <div className="flex items-center gap-2">
            <button onClick={exportOpenCSV} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors">
              <Download className="w-3 h-3" /> CSV
            </button>
          </div>
        </CardHeader>
        {filterBar}
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Time</th>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Side</th>
                <th className="text-right">Size</th>
                <th className="text-right">Entry</th>
                <th className="text-right">SL</th>
                <th className="text-right">TP</th>
                <th className="text-right">P&L</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {openLoading
                ? <tr><td colSpan={11} className="text-center py-10 text-muted-foreground">Loading…</td></tr>
                : !filteredOpen.length
                ? <tr><td colSpan={11} className="text-center py-10 text-muted-foreground">No open trades{modeFilter !== "all" ? ` in ${modeFilter} mode` : ""}.</td></tr>
                : filteredOpen.map(t => (
                  <tr key={t.id}>
                    <td className="mono-num text-muted-foreground">#{t.id}</td>
                    <td className="mono-num text-xs">{new Date(t.entryTs).toLocaleTimeString()}</td>
                    <td className="font-semibold text-foreground">{t.symbol}</td>
                    <td className="text-xs text-muted-foreground">{t.strategyName}</td>
                    <td>
                      <Badge variant={t.side === 'buy' ? 'success' : 'destructive'}>
                        {t.side === 'buy' ? <ArrowUpRight className="w-3 h-3"/> : <ArrowDownRight className="w-3 h-3"/>}
                        {t.side}
                      </Badge>
                    </td>
                    <td className="text-right mono-num">{formatNumber(t.size, 2)}</td>
                    <td className="text-right mono-num">{formatNumber(t.entryPrice, 3)}</td>
                    <td className="text-right mono-num text-destructive">{formatNumber(t.sl, 4)}</td>
                    <td className="text-right mono-num text-success">{formatNumber(t.tp, 4)}</td>
                    <td className="text-right mono-num">
                      <span className={cn(t.pnl && t.pnl > 0 ? "text-success" : t.pnl && t.pnl < 0 ? "text-destructive" : "")}>
                        {formatCurrency(t.pnl)}
                      </span>
                    </td>
                    <td><Badge variant="outline">{t.mode}</Badge></td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Trade History ({filteredHistory.length})
          </CardTitle>
          <div className="flex items-center gap-2">
            <button onClick={exportHistoryCSV} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors">
              <Download className="w-3 h-3" /> CSV
            </button>
            <button onClick={exportHistoryJSON} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors">
              <Download className="w-3 h-3" /> JSON
            </button>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Time</th>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Side</th>
                <th className="text-right">Size</th>
                <th className="text-right">Entry</th>
                <th className="text-right">Exit</th>
                <th className="text-right">SL</th>
                <th className="text-right">TP</th>
                <th className="text-right">P&L</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {historyLoading
                ? <tr><td colSpan={12} className="text-center py-10 text-muted-foreground">Loading…</td></tr>
                : !filteredHistory.length
                ? <tr><td colSpan={12} className="text-center py-10 text-muted-foreground">No trade history{modeFilter !== "all" ? ` in ${modeFilter} mode` : ""}.</td></tr>
                : filteredHistory.map(t => (
                  <tr key={t.id}>
                    <td className="mono-num text-muted-foreground">#{t.id}</td>
                    <td className="mono-num text-xs">{new Date(t.entryTs).toLocaleDateString()} {new Date(t.entryTs).toLocaleTimeString()}</td>
                    <td className="font-semibold text-foreground">{t.symbol}</td>
                    <td className="text-xs text-muted-foreground">{t.strategyName}</td>
                    <td>
                      <Badge variant={t.side === 'buy' ? 'success' : 'destructive'}>
                        {t.side === 'buy' ? <ArrowUpRight className="w-3 h-3"/> : <ArrowDownRight className="w-3 h-3"/>}
                        {t.side}
                      </Badge>
                    </td>
                    <td className="text-right mono-num">{formatNumber(t.size, 2)}</td>
                    <td className="text-right mono-num text-muted-foreground">{formatNumber(t.entryPrice, 3)}</td>
                    <td className="text-right mono-num">{formatNumber(t.exitPrice, 3)}</td>
                    <td className="text-right mono-num text-destructive">{formatNumber(t.sl, 4)}</td>
                    <td className="text-right mono-num text-success">{formatNumber(t.tp, 4)}</td>
                    <td className="text-right mono-num">
                      <span className={cn(t.pnl && t.pnl > 0 ? "text-success" : t.pnl && t.pnl < 0 ? "text-destructive" : "")}>
                        {formatCurrency(t.pnl)}
                      </span>
                    </td>
                    <td><Badge variant="outline">{t.mode}</Badge></td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
