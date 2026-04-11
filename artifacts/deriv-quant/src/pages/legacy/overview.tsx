import React, { useState } from "react";
import {
  useGetOverview,
  useGetPortfolioStatus,
  useGetAccountInfo,
  useGetLivePositions,
  useGetSettings,
  useGetLatestSignals,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, KpiCard, Badge, InfoTooltip } from "@/components/ui-elements";
import { cn, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import {
  AlertTriangle, TrendingUp, Target, Activity,
  Wallet, ArrowUpDown, Layers, ShieldAlert,
  Settings, Zap,
} from "lucide-react";
import { motion } from "framer-motion";

const STRATEGY_DESCRIPTIONS = [
  { name: "Boom Expansion",        desc: "BOOM300 — spike-surge entries with multi-window confirmation" },
  { name: "Crash Expansion",       desc: "CRASH300 — spike-drop entries with multi-window confirmation" },
  { name: "R75 Continuation",      desc: "Volatility 75 — high-momentum trend following" },
  { name: "R75 Reversal",          desc: "Volatility 75 — mean reversion at exhaustion extremes" },
  { name: "R75 Breakout",          desc: "Volatility 75 — ATR-surge range expansion" },
  { name: "R100 Continuation",     desc: "Volatility 100 — high-momentum trend following" },
  { name: "R100 Reversal",         desc: "Volatility 100 — mean reversion at exhaustion extremes" },
  { name: "R100 Breakout",         desc: "Volatility 100 — ATR-surge range expansion" },
];

const FAMILY_LABELS: Record<string, string> = {
  boom_expansion_engine: "Boom Expansion",
  crash_expansion_engine: "Crash Expansion",
  r75_continuation_engine: "R75 Continuation",
  r75_reversal_engine: "R75 Reversal",
  r75_breakout_engine: "R75 Breakout",
  r100_continuation_engine: "R100 Continuation",
  r100_reversal_engine: "R100 Reversal",
  r100_breakout_engine: "R100 Breakout",
  v3_engine: "V3 Engine",
};

export default function Overview() {
  const queryOpts = { refetchInterval: 5000, retry: 2, retryDelay: 1000, staleTime: 10000 };
  const { data: overview } = useGetOverview({ query: queryOpts });
  const { data: portfolio } = useGetPortfolioStatus({ query: queryOpts });
  const { data: accountInfo } = useGetAccountInfo({ query: { refetchInterval: 30000, retry: 2, staleTime: 30000 } });
  const { data: positions } = useGetLivePositions({ query: { refetchInterval: 10000, retry: 1, staleTime: 10000 } });
  const { data: settings } = useGetSettings({ query: { staleTime: 60000 } });
  const { data: signalsData } = useGetLatestSignals(undefined, { query: { refetchInterval: 15000, retry: 1, staleTime: 15000 } });
  const signals = signalsData?.signals;
  const [kpiMode, setKpiMode] = useState<string>("paper");

  const pnlTrend        = (overview?.realisedPnl || 0) >= 0 ? "up" : "down";
  const isLive          = overview?.mode === "live" || overview?.mode === "real";
  const isPaper         = overview?.mode === "paper";
  const isDemo          = overview?.mode === "demo";
  const isMulti         = overview?.mode === "multi";
  const activeModes     = overview?.activeModes || [];
  const perMode         = overview?.perMode || {};
  const kpiSnap = perMode[kpiMode];
  const kpiCapital    = kpiSnap?.capital    ?? overview?.availableCapital;
  const kpiPnl        = kpiSnap?.realisedPnl ?? overview?.realisedPnl;
  const kpiPnlTrend   = (kpiPnl || 0) >= 0 ? "up" as const : "down" as const;
  const kpiPositions  = kpiSnap?.openPositions ?? overview?.openPositions;
  const kpiWinRate    = kpiSnap?.winRate     ?? overview?.winRate;
  const kpiStrategies = overview?.activeStrategies;

  const accountConnected = accountInfo?.connected && accountInfo.balance != null;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            Last sync: {overview?.lastDataSyncAt
              ? new Date(overview.lastDataSyncAt).toLocaleTimeString()
              : "Never"}
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {overview?.killSwitchActive && (
            <div className="flex items-center gap-2 bg-destructive/10 text-destructive px-3 py-2 rounded-lg border border-destructive/20 animate-pulse">
              <AlertTriangle className="w-4 h-4" />
              <span className="font-semibold text-sm">Kill Switch Active</span>
            </div>
          )}

          {/* Account chips — desktop only, inline in header */}
          {(() => {
            const demoAcct = (accountInfo as any)?.demo;
            const realAcct = (accountInfo as any)?.real;
            const hasDemoData = demoAcct?.connected && demoAcct.balance != null;
            const hasRealData = realAcct?.connected && realAcct.balance != null;
            if (!hasDemoData && !hasRealData) return null;
            const fmtBal = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return (
              <div className="hidden lg:flex items-center gap-2">
                {hasDemoData && (
                  <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-primary/25 bg-primary/5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/15 text-primary shrink-0">
                      <Wallet className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground uppercase tracking-widest">
                        {demoAcct.loginid || "Demo"} · VIRTUAL
                      </p>
                      <p className="text-sm font-bold font-mono tabular-nums text-foreground mt-0.5">
                        {demoAcct.currency} {fmtBal(demoAcct.balance)}
                      </p>
                    </div>
                    <div className="flex gap-3 pl-2 border-l border-border/40">
                      {[
                        { label: "Equity", value: demoAcct.equity },
                        { label: "Free Margin", value: demoAcct.free_margin },
                      ].map(({ label, value }) => (
                        <div key={label} className="text-right">
                          <p className="text-[8px] text-muted-foreground uppercase tracking-widest">{label}</p>
                          <p className="text-[11px] font-semibold font-mono tabular-nums text-foreground mt-0.5">
                            {typeof value === "number" ? fmtBal(value) : "—"}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {hasRealData && (
                  <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-destructive/25 bg-destructive/5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-destructive/15 text-destructive shrink-0">
                      <Wallet className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground uppercase tracking-widest">
                        {realAcct.loginid || "Real"} · REAL
                      </p>
                      <p className="text-sm font-bold font-mono tabular-nums text-foreground mt-0.5">
                        {realAcct.currency} {fmtBal(realAcct.balance)}
                      </p>
                    </div>
                    <div className="flex gap-3 pl-2 border-l border-border/40">
                      {[
                        { label: "Equity", value: realAcct.equity },
                        { label: "Free Margin", value: realAcct.free_margin },
                      ].map(({ label, value }) => (
                        <div key={label} className="text-right">
                          <p className="text-[8px] text-muted-foreground uppercase tracking-widest">{label}</p>
                          <p className="text-[11px] font-semibold font-mono tabular-nums text-foreground mt-0.5">
                            {typeof value === "number" ? fmtBal(value) : "—"}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Dual account cards — Demo & Real side by side */}
      {(() => {
        const demoAcct = (accountInfo as any)?.demo;
        const realAcct = (accountInfo as any)?.real;
        const hasDemoData = demoAcct?.connected && demoAcct.balance != null;
        const hasRealData = realAcct?.connected && realAcct.balance != null;
        const fmtBal = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        if (!hasDemoData && !hasRealData) {
          return (
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
              <Card className="border border-warning/25">
                <CardContent className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-warning/10 text-warning rounded-lg flex items-center justify-center">
                      <Wallet className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Deriv Accounts Not Connected</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {accountInfo?.error || "Set your Deriv API tokens in Settings to see live account data"}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        }

        const renderCard = (acct: any, label: string, color: "primary" | "destructive") => {
          const borderCls = color === "destructive" ? "border-destructive/25" : "border-primary/25";
          const iconCls = color === "destructive" ? "bg-destructive/12 text-destructive" : "bg-primary/12 text-primary";
          return (
            <Card className={cn("border flex-1 min-w-0", borderCls)}>
              <CardContent className="p-5">
                <div className="flex items-center gap-3">
                  <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", iconCls)}>
                    <Wallet className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground font-medium">
                      {acct.loginid || label} · {label.toUpperCase()}
                    </p>
                    <p className="text-xl font-bold font-mono tabular-nums text-foreground mt-0.5">
                      {acct.currency} {fmtBal(acct.balance)}
                    </p>
                  </div>
                </div>
                {(acct.equity != null || acct.margin != null) && (
                  <div className="grid grid-cols-4 gap-3 mt-3 pt-3 border-t border-border/40">
                    {[
                      { label: "Equity", value: acct.equity },
                      { label: "Margin", value: acct.margin },
                      { label: "Free Margin", value: acct.free_margin },
                      { label: "Margin Lvl", value: acct.margin_level_pct != null ? `${acct.margin_level_pct.toFixed(1)}%` : null, raw: true },
                    ].map(({ label: l, value: v, raw }) => (
                      <div key={l}>
                        <p className="section-label mb-1">{l}</p>
                        <p className="text-xs font-semibold font-mono tabular-nums">
                          {raw ? (v ?? "—") : (typeof v === "number" ? fmtBal(v) : "—")}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        };

        return (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {hasDemoData && renderCard(demoAcct, "Demo", "primary")}
            {hasRealData && renderCard(realAcct, "Real", "destructive")}
          </motion.div>
        );
      })()}

      {/* ── KPI Row (4-col) ──────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-1">View:</span>
          {["paper", "demo", "real"].map(m => (
            <button
              key={m}
              onClick={() => setKpiMode(m)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium uppercase tracking-wider transition-all border",
                kpiMode === m
                  ? "bg-primary/10 border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <KpiCard
              label="Available Capital"
              value={formatCurrency(kpiCapital)}
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
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Allocation Mode</span>
                    <Badge variant="outline">{portfolio?.allocationMode || "N/A"}</Badge>
                  </div>
                  {portfolio?.totalCapital && portfolio.totalCapital > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Capital Deployed</span>
                        <span className="font-mono tabular-nums text-foreground">
                          {formatPercent(portfolio.openRiskPct ?? 0)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-muted/50 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${Math.min(100, portfolio.openRiskPct ?? 0)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              }
            />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <KpiCard
              label="Realised P&L"
              prefix="$"
              value={formatNumber(kpiPnl, 2)}
              trend={kpiPnlTrend}
              accentColor={kpiPnlTrend === "up" ? "green" : "red"}
              icon={<TrendingUp className="w-4 h-4" />}
              tooltip="Total profit and loss from all closed paper or live trades since the platform started. Negative means cumulative losses. This resets if the database is cleared."
              detail={
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Win Rate</span>
                  <span className="font-mono tabular-nums text-foreground">{formatNumber(kpiWinRate, 1)}%</span>
                </div>
              }
            />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
            <KpiCard
              label={`Open Positions (${kpiMode})`}
              value={kpiPositions || 0}
              accentColor="amber"
              icon={<ShieldAlert className="w-4 h-4" />}
              tooltip={`Number of open positions in ${kpiMode} mode.`}
              detail={
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Win Rate</span>
                  <span className="font-mono tabular-nums text-foreground">{formatNumber(kpiWinRate, 1)}%</span>
                </div>
              }
            />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <KpiCard
              label={`Total Trades (${kpiMode})`}
              value={kpiSnap?.totalTrades || 0}
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
      </div>

      {activeModes.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {(["paper", "demo", "real"] as const).map(mode => {
              const snap = perMode[mode];
              if (!snap) return null;
              const colorMap = { paper: "warning", demo: "primary", real: "destructive" } as const;
              const color = colorMap[mode];
              return (
                <Card key={mode} className={cn("border", snap.active ? `border-${color}/30` : "border-border/30 opacity-60")}
                  style={snap.active ? { borderColor: `hsl(var(--${color}) / 0.3)` } : undefined}
                >
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={cn("w-2 h-2 rounded-full", snap.active ? "animate-pulse" : "")}
                          style={{ backgroundColor: snap.active ? `hsl(var(--${color}))` : "hsl(var(--muted-foreground) / 0.3)" }}
                        />
                        <span className="text-sm font-bold uppercase tracking-wider" style={snap.active ? { color: `hsl(var(--${color}))` } : undefined}>{mode}</span>
                      </div>
                      <Badge variant={snap.active ? (mode === "real" ? "destructive" : mode === "demo" ? "default" : "warning") : "outline"}>
                        {snap.active ? "Active" : "Off"}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <span className="text-muted-foreground">Capital</span>
                        <p className="font-mono font-semibold text-foreground">{formatCurrency(snap.capital)}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Positions</span>
                        <p className="font-mono font-semibold text-foreground">{snap.openPositions}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">P&L</span>
                        <p className={cn("font-mono font-semibold", (snap.realisedPnl || 0) >= 0 ? "text-success" : "text-destructive")}>
                          {formatCurrency(snap.realisedPnl)}
                        </p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Win Rate</span>
                        <p className="font-mono font-semibold text-foreground">{formatNumber(snap.winRate, 1)}%</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* ── Live Positions (when open) ───────────────────────────── */}
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
                    <th>Symbol</th><th>Side</th>
                    <th className="text-right">Entry</th><th className="text-right">Current</th>
                    <th className="text-right">SL</th><th className="text-right">TP</th>
                    <th className="text-right">Size</th><th className="text-right">Float P&L</th>
                    <th className="text-right">Hrs Left</th><th className="text-center">Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id}>
                      <td className="font-semibold text-foreground">{p.symbol}</td>
                      <td><Badge variant={p.side === "buy" ? "success" : "destructive"}>{p.side}</Badge></td>
                      <td className="text-right mono-num">{formatNumber(p.entryPrice, 2)}</td>
                      <td className="text-right mono-num">{formatNumber(p.currentPrice, 2)}</td>
                      <td className="text-right mono-num text-destructive">{formatNumber(p.sl, 2)}</td>
                      <td className="text-right mono-num text-success">{formatNumber(p.tp, 2)}</td>
                      <td className="text-right mono-num">${formatNumber(p.size, 0)}</td>
                      <td className={cn(
                        "text-right mono-num font-medium",
                        p.floatingPnl > 0 ? "text-success" : p.floatingPnl < 0 ? "text-destructive" : "",
                      )}>
                        {p.floatingPnl > 0 ? "+" : ""}{formatNumber(p.floatingPnl, 2)} ({formatNumber(p.floatingPnlPct, 1)}%)
                      </td>
                      <td className="text-right mono-num">{p.hoursRemaining}h</td>
                      <td className="text-center">
                        <Badge variant={p.mode === "real" ? "destructive" : p.mode === "demo" ? "default" : "warning"}>{p.mode}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </motion.div>
      )}

      {/* ── Bottom 3-col row ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Portfolio Status */}
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
                  { label: "Unrealised P&L",  value: formatCurrency(portfolio?.unrealisedPnl), trend: portfolio?.unrealisedPnl, tooltip: "Floating profit or loss across all currently open positions. Not yet locked in." },
                  { label: "Daily P&L",       value: formatCurrency(portfolio?.dailyPnl),      trend: portfolio?.dailyPnl, tooltip: "Net profit and loss from all trades opened and closed today (UTC day)." },
                  { label: "Drawdown",        value: formatPercent(portfolio?.drawdownPct), negative: true, tooltip: "Peak-to-trough decline from your highest balance. The risk engine triggers if this exceeds your max drawdown limit." },
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
                      negative && "text-destructive",
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

        {/* Operational Status */}
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
                  <p className="section-label mb-3">System Status</p>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Data Stream</span>
                      {overview?.streamingOnline
                        ? <Badge variant="success">Online ({overview.subscribedSymbolCount} symbols)</Badge>
                        : <Badge variant="outline">Offline</Badge>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Signal Engine</span>
                      {overview?.scannerRunning
                        ? <Badge variant="success">Active ({overview.totalScansRun ?? 0} scans)</Badge>
                        : <Badge variant="outline">Idle</Badge>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Paper Execution</span>
                      {overview?.paperModeActive
                        ? <Badge variant="success">Armed</Badge>
                        : <Badge variant="outline">Off</Badge>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Demo Execution</span>
                      {overview?.demoModeActive
                        ? <Badge variant="success">Armed</Badge>
                        : <Badge variant="outline">Off</Badge>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Real Execution</span>
                      {overview?.realModeActive
                        ? <Badge variant="destructive">Armed</Badge>
                        : <Badge variant="outline">Off</Badge>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Kill Switch</span>
                      {overview?.killSwitchActive
                        ? <Badge variant="destructive">Active</Badge>
                        : <Badge variant="outline">Off</Badge>}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Recent Signals */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle>
                <Zap className="w-4 h-4 text-primary" />
                Recent Signals
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {signals?.length ? `${signals.length} latest` : "Live feed"}
              </span>
            </CardHeader>
            <CardContent>
              {!signals || signals.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground text-center">
                    No signals yet. Start the data stream to begin scanning.
                  </p>
                </div>
              ) : (
                <div className="space-y-0">
                  {signals.map((sig, i) => {
                    const isBuy = sig.direction === "buy";
                    return (
                      <div
                        key={sig.id ?? i}
                        className="flex items-center gap-3 py-3 border-b border-border/40 last:border-0"
                      >
                        <Badge variant={isBuy ? "success" : "destructive"} className="text-[10px] font-bold px-1.5 shrink-0">
                          {isBuy ? "BUY" : "SELL"}
                        </Badge>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold font-mono text-foreground leading-none">{sig.symbol}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{FAMILY_LABELS[(sig as any).strategyFamily ?? sig.strategyName ?? ""] || sig.strategyName}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={cn(
                            "text-sm font-bold font-mono tabular-nums",
                            sig.confidence >= 80 ? "text-success"
                              : sig.confidence >= 65 ? "text-warning"
                              : "text-muted-foreground",
                          )}>
                            {formatNumber(sig.confidence, 0)}%
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {sig.createdAt
                              ? new Date(sig.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                              : "—"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
