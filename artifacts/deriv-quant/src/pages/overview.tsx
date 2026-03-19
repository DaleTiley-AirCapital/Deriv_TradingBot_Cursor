import React from "react";
import { useGetOverview, useGetPortfolioStatus, useGetAccountInfo, useGetLivePositions, useGetSettings } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, KpiCard, Badge, InfoTooltip } from "@/components/ui-elements";
import { cn, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { AlertTriangle, TrendingUp, Target, Activity, Wallet, ArrowUpDown, Layers, ShieldAlert, Settings } from "lucide-react";
import { motion } from "framer-motion";

const STRATEGY_DESCRIPTIONS = [
  { name: "Trend Pullback", desc: "Enters on dips within a confirmed strong trend" },
  { name: "Exhaustion Rebound", desc: "Catches reversals after overstretched moves" },
  { name: "Volatility Breakout", desc: "Trades Bollinger Band compressions expanding" },
  { name: "Spike Hazard", desc: "Elevated boom/crash spike probability detection" },
];

const DEFAULT_CAPITAL = 10000;

export default function Overview() {
  const { data: overview, isLoading: overviewLoading } = useGetOverview({ query: { refetchInterval: 5000 } });
  const { data: portfolio, isLoading: portfolioLoading } = useGetPortfolioStatus({ query: { refetchInterval: 5000 } });
  const { data: accountInfo } = useGetAccountInfo({ query: { refetchInterval: 30000 } });
  const { data: positions } = useGetLivePositions({ query: { refetchInterval: 10000 } });
  const { data: settings } = useGetSettings({ query: { staleTime: 60000 } });

  if (overviewLoading || portfolioLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading dashboard…</span>
        </div>
      </div>
    );
  }

  const pnlTrend = (overview?.realisedPnl || 0) >= 0 ? "up" : "down";
  const isLive = overview?.mode === "live";
  const isPaper = overview?.mode === "paper";
  const isDefaultCapital = !settings?.total_capital || Number(settings.total_capital) === DEFAULT_CAPITAL;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            Last sync: {overview?.lastDataSyncAt ? new Date(overview.lastDataSyncAt).toLocaleTimeString() : 'Never'}
          </p>
        </div>
        {overview?.killSwitchActive && (
          <div className="flex items-center gap-2 bg-destructive/10 text-destructive px-4 py-2 rounded-lg border border-destructive/20 animate-pulse">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-semibold text-sm">Kill Switch Active</span>
          </div>
        )}
      </div>

      {isDefaultCapital && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/8 border border-primary/25 text-sm">
            <Settings className="w-4 h-4 text-primary shrink-0" />
            <span className="text-foreground">
              <span className="font-semibold">Set your capital:</span>{" "}
              <span className="text-muted-foreground">
                "Available Capital" is using the default ($10,000). Go to{" "}
                <a href="/settings" className="text-primary underline underline-offset-2 hover:text-primary/80">Settings → Position Sizing → Total Capital</a>{" "}
                and enter the amount you plan to deposit (e.g. $600).
              </span>
            </span>
          </div>
        </motion.div>
      )}

      {accountInfo?.connected && accountInfo.balance != null && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <Card className={cn(
            "border",
            isLive ? "border-destructive/30" : isPaper ? "border-warning/30" : "border-primary/20"
          )}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center",
                    isLive ? "bg-destructive/12 text-destructive" : isPaper ? "bg-warning/12 text-warning" : "bg-primary/12 text-primary"
                  )}>
                    <Wallet className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">
                      Deriv Account {accountInfo.loginid ? `· ${accountInfo.loginid}` : ""}
                    </p>
                    <p className="text-2xl font-bold font-mono tabular-nums text-foreground mt-0.5">
                      {accountInfo.currency} {accountInfo.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                </div>
                <div className="text-right flex flex-col items-end gap-1">
                  <Badge variant={isLive ? "destructive" : isPaper ? "warning" : "outline"}>
                    {overview?.mode?.toUpperCase() || "IDLE"}
                  </Badge>
                  {accountInfo.account_type && (
                    <p className="text-xs text-muted-foreground capitalize">{accountInfo.account_type}</p>
                  )}
                </div>
              </div>
              {(accountInfo.equity != null || accountInfo.margin != null) && (
                <div className="grid grid-cols-4 gap-4 mt-4 pt-4 border-t border-border/40">
                  {[
                    { label: "Equity", value: accountInfo.equity },
                    { label: "Margin", value: accountInfo.margin },
                    { label: "Free Margin", value: accountInfo.free_margin },
                    { label: "Margin Level", value: accountInfo.margin_level_pct != null ? `${accountInfo.margin_level_pct.toFixed(1)}%` : null, raw: true },
                  ].map(({ label, value, raw }) => (
                    <div key={label}>
                      <p className="section-label mb-1">{label}</p>
                      <p className="text-sm font-semibold font-mono tabular-nums">
                        {raw ? (value ?? "—") : (typeof value === "number" ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—")}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}

      {!accountInfo?.connected && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border border-warning/25">
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-warning/10 text-warning rounded-lg flex items-center justify-center">
                  <Wallet className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Deriv Account Not Connected</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {accountInfo?.error || "Set your Deriv API token in Settings to see live account data"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <KpiCard
            label="Available Capital"
            value={formatCurrency(overview?.availableCapital)}
            accentColor="blue"
            icon={<Wallet className="w-4 h-4" />}
            tooltip={
              <>
                Your configured total capital (Settings → Position Sizing → Total Capital) minus capital currently tied up in open trades.
                <br /><br />
                <span className="text-primary font-medium">Tip:</span> Set Total Capital to your deposit amount (e.g. $600).
              </>
            }
            detail={
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Allocation Mode</span>
                <Badge variant="outline">{portfolio?.allocationMode || 'N/A'}</Badge>
              </div>
            }
          />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <KpiCard
            label="Realised P&L"
            prefix="$"
            value={formatNumber(overview?.realisedPnl, 2)}
            trend={pnlTrend}
            accentColor={pnlTrend === "up" ? "green" : "red"}
            icon={<TrendingUp className="w-4 h-4" />}
            tooltip="Total profit and loss from all closed paper or live trades since the platform started. Negative means cumulative losses. This resets if the database is cleared."
            detail={
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Win Rate</span>
                <span className="font-mono tabular-nums text-foreground">{formatNumber(overview?.winRate, 1)}%</span>
              </div>
            }
          />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <KpiCard
            label="Open Risk"
            suffix="%"
            value={formatNumber(overview?.openRisk, 2)}
            trend={overview?.openRisk && overview.openRisk > 5 ? "down" : "neutral"}
            accentColor="amber"
            icon={<ShieldAlert className="w-4 h-4" />}
            tooltip="Estimated exposure from all currently open positions as a percentage of total capital. Below 5% is comfortable; above 10% is elevated risk. The risk engine will block new trades if limits are breached."
            detail={
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Open Positions</span>
                <span className="font-mono tabular-nums text-foreground">{overview?.openPositions || 0}</span>
              </div>
            }
          />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <KpiCard
            label="Active Strategies"
            value={overview?.activeStrategies || 0}
            accentColor="purple"
            icon={<Layers className="w-4 h-4" />}
            tooltip={
              <>
                The 4 built-in signal families continuously scanning tick data:
                <ul className="mt-1.5 space-y-1 list-none">
                  {STRATEGY_DESCRIPTIONS.map(s => (
                    <li key={s.name}><span className="text-foreground font-medium">{s.name}</span> — {s.desc}</li>
                  ))}
                </ul>
              </>
            }
            detail={
              <div className="space-y-1.5">
                {STRATEGY_DESCRIPTIONS.map(s => (
                  <div key={s.name} className="flex items-center gap-1.5">
                    <div className="w-1 h-1 rounded-full bg-purple-400 shrink-0" />
                    <span className="text-muted-foreground truncate">{s.name}</span>
                  </div>
                ))}
              </div>
            }
          />
        </motion.div>
      </div>

      {positions && positions.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
          <Card>
            <CardHeader>
              <CardTitle>
                <ArrowUpDown className="w-4 h-4 text-primary" />
                Live Positions
              </CardTitle>
              <span className="text-xs text-muted-foreground">{positions.length} open</span>
            </CardHeader>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th className="text-right">Entry</th>
                    <th className="text-right">Current</th>
                    <th className="text-right">SL</th>
                    <th className="text-right">TP</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Float P&L</th>
                    <th className="text-right">Hrs Left</th>
                    <th className="text-center">Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id}>
                      <td className="font-semibold text-foreground">{p.symbol}</td>
                      <td>
                        <Badge variant={p.side === "buy" ? "success" : "destructive"}>
                          {p.side}
                        </Badge>
                      </td>
                      <td className="text-right mono-num">{formatNumber(p.entryPrice, 2)}</td>
                      <td className="text-right mono-num">{formatNumber(p.currentPrice, 2)}</td>
                      <td className="text-right mono-num text-destructive">{formatNumber(p.sl, 2)}</td>
                      <td className="text-right mono-num text-success">{formatNumber(p.tp, 2)}</td>
                      <td className="text-right mono-num">${formatNumber(p.size, 0)}</td>
                      <td className={cn(
                        "text-right mono-num font-medium",
                        p.floatingPnl > 0 ? "text-success" : p.floatingPnl < 0 ? "text-destructive" : ""
                      )}>
                        {p.floatingPnl > 0 ? "+" : ""}{formatNumber(p.floatingPnl, 2)} ({formatNumber(p.floatingPnlPct, 1)}%)
                      </td>
                      <td className="text-right mono-num">{p.hoursRemaining}h</td>
                      <td className="text-center">
                        <Badge variant={p.mode === "live" ? "destructive" : "warning"}>
                          {p.mode}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle>
                <Activity className="w-4 h-4 text-primary" />
                Portfolio Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-0">
                {[
                  { label: "Account Balance", value: formatCurrency(accountInfo?.balance ?? portfolio?.totalCapital), tooltip: "Your current Deriv account balance. In paper mode this reflects the virtual account." },
                  { label: "Unrealised P&L", value: formatCurrency(portfolio?.unrealisedPnl), trend: portfolio?.unrealisedPnl, tooltip: "Floating profit or loss across all currently open positions. Not yet locked in." },
                  { label: "Daily P&L", value: formatCurrency(portfolio?.dailyPnl), trend: portfolio?.dailyPnl, tooltip: "Net profit and loss from all trades opened and closed today (UTC day)." },
                  { label: "Drawdown", value: formatPercent(portfolio?.drawdownPct), negative: true, tooltip: "Peak-to-trough decline from your highest balance. The risk engine triggers if this exceeds your max drawdown limit." },
                ].map(({ label, value, trend, negative, tooltip }) => (
                  <div key={label} className="flex justify-between items-center py-3 border-b border-border/40 last:border-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-muted-foreground">{label}</span>
                      {tooltip && <InfoTooltip content={tooltip} />}
                    </div>
                    <span className={cn(
                      "text-sm font-medium font-mono tabular-nums",
                      trend != null && trend > 0 && "text-success",
                      trend != null && trend < 0 && "text-destructive",
                      negative && "text-destructive"
                    )}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
              {portfolio?.suggestWithdrawal && (
                <div className="mt-4 p-3 bg-success/8 border border-success/25 rounded-lg text-success flex items-center justify-between">
                  <span className="text-sm">Withdrawal Target Reached</span>
                  <Badge variant="success">Suggested</Badge>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle>
                <Target className="w-4 h-4 text-primary" />
                Operational Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-5">
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Total Trades</span>
                    <span className="text-sm font-mono font-semibold tabular-nums">{overview?.totalTrades || 0}</span>
                  </div>
                  <div className="w-full bg-muted/40 rounded-full h-1.5">
                    <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${Math.min(((overview?.totalTrades || 0) / 1000) * 100, 100)}%` }} />
                  </div>
                </div>
                
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Win Rate</span>
                    <span className="text-sm font-mono font-semibold tabular-nums">{formatNumber(overview?.winRate, 1)}%</span>
                  </div>
                  <div className="w-full bg-muted/40 rounded-full h-1.5">
                    <div className="bg-success h-1.5 rounded-full transition-all" style={{ width: `${overview?.winRate || 0}%` }} />
                  </div>
                </div>

                <div className="pt-4 border-t border-border/40">
                  <p className="section-label mb-3">System Checks</p>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Data Stream</span>
                      {overview?.mode !== 'idle'
                        ? <Badge variant="success">Online</Badge>
                        : <Badge variant="outline">Offline</Badge>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Risk Engine</span>
                      {overview?.killSwitchActive
                        ? <Badge variant="destructive">Blocked</Badge>
                        : <Badge variant="success">Active</Badge>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Deriv API</span>
                      {accountInfo?.connected
                        ? <Badge variant="success">Connected</Badge>
                        : <Badge variant="outline">Disconnected</Badge>}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
