import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Radio, Zap, Shield, AlertTriangle, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const BASE = import.meta.env.BASE_URL || "/";

function useSyncQuery<T>(path: string, interval = 10_000) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: async () => {
      const r = await fetch(`${BASE}${path.replace(/^\//, "")}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    refetchInterval: interval,
    staleTime: interval / 2,
  });
}

interface OverviewData {
  mode?: string;
  streaming?: boolean;
  streamingSymbols?: string[];
  engineActivity?: { symbol: string; engine: string; regime: string }[];
  openTrades?: number;
  paper?: { capital?: number; equity?: number; openTrades?: number; pnl?: number };
  demo?: { capital?: number; equity?: number; openTrades?: number };
  real?: { capital?: number; equity?: number; openTrades?: number };
  warnings?: string[];
}

interface PortfolioStatus {
  paper?: { openCount?: number; totalPnl?: number };
  demo?: { openCount?: number };
  real?: { openCount?: number };
}

function ModeChip({ mode }: { mode?: string }) {
  const m = mode?.toUpperCase() ?? "IDLE";
  const color = m === "PAPER" ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
    : m === "DEMO" ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
    : m === "REAL" ? "bg-green-500/15 text-green-400 border-green-500/25"
    : "bg-muted text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border uppercase tracking-wide ${color}`}>
      {m}
    </span>
  );
}

function StatCard({ label, value, sub, icon: Icon, accent }: {
  label: string; value: string | number; sub?: string;
  icon?: React.ElementType; accent?: "green" | "amber" | "red" | "blue";
}) {
  const accentClass = accent === "green" ? "text-green-400"
    : accent === "amber" ? "text-amber-400"
    : accent === "red" ? "text-red-400"
    : accent === "blue" ? "text-blue-400"
    : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${accentClass}`}>{value}</p>
            {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground/40 mt-0.5" />}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const overview = useSyncQuery<OverviewData>("api/overview");
  const portfolio = useSyncQuery<PortfolioStatus>("api/portfolio/status");

  const d = overview.data;
  const p = portfolio.data;

  const mode = d?.mode ?? "idle";
  const isStreaming = d?.streaming ?? false;
  const streamCount = d?.streamingSymbols?.length ?? 0;
  const activeMode = mode !== "idle" ? mode : null;

  const paperPnl = p?.paper?.totalPnl ?? 0;
  const openTotal = (p?.paper?.openCount ?? 0) + (p?.demo?.openCount ?? 0) + (p?.real?.openCount ?? 0);
  const paperCapital = d?.paper?.capital ?? 600;
  const paperEquity = d?.paper?.equity ?? paperCapital;

  const warnings = d?.warnings ?? [];

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Live system state — V3 engine · {new Date().toLocaleTimeString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ModeChip mode={mode} />
          <Badge variant="outline" className={isStreaming
            ? "border-green-500/30 text-green-400 bg-green-500/10"
            : "border-muted text-muted-foreground"}>
            <Radio className="w-3 h-3 mr-1" />
            {isStreaming ? `${streamCount} streaming` : "Not streaming"}
          </Badge>
        </div>
      </div>

      {/* System warnings */}
      {warnings.length > 0 && (
        <div className="space-y-1.5">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/8 px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <span className="text-xs text-amber-300/80">{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Paper Capital"
          value={`$${paperCapital.toLocaleString()}`}
          sub={`Equity $${paperEquity.toFixed(2)}`}
          icon={Shield}
        />
        <StatCard
          label="Realised P&L"
          value={`${paperPnl >= 0 ? "+" : ""}$${paperPnl.toFixed(2)}`}
          sub="Paper mode · all time"
          icon={TrendingUp}
          accent={paperPnl > 0 ? "green" : paperPnl < 0 ? "red" : undefined}
        />
        <StatCard
          label="Open Positions"
          value={openTotal}
          sub="Across all modes"
          icon={Activity}
          accent={openTotal > 0 ? "amber" : undefined}
        />
        <StatCard
          label="V3 Engines"
          value={8}
          sub="Boom · Crash · R75×3 · R100×3"
          icon={Zap}
          accent="blue"
        />
      </div>

      {/* Mode panels */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(["paper", "demo", "real"] as const).map(m => {
          const modeData = d?.[m];
          const modePort = p?.[m];
          const isActive = mode === m;
          return (
            <Card key={m} className={isActive ? "border-primary/40 bg-primary/3" : ""}>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <span className="uppercase tracking-wide">{m}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${
                    isActive
                      ? "bg-green-500/15 text-green-400 border-green-500/25"
                      : "bg-muted text-muted-foreground border-transparent"
                  }`}>{isActive ? "ACTIVE" : "OFF"}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Capital</span>
                  <span className="tabular-nums font-medium">
                    ${(modeData?.capital ?? 600).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Open trades</span>
                  <span className="tabular-nums font-medium">{modePort?.openCount ?? 0}</span>
                </div>
                {m === "paper" && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Total P&L</span>
                    <span className={`tabular-nums font-medium ${
                      (modePort?.totalPnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {(modePort?.totalPnl ?? 0) >= 0 ? "+" : ""}
                      ${(modePort?.totalPnl ?? 0).toFixed(2)}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Engine scan activity */}
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            Engine Scan Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {overview.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading engine activity…</p>
          ) : (d?.engineActivity?.length ?? 0) === 0 ? (
            <div className="text-center py-6">
              <Activity className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No recent engine decisions</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Engines scan every 60s — decisions appear in{" "}
                <a href="decisions" className="text-primary underline underline-offset-2">Engine Decisions</a>
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {d!.engineActivity!.slice(0, 8).map((ea, i) => (
                <div key={i} className="flex items-center gap-3 py-1.5 border-b border-border/30 last:border-0">
                  <span className="text-xs font-mono font-semibold text-foreground w-20 shrink-0">{ea.symbol}</span>
                  <span className="text-xs text-muted-foreground">{ea.engine}</span>
                  <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0">{ea.regime}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
