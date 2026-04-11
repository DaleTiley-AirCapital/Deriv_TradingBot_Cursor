import { useQuery } from "@tanstack/react-query";
import {
  Radio, RadioTower, Zap, Shield, TrendingUp, Activity, AlertTriangle,
  CheckCircle, Clock, BarChart2, Database, Scan, Target, XCircle,
  ArrowUpRight, ArrowDownRight,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";
function apiFetch<T>(path: string): Promise<T> {
  return fetch(`${BASE}${path.replace(/^\//, "")}`).then(r => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });
}

interface OverviewAPI {
  mode: string;
  activeModes: string[];
  openPositions: number;
  availableCapital: number;
  openRisk: number;
  aiVerificationEnabled: boolean;
  lastDataSyncAt: string | null;
  totalTrades: number;
  winRate: number;
  realisedPnl: number;
  activeStrategies: number;
  killSwitchActive: boolean;
  paperModeActive: boolean;
  demoModeActive: boolean;
  realModeActive: boolean;
  streamingOnline: boolean;
  subscribedSymbolCount: number;
  scannerRunning: boolean;
  lastScanTime: string | null;
  lastScanSymbol: string | null;
  totalScansRun: number;
  totalDecisionsLogged: number;
  perMode: Record<string, {
    capital: number;
    openPositions: number;
    realisedPnl: number;
    winRate: number;
    totalTrades: number;
    active: boolean;
  }>;
}

interface PortfolioAPI {
  allocationMode: string;
  totalCapital: number;
  availableCapital: number;
  openRisk: number;
  openTradeCount: number;
  realisedPnl: number;
  unrealisedPnl: number;
  dailyPnl: number;
  weeklyPnl: number;
  drawdownPct: number;
  withdrawalThreshold: number;
  suggestWithdrawal: boolean;
}

interface DataStatusSymbol {
  symbol: string;
  tier: string;
  count1m: number;
  count5m: number;
  totalCandles: number;
  oldestDate: string | null;
  newestDate: string | null;
  status: string;
}

interface DataStatusAPI {
  symbols: DataStatusSymbol[];
  totalStorage: number;
  symbolCount: number;
}

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}

function formatAge(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatNum(n: number, dec = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function PnlSpan({ value, prefix = "$" }: { value: number; prefix?: string }) {
  const pos = value >= 0;
  return (
    <span className={pos ? "text-green-400" : "text-red-400"}>
      {pos ? "+" : ""}{prefix}{formatNum(Math.abs(value))}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const m = mode.toUpperCase();
  const cls = m === "PAPER" ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
    : m === "DEMO" ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
    : m === "REAL" ? "bg-green-500/15 text-green-400 border-green-500/25"
    : "bg-muted/30 text-muted-foreground border-border/40";
  return (
    <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-bold border uppercase tracking-widest", cls)}>
      {m}
    </span>
  );
}

function KpiCard({ label, value, sub, accent, icon: Icon }: {
  label: string; value: React.ReactNode; sub?: string;
  accent?: string; icon?: React.ElementType;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4">
      <div className="flex items-start justify-between mb-2">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
        {Icon && <Icon className="w-4 h-4 text-muted-foreground/30" />}
      </div>
      <div className={cn("text-2xl font-bold tabular-nums", accent)}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, sub }: { icon: React.ElementType; title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-4 h-4 text-primary" />
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function StatusRow({ label, ok, detail, loading }: { label: string; ok: boolean; detail?: string; loading?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/20 last:border-0">
      <div className="flex items-center gap-2">
        {loading
          ? <span className="w-3.5 h-3.5 rounded-full border border-border/40 shrink-0 animate-pulse bg-muted/40" />
          : ok
            ? <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
            : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
        <span className="text-xs text-foreground">{label}</span>
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {loading ? "…" : (detail ?? "")}
      </span>
    </div>
  );
}

const ACTIVE_SYMBOLS = ["CRASH300", "BOOM300", "R_75", "R_100"];

export default function Overview() {
  const { data: ov, isLoading: ovLoading } = useQuery<OverviewAPI>({
    queryKey: ["api/overview"],
    queryFn: () => apiFetch("api/overview"),
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const { data: port } = useQuery<PortfolioAPI>({
    queryKey: ["api/portfolio/status"],
    queryFn: () => apiFetch("api/portfolio/status"),
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const { data: dataStatus } = useQuery<DataStatusAPI>({
    queryKey: ["api/research/data-status"],
    queryFn: () => apiFetch("api/research/data-status"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const mode = ov?.mode ?? "idle";
  const paper = ov?.perMode?.paper;
  const demo = ov?.perMode?.demo;
  const real = ov?.perMode?.real;

  const activeSymbolData = dataStatus?.symbols.filter(s => ACTIVE_SYMBOLS.includes(s.symbol)) ?? [];
  const staleSymbols = activeSymbolData.filter(s => s.status === "stale" || s.status === "no_data");

  const warnings: string[] = [];
  if (ov && ov.killSwitchActive) warnings.push("Kill switch is active — all new signals are being rejected.");
  if (ov && !ov.streamingOnline) warnings.push("Tick streaming is offline — candles may not update in real time.");
  if (ov && ov.scannerRunning === false) warnings.push("Signal scanner is not running — no new decisions will be logged.");
  if (ov && staleSymbols.length > 0) warnings.push(`${staleSymbols.length} active symbol(s) have stale candle data: ${staleSymbols.map(s => s.symbol).join(", ")}.`);
  if (port?.suggestWithdrawal) warnings.push(`Capital has grown above the withdrawal threshold ($${port.withdrawalThreshold.toLocaleString()}) — consider extracting profits.`);

  const scanAge = ov?.lastScanTime ? formatAge(ov.lastScanTime) : "never";
  const dataAge = ov?.lastDataSyncAt ? formatAge(ov.lastDataSyncAt) : "never";
  const totalCandles = dataStatus?.totalStorage ?? 0;
  const totalCandlesM = (totalCandles / 1_000_000).toFixed(2);

  return (
    <div className="p-6 space-y-6 max-w-7xl">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operations Overview</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Live system state — V3 multi-engine · {new Date().toLocaleTimeString()}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {ovLoading
            ? <span className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-bold border bg-muted/30 text-muted-foreground border-border/40 uppercase tracking-widest animate-pulse">Loading…</span>
            : <ModeBadge mode={mode} />}
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-semibold border",
            ovLoading
              ? "bg-muted/30 text-muted-foreground border-border/40"
              : ov?.streamingOnline
                ? "bg-green-500/10 text-green-400 border-green-500/25"
                : "bg-red-500/10 text-red-400 border-red-500/25"
          )}>
            {ovLoading
              ? <><RadioTower className="w-3 h-3" /> Checking…</>
              : ov?.streamingOnline
                ? <><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> {ov.subscribedSymbolCount} streaming</>
                : <><RadioTower className="w-3 h-3" /> Offline</>}
          </span>
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-semibold border",
            ovLoading
              ? "bg-muted/30 text-muted-foreground border-border/40"
              : ov?.scannerRunning
                ? "bg-primary/10 text-primary border-primary/25"
                : "bg-muted/30 text-muted-foreground border-border/40"
          )}>
            <Scan className="w-3 h-3" />
            {ovLoading ? "Checking…" : ov?.scannerRunning ? "Scanner live" : "Scanner off"}
          </span>
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-1.5">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/6 px-3.5 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <span className="text-xs text-amber-300/90">{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Section 1: System Status ── */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <SectionHeader icon={Activity} title="System Status" sub="Core pipeline health" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
          <div>
            <StatusRow
              label="Tick Streaming"
              ok={!!ov?.streamingOnline}
              detail={ov?.streamingOnline ? `${ov.subscribedSymbolCount} symbols` : "offline"}
              loading={ovLoading} />
            <StatusRow
              label="Signal Scanner"
              ok={!!ov?.scannerRunning}
              detail={ov?.scannerRunning ? `last scan ${scanAge}` : "stopped"}
              loading={ovLoading} />
            <StatusRow
              label="Kill Switch"
              ok={!ov?.killSwitchActive}
              detail={ov?.killSwitchActive ? "ACTIVE — signals blocked" : "off"}
              loading={ovLoading} />
          </div>
          <div>
            <StatusRow
              label="Active Trading Mode"
              ok={mode !== "idle"}
              detail={mode.toUpperCase()}
              loading={ovLoading} />
            <StatusRow
              label="Data Last Sync"
              ok={!!ov?.lastDataSyncAt && (Date.now() - new Date(ov.lastDataSyncAt).getTime()) < 3_600_000}
              detail={dataAge}
              loading={ovLoading} />
            <StatusRow
              label="AI Verification"
              ok={ov?.aiVerificationEnabled === true}
              detail={ov?.aiVerificationEnabled ? "GPT-4o Enabled" : "Disabled"}
              loading={ovLoading} />
          </div>
        </div>
        {ov?.scannerRunning && ov.lastScanTime && (
          <div className="mt-3 pt-3 border-t border-border/20 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
            <span><Clock className="w-3 h-3 inline mr-1" />Last scan: <span className="text-foreground font-medium">{scanAge}</span></span>
            <span><Target className="w-3 h-3 inline mr-1" />Last symbol: <span className="text-foreground font-medium font-mono">{ov.lastScanSymbol ?? "—"}</span></span>
            <span><Scan className="w-3 h-3 inline mr-1" />Total scans run: <span className="text-foreground font-medium tabular-nums">{ov.totalScansRun.toLocaleString()}</span></span>
            <span><BarChart2 className="w-3 h-3 inline mr-1" />Decisions logged: <span className="text-foreground font-medium tabular-nums">{ov.totalDecisionsLogged.toLocaleString()}</span></span>
          </div>
        )}
      </div>

      {/* ── Section 2: Trading Activity KPIs ── */}
      <div>
        <SectionHeader icon={TrendingUp} title="Trading Activity" sub="Cross-mode portfolio snapshot" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Open Positions"
            value={ov?.openPositions ?? 0}
            sub="All modes"
            icon={Activity}
            accent={(ov?.openPositions ?? 0) > 0 ? "text-amber-400" : undefined}
          />
          <KpiCard
            label="Realised P&L"
            value={<PnlSpan value={port?.realisedPnl ?? 0} />}
            sub="All closed trades"
            icon={TrendingUp}
          />
          <KpiCard
            label="Daily P&L"
            value={<PnlSpan value={port?.dailyPnl ?? 0} />}
            sub="Rolling 24h"
            icon={BarChart2}
          />
          <KpiCard
            label="Drawdown"
            value={`${(port?.drawdownPct ?? 0).toFixed(1)}%`}
            sub={`of $${(port?.totalCapital ?? 0).toLocaleString()} total capital`}
            icon={Shield}
            accent={(port?.drawdownPct ?? 0) > 5 ? "text-amber-400" : (port?.drawdownPct ?? 0) > 10 ? "text-red-400" : undefined}
          />
        </div>
        {(port?.unrealisedPnl != null || port?.weeklyPnl != null) && (
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground px-1">
            {port?.unrealisedPnl != null && (
              <span>Unrealised: <PnlSpan value={port.unrealisedPnl} /></span>
            )}
            {port?.weeklyPnl != null && (
              <span>Weekly: <PnlSpan value={port.weeklyPnl} /></span>
            )}
            {port?.openRisk != null && port.openRisk > 0 && (
              <span>Open risk: <span className="text-foreground font-medium">${formatNum(port.openRisk)}</span></span>
            )}
            {port?.allocationMode && (
              <span>Allocation mode: <span className="text-foreground font-medium capitalize">{port.allocationMode}</span></span>
            )}
          </div>
        )}
      </div>

      {/* ── Section 3: Mode Cards ── */}
      <div>
        <SectionHeader icon={Shield} title="Mode Summary" sub="Capital and performance by trading mode" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(["paper", "demo", "real"] as const).map(m => {
            const md = ov?.perMode?.[m];
            const isActive = md?.active ?? false;
            return (
              <div key={m} className={cn(
                "rounded-xl border p-4",
                isActive ? "border-primary/40 bg-primary/3" : "border-border/40 bg-card"
              )}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{m}</span>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded border font-semibold",
                    isActive ? "bg-green-500/12 text-green-400 border-green-500/25" : "bg-muted/30 text-muted-foreground/50 border-transparent"
                  )}>{isActive ? "ACTIVE" : "OFF"}</span>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Capital</span>
                    <span className="tabular-nums font-semibold">${(md?.capital ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Open positions</span>
                    <span className="tabular-nums font-semibold">{md?.openPositions ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Realised P&L</span>
                    <span className={cn("tabular-nums font-semibold", (md?.realisedPnl ?? 0) > 0 ? "text-green-400" : (md?.realisedPnl ?? 0) < 0 ? "text-red-400" : "")}>
                      {(md?.realisedPnl ?? 0) >= 0 ? "+" : ""}${formatNum(md?.realisedPnl ?? 0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total trades</span>
                    <span className="tabular-nums font-semibold">{md?.totalTrades ?? 0}</span>
                  </div>
                  {(md?.totalTrades ?? 0) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Win rate</span>
                      <span className="tabular-nums font-semibold">{((md?.winRate ?? 0) * 100).toFixed(0)}%</span>
                    </div>
                  )}
                </div>
                {m === "paper" && isActive && (
                  <div className="mt-2.5 pt-2 border-t border-border/20 text-[10px] text-muted-foreground/70">
                    Score threshold: ≥85 for approval
                  </div>
                )}
                {m === "demo" && isActive && (
                  <div className="mt-2.5 pt-2 border-t border-border/20 text-[10px] text-muted-foreground/70">
                    Score threshold: ≥90 for approval
                  </div>
                )}
                {m === "real" && isActive && (
                  <div className="mt-2.5 pt-2 border-t border-border/20 text-[10px] text-muted-foreground/70">
                    Score threshold: ≥92 for approval
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section 4: Data Health ── */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <SectionHeader
          icon={Database}
          title="Data Health — Active Symbols"
          sub={`${totalCandlesM}M candles across all symbols · ${(dataStatus?.symbolCount ?? 0)} symbols tracked`}
        />
        {activeSymbolData.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading coverage data…</p>
        ) : (
          <div className="space-y-0 divide-y divide-border/20">
            {activeSymbolData.map(sym => {
              const ageMs = sym.newestDate ? Date.now() - new Date(sym.newestDate).getTime() : null;
              const ageHours = ageMs != null ? ageMs / 3_600_000 : null;
              const isHealthy = ageHours != null && ageHours < 24;
              const totalM = (sym.totalCandles / 1_000_000).toFixed(2);
              return (
                <div key={sym.symbol} className="flex items-center gap-4 py-2.5">
                  <div className="w-20 shrink-0">
                    <span className="text-xs font-mono font-semibold text-foreground">{sym.symbol}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground">
                      <span className="tabular-nums"><span className="text-foreground font-medium">{sym.count1m.toLocaleString()}</span> M1</span>
                      <span className="tabular-nums"><span className="text-foreground font-medium">{sym.count5m.toLocaleString()}</span> M5</span>
                      <span className="tabular-nums text-muted-foreground/70">{totalM}M total</span>
                      {sym.newestDate && (
                        <span className="text-muted-foreground/70">newest: {formatAge(sym.newestDate)}</span>
                      )}
                    </div>
                  </div>
                  <span className={cn(
                    "text-[10px] px-2 py-0.5 rounded border font-semibold shrink-0",
                    isHealthy ? "bg-green-500/10 text-green-400 border-green-500/20"
                      : sym.status === "no_data" ? "bg-red-500/10 text-red-400 border-red-500/20"
                      : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                  )}>
                    {isHealthy ? "current" : sym.status === "no_data" ? "no data" : "stale"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 pt-3 border-t border-border/20 text-[11px] text-muted-foreground">
          <span>Research symbols ({(dataStatus?.symbols.filter(s => s.tier === "research" && s.totalCandles > 0).length ?? 0)} with data)</span>
          <span className="mx-2">·</span>
          <span>Data symbols ({(dataStatus?.symbols.filter(s => s.tier === "data").length ?? 0)} tracked)</span>
          <span className="mx-2">·</span>
          <a href="data" className="text-primary underline underline-offset-2 hover:no-underline">View full data console →</a>
        </div>
      </div>

      {/* ── Section 5: Engine Summary ── */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <SectionHeader icon={Zap} title="Engine Configuration" sub="Active engines and covered symbols" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { symbol: "BOOM300", engines: ["Boom Expansion"], dir: "buy" },
            { symbol: "CRASH300", engines: ["Crash Expansion"], dir: "sell" },
            { symbol: "R_75", engines: ["R75 Continuation", "R75 Reversal", "R75 Breakout"], dir: "both" },
            { symbol: "R_100", engines: ["R100 Continuation", "R100 Reversal", "R100 Breakout"], dir: "both" },
          ].map(({ symbol, engines, dir }) => (
            <div key={symbol} className="rounded-lg border border-border/40 bg-muted/10 p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                {dir === "buy"
                  ? <ArrowUpRight className="w-3.5 h-3.5 text-green-400" />
                  : dir === "sell"
                    ? <ArrowDownRight className="w-3.5 h-3.5 text-red-400" />
                    : <Activity className="w-3.5 h-3.5 text-primary" />}
                <span className="text-xs font-mono font-bold text-foreground">{symbol}</span>
              </div>
              <div className="space-y-0.5">
                {engines.map(e => (
                  <div key={e} className="text-[10px] text-muted-foreground">{e}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-border/20 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          <span>Active strategies: <span className="text-foreground font-medium">{ov?.activeStrategies ?? 8}</span></span>
          <span>Paper threshold: <span className="text-amber-400 font-medium">≥85</span></span>
          <span>Demo threshold: <span className="text-blue-400 font-medium">≥90</span></span>
          <span>Real threshold: <span className="text-green-400 font-medium">≥92</span></span>
          <span>Target: <span className="text-foreground font-medium">50–200%+ moves, long hold</span></span>
        </div>
      </div>

      {ovLoading && !ov && (
        <div className="text-center py-10 text-muted-foreground text-sm">Loading system state…</div>
      )}
    </div>
  );
}
