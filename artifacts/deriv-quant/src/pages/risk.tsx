import React from "react";
import { useGetRiskStatus } from "@workspace/api-client-react";
import type { ModeRiskSnapshot } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui-elements";
import { formatPercent, formatCurrency, cn } from "@/lib/utils";
import { ShieldAlert, Lock, Info, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { motion } from "framer-motion";

function RiskGauge({ value, max, breached, label }: { value: number; max: number; breached: boolean; label: string }) {
  const pct = Math.min((Math.abs(value) / max) * 100, 100);
  return (
    <div className="space-y-2.5">
      <div className="flex justify-between items-baseline">
        <span className="section-label">{label}</span>
        <span className={cn("text-xl font-bold font-mono tabular-nums", breached ? "text-destructive" : "text-foreground")}>
          {formatPercent(value)}
        </span>
      </div>
      <div className="w-full bg-muted/40 rounded-full h-1.5 overflow-hidden">
        <div
          className={cn("h-1.5 rounded-full transition-all duration-500", breached ? "bg-destructive" : pct > 60 ? "bg-warning" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">Limit: {max < 0 ? "" : "-"}{max}.0%</p>
    </div>
  );
}

export default function Risk() {
  const { data: risk } = useGetRiskStatus({ query: { refetchInterval: 3000 } });

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Risk Monitor</h1>
          <p className="page-subtitle">Live read-out of exposure limits and circuit-breaker status</p>
        </div>
      </div>

      <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-muted/30 border border-border/40 text-xs text-muted-foreground">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
        <span>This is a <span className="text-foreground font-medium">read-only status panel</span>. To change risk limits, allocation mode, or enable/disable strategies, go to <span className="text-primary">Settings → Risk Controls</span>.</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="lg:col-span-2 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>
                <Lock className="w-4 h-4 text-primary" />
                Aggregate Exposure Limits
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <RiskGauge
                label="Daily Loss"
                value={risk?.dailyLossPct ?? 0}
                max={risk?.maxDailyLossPct ?? 5}
                breached={risk?.dailyLossBreached ?? false}
              />
              <RiskGauge
                label="Weekly Loss"
                value={risk?.weeklyLossPct ?? 0}
                max={risk?.maxWeeklyLossPct ?? 12}
                breached={risk?.weeklyLossBreached ?? false}
              />
              <RiskGauge
                label="Max Drawdown"
                value={risk?.drawdownPct ?? 0}
                max={risk?.maxDrawdownPct ?? 20}
                breached={risk?.maxDrawdownBreached ?? false}
              />
            </CardContent>
          </Card>

          {risk?.perMode && Object.keys(risk.perMode).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <Lock className="w-4 h-4 text-primary" />
                  Per-Mode Risk
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {(["paper", "demo", "real"] as const).map(mode => {
                    const snap = risk.perMode?.[mode] as ModeRiskSnapshot | undefined;
                    if (!snap) return null;
                    const colorMap = { paper: "warning", demo: "primary", real: "destructive" } as const;
                    const color = colorMap[mode];
                    return (
                      <div key={mode} className="space-y-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: `hsl(var(--${color}))` }} />
                          <span className="text-sm font-bold uppercase tracking-wider" style={{ color: `hsl(var(--${color}))` }}>{mode}</span>
                          <span className="text-xs text-muted-foreground ml-auto">Capital: {formatCurrency(snap.totalCapital)}</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                          <RiskGauge
                            label="Daily Loss"
                            value={snap.dailyLossPct ?? 0}
                            max={snap.maxDailyLossPct ?? 5}
                            breached={snap.dailyLossBreached ?? false}
                          />
                          <RiskGauge
                            label="Weekly Loss"
                            value={snap.weeklyLossPct ?? 0}
                            max={snap.maxWeeklyLossPct ?? 12}
                            breached={snap.weeklyLossBreached ?? false}
                          />
                          <RiskGauge
                            label="Max Drawdown"
                            value={snap.drawdownPct ?? 0}
                            max={snap.maxDrawdownPct ?? 20}
                            breached={snap.maxDrawdownBreached ?? false}
                          />
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span>Open Risk: <span className="font-mono text-foreground">{formatPercent(snap.openRiskPct)}</span></span>
                          <span>Open Trades: <span className="font-mono text-foreground">{snap.openTradeCount ?? 0}</span></span>
                          <span>P&L: <span className={cn("font-mono", (snap.realisedPnl ?? 0) >= 0 ? "text-success" : "text-destructive")}>{formatCurrency(snap.realisedPnl)}</span></span>
                        </div>
                        {mode !== "real" && <div className="border-t border-border/30" />}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>
                <ShieldAlert className="w-4 h-4 text-primary" />
                Strategy Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="section-label mb-3">Active Cooldowns</p>
                  {risk?.activeCooldowns?.length ? (
                    <div className="space-y-2">
                      {risk.activeCooldowns.map(c => (
                        <div key={c} className="flex items-center justify-between p-2.5 rounded-lg bg-warning/8 border border-warning/20">
                          <span className="font-mono text-sm text-warning">{c}</span>
                          <Badge variant="warning">Cooling</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No strategies in cooldown.</p>
                  )}
                </div>
                <div>
                  <p className="section-label mb-3">Disabled Strategies</p>
                  {risk?.disabledStrategies?.length ? (
                    <div className="space-y-2">
                      {risk.disabledStrategies.map(s => (
                        <div key={s} className="flex items-center justify-between p-2.5 rounded-lg bg-destructive/8 border border-destructive/20">
                          <span className="font-mono text-sm text-destructive">{s}</span>
                          <Badge variant="destructive">Disabled</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">All strategies enabled.</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}>
          <Card className={cn(
            "border-2 transition-all duration-500",
            risk?.killSwitchActive ? "border-destructive/50 bg-destructive/5" : "border-border"
          )}>
            <CardContent className="p-8 flex flex-col items-center text-center">
              <div className={cn(
                "w-16 h-16 rounded-2xl flex items-center justify-center mb-5",
                risk?.killSwitchActive ? "bg-destructive/20 text-destructive animate-pulse" : "bg-muted/40 text-muted-foreground"
              )}>
                <ShieldAlert className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-semibold mb-2 text-foreground">Global Kill Switch</h2>
              <div className={cn(
                "w-full rounded-xl px-5 py-4 mb-5 flex items-center justify-between",
                risk?.killSwitchActive ? "bg-destructive/10 border border-destructive/25" : "bg-muted/20 border border-border"
              )}>
                <span className="text-sm font-medium text-foreground">Current Status</span>
                <Badge variant={risk?.killSwitchActive ? "destructive" : "outline"}>
                  {risk?.killSwitchActive ? "ENGAGED — System Halted" : "Off — Trading Active"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed mb-5">
                The kill switch instantly flattens all open positions and blocks new entries.
                This is a read-only view — control it from Settings.
              </p>
              <Link href="/settings" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary/10 border border-primary/25 text-primary text-sm font-medium hover:bg-primary/15 transition-colors w-full justify-center">
                <ExternalLink className="w-4 h-4" />
                Go to Settings → Risk Controls
              </Link>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
