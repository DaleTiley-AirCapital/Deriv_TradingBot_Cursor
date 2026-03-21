import React, { useState, useMemo } from "react";
import { 
  useGetOpenTrades, 
  useGetTradeHistory, 
  useGetLivePositions,
  useToggleTradingMode,
  useStopTrading,
  getGetOpenTradesQueryKey,
  getGetTradeHistoryQueryKey,
  getGetLivePositionsQueryKey,
  useGetDataStatus,
  useGetOverview,
} from "@workspace/api-client-react";
import type { ToggleTradingModeRequestMode } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge, Button } from "@/components/ui-elements";
import { formatCurrency, formatNumber, cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Square, ArrowUpRight, ArrowDownRight, Clock, Target, ShieldAlert, TrendingUp, Filter } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function formatHours(hours: number): string {
  if (hours <= 0) return "0h";
  const d = Math.floor(hours / 24);
  const h = Math.floor(hours % 24);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h`;
}

const MODE_COLORS: Record<string, string> = {
  paper: "warning",
  demo: "primary",
  real: "destructive",
};

export default function Trades() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'positions' | 'history'>('positions');
  const [modeFilter, setModeFilter] = useState<string>("all");
  
  const { data: status } = useGetDataStatus({ query: { refetchInterval: 3000 } });
  const { data: overview } = useGetOverview({ query: { refetchInterval: 3000 } });
  const { data: positions } = useGetLivePositions({ query: { refetchInterval: 2000 } });
  const { data: openTrades, isLoading: openLoading } = useGetOpenTrades({ query: { refetchInterval: 3000 } });
  const { data: historyTrades, isLoading: historyLoading } = useGetTradeHistory({ query: { refetchInterval: 10000 } });

  const invalidator = {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetOpenTradesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTradeHistoryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLivePositionsQueryKey() });
    }
  };

  const { mutate: toggleMode, isPending: toggling } = useToggleTradingMode({ mutation: invalidator });
  const { mutate: stopTrades, isPending: stopping } = useStopTrading({ mutation: invalidator });

  const paperActive = overview?.paperModeActive ?? false;
  const demoActive = overview?.demoModeActive ?? false;
  const realActive = overview?.realModeActive ?? false;

  const filteredOpen = useMemo(() => {
    if (!openTrades) return [];
    if (modeFilter === "all") return openTrades;
    return openTrades.filter(t => t.mode === modeFilter);
  }, [openTrades, modeFilter]);

  const filteredHistory = useMemo(() => {
    if (!historyTrades) return [];
    if (modeFilter === "all") return historyTrades;
    return historyTrades.filter(t => t.mode === modeFilter);
  }, [historyTrades, modeFilter]);

  const filteredPositions = useMemo(() => {
    if (!positions) return [];
    if (modeFilter === "all") return positions;
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

  const isTrading = status?.mode === 'paper' || status?.mode === 'live' || status?.mode === 'demo' || status?.mode === 'real' || status?.mode === 'multi';
  const totalFloatingPnl = filteredPositions.reduce((sum, p) => sum + p.floatingPnl, 0);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Trades</h1>
          <p className="page-subtitle">Execution management and trade history</p>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 mr-2">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" />
            {["all", "paper", "demo", "real"].map(m => (
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
          {([
            { mode: "paper" as const, label: "Paper", active: paperActive, color: "warning" },
            { mode: "demo" as const,  label: "Demo",  active: demoActive,  color: "primary" },
            { mode: "real" as const,  label: "Real",  active: realActive,  color: "destructive" },
          ]).map(({ mode, label, active, color }) => (
            <Button
              key={mode}
              variant={active ? "default" : "outline"}
              className={cn(
                active
                  ? `bg-${color}/15 border-${color}/40 text-${color} hover:bg-${color}/25`
                  : `text-muted-foreground border-border hover:border-${color}/40 hover:text-${color}`
              )}
              style={active ? {
                backgroundColor: `hsl(var(--${color}) / 0.15)`,
                borderColor: `hsl(var(--${color}) / 0.4)`,
                color: `hsl(var(--${color}))`,
              } : undefined}
              onClick={() => toggleMode({ data: { mode: mode as ToggleTradingModeRequestMode, active: !active } })}
              isLoading={toggling}
            >
              {active ? <Square className="w-3 h-3" fill="currentColor" /> : <Play className="w-3 h-3" />}
              {label}
            </Button>
          ))}
          {isTrading && (
            <Button variant="destructive" onClick={() => stopTrades()} isLoading={stopping} className="ml-1">
              <Square className="w-3.5 h-3.5" fill="currentColor" />
              Stop All
            </Button>
          )}
        </div>
      </div>

      {filteredPositions.length > 0 && (
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
              {filteredPositions.map(p => (
                <div key={p.id} className="rounded-xl border border-border/60 p-4 bg-muted/15">
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
          </CardContent>
        </Card>
      )}

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
        <div className="flex border-b border-border/50">
          {(['positions', 'history'] as const).map(t => (
            <button
              key={t}
              className={cn(
                "px-5 py-3 text-sm font-medium tracking-wide transition-colors capitalize",
                tab === t
                  ? "text-primary border-b-2 border-primary bg-primary/5"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTab(t)}
            >
              {t === 'positions' ? `Open Positions (${openTrades?.length || 0})` : 'Trade History'}
            </button>
          ))}
        </div>
        
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th className="text-right">Size</th>
                <th className="text-right">Entry</th>
                {tab === 'history' && <th className="text-right">Exit</th>}
                <th className="text-right">SL</th>
                <th className="text-right">TP</th>
                <th className="text-right">P&L</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {tab === 'positions' ? (
                openLoading
                  ? <tr><td colSpan={10} className="text-center py-10 text-muted-foreground">Loading…</td></tr>
                  : !filteredOpen.length
                  ? <tr><td colSpan={10} className="text-center py-10 text-muted-foreground">No open trades{modeFilter !== "all" ? ` in ${modeFilter} mode` : ""}.</td></tr>
                  : filteredOpen.map(t => (
                    <tr key={t.id}>
                      <td className="mono-num text-muted-foreground">#{t.id}</td>
                      <td className="mono-num text-xs">{new Date(t.entryTs).toLocaleTimeString()}</td>
                      <td className="font-semibold text-foreground">{t.symbol}</td>
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
              ) : (
                historyLoading
                  ? <tr><td colSpan={11} className="text-center py-10 text-muted-foreground">Loading…</td></tr>
                  : !filteredHistory.length
                  ? <tr><td colSpan={11} className="text-center py-10 text-muted-foreground">No trade history{modeFilter !== "all" ? ` in ${modeFilter} mode` : ""}.</td></tr>
                  : filteredHistory.map(t => (
                    <tr key={t.id}>
                      <td className="mono-num text-muted-foreground">#{t.id}</td>
                      <td className="mono-num text-xs">{new Date(t.entryTs).toLocaleDateString()} {new Date(t.entryTs).toLocaleTimeString()}</td>
                      <td className="font-semibold text-foreground">{t.symbol}</td>
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
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
