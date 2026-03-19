import React from "react";
import { 
  useGetRiskStatus, 
  useTriggerKillSwitch, 
  getGetRiskStatusQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, Badge, Button } from "@/components/ui-elements";
import { formatPercent, cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, AlertOctagon, Lock, Info } from "lucide-react";
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
  const queryClient = useQueryClient();
  const { data: risk } = useGetRiskStatus({ query: { refetchInterval: 3000 } });

  const { mutate: triggerKill, isPending: killing } = useTriggerKillSwitch({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetRiskStatusQueryKey() })
    }
  });

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
                Exposure Limits
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <RiskGauge
                label="Daily Loss"
                value={risk?.dailyLossPct ?? 0}
                max={5}
                breached={risk?.dailyLossBreached ?? false}
              />
              <RiskGauge
                label="Weekly Loss"
                value={risk?.weeklyLossPct ?? 0}
                max={10}
                breached={risk?.weeklyLossBreached ?? false}
              />
              <RiskGauge
                label="Max Drawdown"
                value={risk?.drawdownPct ?? 0}
                max={20}
                breached={risk?.maxDrawdownBreached ?? false}
              />
            </CardContent>
          </Card>

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
                risk?.killSwitchActive ? "bg-destructive/20 text-destructive animate-pulse" : "bg-muted text-muted-foreground"
              )}>
                <ShieldAlert className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-semibold mb-2 text-foreground">Global Kill Switch</h2>
              <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
                Instantly flattens all open positions and blocks all new entries. Use in an emergency.
              </p>
              <Button 
                variant="destructive"
                size="lg"
                className="w-full font-bold"
                onClick={() => triggerKill()}
                isLoading={killing}
                disabled={risk?.killSwitchActive}
              >
                <AlertOctagon className="w-5 h-5" />
                {risk?.killSwitchActive ? "System Halted" : "Engage Kill Switch"}
              </Button>
              {risk?.killSwitchActive && (
                <p className="text-xs text-muted-foreground mt-3">
                  To resume trading, disable the kill switch from <span className="text-primary">Settings → Risk Controls</span>.
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
