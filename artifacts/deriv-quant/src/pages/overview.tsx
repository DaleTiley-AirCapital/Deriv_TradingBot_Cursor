import { useQuery } from "@tanstack/react-query";
import {
  RadioTower,
  Zap,
  Shield,
  TrendingUp,
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  BarChart2,
  Database,
  Scan,
  Target,
  XCircle,
  ArrowUpRight,
  ArrowDownRight,
  Cpu,
} from "lucide-react";
import { ACTIVE_SERVICE_SYMBOLS, getSymbolLabel } from "@/lib/symbolCatalog";

const BASE = import.meta.env.BASE_URL || "/";

function apiFetch<T>(path: string): Promise<T> {
  return fetch(`${BASE}${path.replace(/^\//, "")}`).then((response) => {
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  });
}

interface OverviewAPI {
  mode: string;
  openPositions: number;
  lastDataSyncAt: string | null;
  totalDecisionsLogged: number;
  killSwitchActive: boolean;
  streamingOnline: boolean;
  subscribedSymbolCount: number;
  scannerRunning: boolean;
  lastScanTime: string | null;
  lastScanSymbol: string | null;
  totalScansRun: number;
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
  openRisk: number;
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
  newestDate: string | null;
  status: string;
}

interface DataStatusAPI {
  symbols: DataStatusSymbol[];
  totalStorage: number;
  symbolCount: number;
}

interface SymbolDiagnostic {
  symbol: string;
  streamingState: string;
  lastTick?: number | null;
}

interface ServiceLifecycleStatus {
  serviceId: string;
  stagedCandidateArtifactId?: string | null;
  promotedRuntimeArtifactId?: string | null;
  promotedRuntimeVersion?: string | null;
  nextRequiredAction?: string | null;
}

interface TradeAttributionPosition {
  id: number;
  symbol: string;
  attribution: "v3_service_allocator_path" | "legacy_pre_v3_1_allocator_path";
}

const EMPTY_SERVICE_LIFECYCLE = (serviceId: string): ServiceLifecycleStatus => ({
  serviceId,
  stagedCandidateArtifactId: null,
  promotedRuntimeArtifactId: null,
  promotedRuntimeVersion: null,
  nextRequiredAction: null,
});

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

function formatNum(value: number, digits = 2) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function PnlSpan({ value, prefix = "$" }: { value: number; prefix?: string }) {
  const positive = value >= 0;
  return (
    <span className={positive ? "text-green-400" : "text-red-400"}>
      {positive ? "+" : ""}{prefix}{formatNum(Math.abs(value))}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const upper = mode.toUpperCase();
  const cls = upper === "PAPER"
    ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
    : upper === "DEMO"
      ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
      : upper === "REAL"
        ? "bg-green-500/15 text-green-400 border-green-500/25"
        : "bg-muted/30 text-muted-foreground border-border/40";

  return (
    <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-bold border uppercase tracking-widest", cls)}>
      {upper}
    </span>
  );
}

function KpiCard({
  label,
  value,
  sub,
  accent,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: string;
  icon?: React.ElementType;
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

function SectionHeader({
  icon: Icon,
  title,
  sub,
}: {
  icon: React.ElementType;
  title: string;
  sub?: string;
}) {
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

function StatusRow({
  label,
  ok,
  detail,
  loading,
}: {
  label: string;
  ok: boolean;
  detail?: string;
  loading?: boolean;
}) {
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
        {loading ? "..." : (detail ?? "")}
      </span>
    </div>
  );
}

export default function Overview() {
  const { data: overview, isLoading: overviewLoading } = useQuery<OverviewAPI>({
    queryKey: ["api/overview"],
    queryFn: () => apiFetch("api/overview"),
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const { data: portfolio } = useQuery<PortfolioAPI>({
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

  const { data: diagnostics } = useQuery<{ symbols: SymbolDiagnostic[] }>({
    queryKey: ["api/diagnostics/symbols"],
    queryFn: () => apiFetch("api/diagnostics/symbols"),
    refetchInterval: 8000,
    staleTime: 4000,
  });

  const { data: serviceLifecycles } = useQuery<ServiceLifecycleStatus[]>({
    queryKey: ["api/research/service-lifecycles"],
    queryFn: () =>
      Promise.all(
        ACTIVE_SERVICE_SYMBOLS.map((serviceId) =>
          apiFetch<ServiceLifecycleStatus>(`api/research/${serviceId}/service-lifecycle`).catch(() => ({
            serviceId,
            stagedCandidateArtifactId: null,
            promotedRuntimeArtifactId: null,
            promotedRuntimeVersion: null,
            nextRequiredAction: null,
          })),
        ),
      ),
    refetchInterval: 15_000,
    staleTime: 8_000,
  });

  const { data: openTrades = [] } = useQuery<TradeAttributionPosition[]>({
    queryKey: ["api/trade/positions"],
    queryFn: () => apiFetch("api/trade/positions"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const mode = overview?.mode ?? "idle";
  const diagnosticsBySymbol = new Map((diagnostics?.symbols ?? []).map((entry) => [entry.symbol, entry]));
  const streamingSymbols = (diagnostics?.symbols ?? []).filter((entry) => entry.streamingState === "streaming");
  const streamingSymbolData = (dataStatus?.symbols ?? []).filter((entry) =>
    streamingSymbols.some((stream) => stream.symbol === entry.symbol),
  );
  const staleStreamingSymbols = streamingSymbolData.filter((entry) => entry.status === "stale" || entry.status === "no_data");
  const lifecycleCards: ServiceLifecycleStatus[] = serviceLifecycles ?? ACTIVE_SERVICE_SYMBOLS.map((serviceId) => EMPTY_SERVICE_LIFECYCLE(serviceId));
  const promotedServiceCount = lifecycleCards.filter((entry) => Boolean(entry.promotedRuntimeArtifactId)).length;
  const stagedServiceCount = lifecycleCards.filter((entry) => Boolean(entry.stagedCandidateArtifactId)).length;
  const legacyOpenTrades = openTrades.filter((trade) => trade.attribution === "legacy_pre_v3_1_allocator_path");

  const warnings: string[] = [];
  if (overview?.killSwitchActive) warnings.push("Kill switch is active - all new signals are being rejected.");
  if (overview && !overview.streamingOnline) warnings.push("Tick streaming is offline - candles may not update in real time.");
  if (overview?.scannerRunning === false) warnings.push("Signal scanner is not running - no new decisions will be logged.");
  if (staleStreamingSymbols.length > 0) warnings.push(`${staleStreamingSymbols.length} streaming symbol(s) have stale candle data: ${staleStreamingSymbols.map((entry) => entry.symbol).join(", ")}.`);
  if (portfolio?.suggestWithdrawal) warnings.push(`Capital has grown above the withdrawal threshold ($${portfolio.withdrawalThreshold.toLocaleString()}) - consider extracting profits.`);
  if (promotedServiceCount === 0) warnings.push("No promoted service runtimes are active. Candidate emission is disabled and no new trades can open.");
  if (legacyOpenTrades.length > 0) warnings.push(`${legacyOpenTrades.length} open trade(s) still use legacy pre-V3.1 attribution and were not opened through the current service-runtime allocator path.`);

  const scanAge = overview?.lastScanTime ? formatAge(overview.lastScanTime) : "never";
  const dataAge = overview?.lastDataSyncAt ? formatAge(overview.lastDataSyncAt) : "never";
  const paper = overview?.perMode?.paper;
  const demo = overview?.perMode?.demo;
  const real = overview?.perMode?.real;

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operations Overview</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Live system state - shared platform plus symbol-service runtime status - {new Date().toLocaleTimeString()}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {overviewLoading
            ? <span className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-bold border bg-muted/30 text-muted-foreground border-border/40 uppercase tracking-widest animate-pulse">Loading...</span>
            : <ModeBadge mode={mode} />}
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-semibold border",
            overviewLoading
              ? "bg-muted/30 text-muted-foreground border-border/40"
              : overview?.streamingOnline
                ? "bg-green-500/10 text-green-400 border-green-500/25"
                : "bg-red-500/10 text-red-400 border-red-500/25",
          )}>
            {overviewLoading
              ? <><RadioTower className="w-3 h-3" /> Checking...</>
              : overview?.streamingOnline
                ? <><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> {overview.subscribedSymbolCount} streaming</>
                : <><RadioTower className="w-3 h-3" /> Offline</>}
          </span>
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-semibold border",
            overviewLoading
              ? "bg-muted/30 text-muted-foreground border-border/40"
              : overview?.scannerRunning
                ? "bg-primary/10 text-primary border-primary/25"
                : "bg-muted/30 text-muted-foreground border-border/40",
          )}>
            <Scan className="w-3 h-3" />
            {overviewLoading ? "Checking..." : overview?.scannerRunning ? "Scanner live" : "Scanner off"}
          </span>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="space-y-1.5">
          {warnings.map((warning, index) => (
            <div key={index} className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/6 px-3.5 py-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <span className="text-xs text-amber-300/90">{warning}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <SectionHeader icon={Cpu} title="System Overview" sub="Platform and streaming metrics" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Active Mode"
            value={overviewLoading ? "..." : <span className={mode === "idle" ? "text-muted-foreground" : "text-green-400"}>{mode.toUpperCase()}</span>}
            sub={overviewLoading ? undefined : overview?.scannerRunning ? "Scanner running" : "Scanner stopped"}
            icon={Activity}
          />
          <KpiCard
            label="Platform Orchestration Scans"
            value={overviewLoading ? "..." : (overview?.totalScansRun ?? 0).toLocaleString()}
            sub={overviewLoading ? undefined : `Last: ${scanAge}`}
            icon={Scan}
          />
          <KpiCard
            label="Allocator Decisions"
            value={overviewLoading ? "..." : (overview?.totalDecisionsLogged ?? 0).toLocaleString()}
            sub={overviewLoading ? undefined : `Last scanned symbol: ${overview?.lastScanSymbol ?? "-"}`}
            icon={BarChart2}
          />
          <KpiCard
            label="Streaming Symbols"
            value={overviewLoading ? "..." : <span className={overview?.streamingOnline ? "text-green-400" : "text-muted-foreground"}>{streamingSymbols.length}</span>}
            sub={overviewLoading ? undefined : overview?.streamingOnline ? "Live feed active" : "Stream offline"}
            icon={RadioTower}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-4">
        <SectionHeader icon={Activity} title="System Status" sub="Core pipeline health" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
          <div>
            <StatusRow
              label="Tick Streaming"
              ok={!!overview?.streamingOnline}
              detail={overview?.streamingOnline ? `${streamingSymbols.length} symbol(s)` : "offline"}
              loading={overviewLoading}
            />
            <StatusRow
              label="Signal Scanner"
              ok={!!overview?.scannerRunning}
              detail={overview?.scannerRunning ? `last scan ${scanAge}` : "stopped"}
              loading={overviewLoading}
            />
            <StatusRow
              label="Kill Switch"
              ok={!overview?.killSwitchActive}
              detail={overview?.killSwitchActive ? "ACTIVE - signals blocked" : "off"}
              loading={overviewLoading}
            />
          </div>
          <div>
            <StatusRow
              label="Active Trading Mode"
              ok={mode !== "idle"}
              detail={mode.toUpperCase()}
              loading={overviewLoading}
            />
            <StatusRow
              label="Data Last Sync"
              ok={!!overview?.lastDataSyncAt && (Date.now() - new Date(overview.lastDataSyncAt).getTime()) < 3_600_000}
              detail={dataAge}
              loading={overviewLoading}
            />
          </div>
        </div>
        {overview?.scannerRunning && overview.lastScanTime && (
          <div className="mt-3 pt-3 border-t border-border/20 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
            <span><Clock className="w-3 h-3 inline mr-1" />Last scan: <span className="text-foreground font-medium">{scanAge}</span></span>
            <span><Target className="w-3 h-3 inline mr-1" />Last scanned symbol: <span className="text-foreground font-medium font-mono">{overview.lastScanSymbol ?? "-"}</span></span>
            <span><Scan className="w-3 h-3 inline mr-1" />Platform scans: <span className="text-foreground font-medium tabular-nums">{overview.totalScansRun.toLocaleString()}</span></span>
            <span><BarChart2 className="w-3 h-3 inline mr-1" />Allocator decisions: <span className="text-foreground font-medium tabular-nums">{overview.totalDecisionsLogged.toLocaleString()}</span></span>
          </div>
        )}
      </div>

      <div>
        <SectionHeader icon={TrendingUp} title="Trading Activity" sub="Cross-mode portfolio snapshot" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Open Positions"
            value={overview?.openPositions ?? 0}
            sub="All modes"
            icon={Activity}
            accent={(overview?.openPositions ?? 0) > 0 ? "text-amber-400" : undefined}
          />
          <KpiCard
            label="Realised P&L"
            value={<PnlSpan value={portfolio?.realisedPnl ?? 0} />}
            sub="All closed trades"
            icon={TrendingUp}
          />
          <KpiCard
            label="Daily P&L"
            value={<PnlSpan value={portfolio?.dailyPnl ?? 0} />}
            sub="Rolling 24h"
            icon={BarChart2}
          />
          <KpiCard
            label="Drawdown"
            value={`${(portfolio?.drawdownPct ?? 0).toFixed(1)}%`}
            sub={`of $${(portfolio?.totalCapital ?? 0).toLocaleString()} total capital`}
            icon={Shield}
            accent={(portfolio?.drawdownPct ?? 0) > 5 ? "text-amber-400" : (portfolio?.drawdownPct ?? 0) > 10 ? "text-red-400" : undefined}
          />
        </div>
        {(portfolio?.unrealisedPnl != null || portfolio?.weeklyPnl != null) && (
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground px-1">
            {portfolio?.unrealisedPnl != null && <span>Unrealised: <PnlSpan value={portfolio.unrealisedPnl} /></span>}
            {portfolio?.weeklyPnl != null && <span>Weekly: <PnlSpan value={portfolio.weeklyPnl} /></span>}
            {portfolio?.openRisk != null && portfolio.openRisk > 0 && (
              <span>Open risk: <span className="text-foreground font-medium">${formatNum(portfolio.openRisk)}</span></span>
            )}
            {portfolio?.allocationMode && (
              <span>Allocation mode: <span className="text-foreground font-medium capitalize">{portfolio.allocationMode}</span></span>
            )}
          </div>
        )}
      </div>

      <div>
        <SectionHeader icon={Shield} title="Mode Summary" sub="Capital and performance by trading mode" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {([
            ["paper", paper],
            ["demo", demo],
            ["real", real],
          ] as const).map(([modeKey, modeData]) => {
            const isActive = modeData?.active ?? false;
            return (
              <div key={modeKey} className={cn("rounded-xl border p-4", isActive ? "border-primary/40 bg-primary/3" : "border-border/40 bg-card")}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{modeKey}</span>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded border font-semibold",
                    isActive ? "bg-green-500/12 text-green-400 border-green-500/25" : "bg-muted/30 text-muted-foreground/50 border-transparent",
                  )}>
                    {isActive ? "ACTIVE" : "OFF"}
                  </span>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Capital</span>
                    <span className="tabular-nums font-semibold">${(modeData?.capital ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Open positions</span>
                    <span className="tabular-nums font-semibold">{modeData?.openPositions ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Realised P&L</span>
                    <span className={cn("tabular-nums font-semibold", (modeData?.realisedPnl ?? 0) > 0 ? "text-green-400" : (modeData?.realisedPnl ?? 0) < 0 ? "text-red-400" : "")}>
                      {(modeData?.realisedPnl ?? 0) >= 0 ? "+" : ""}${formatNum(modeData?.realisedPnl ?? 0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total trades</span>
                    <span className="tabular-nums font-semibold">{modeData?.totalTrades ?? 0}</span>
                  </div>
                  {(modeData?.totalTrades ?? 0) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Win rate</span>
                      <span className="tabular-nums font-semibold">{((modeData?.winRate ?? 0) * 100).toFixed(0)}%</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-4">
        <SectionHeader
          icon={Database}
          title="Data Health - Streaming Symbols"
          sub={streamingSymbols.length > 0
            ? `${streamingSymbols.length} streaming symbol(s) currently visible in the live feed`
            : "No symbols are currently streaming"}
        />
        {streamingSymbolData.length === 0 ? (
          <p className="text-xs text-muted-foreground">No symbols are currently streaming.</p>
        ) : (
          <div className="space-y-0 divide-y divide-border/20">
            {streamingSymbolData.map((symbolData) => {
              const ageMs = symbolData.newestDate ? Date.now() - new Date(symbolData.newestDate).getTime() : null;
              const ageHours = ageMs != null ? ageMs / 3_600_000 : null;
              const isHealthy = ageHours != null && ageHours < 24;
              const totalMillions = (symbolData.totalCandles / 1_000_000).toFixed(2);
              const liveDiagnostic = diagnosticsBySymbol.get(symbolData.symbol);

              return (
                <div key={symbolData.symbol} className="flex items-center gap-4 py-2.5">
                  <div className="w-20 shrink-0">
                    <span className="text-xs font-mono font-semibold text-foreground">{symbolData.symbol}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground">
                      <span className="tabular-nums"><span className="text-foreground font-medium">{symbolData.count1m.toLocaleString()}</span> M1</span>
                      <span className="tabular-nums"><span className="text-foreground font-medium">{symbolData.count5m.toLocaleString()}</span> M5</span>
                      <span className="tabular-nums text-muted-foreground/70">{totalMillions}M total</span>
                      {symbolData.newestDate && <span className="text-muted-foreground/70">newest: {formatAge(symbolData.newestDate)}</span>}
                      {liveDiagnostic?.lastTick && <span className="text-muted-foreground/70">tick: {formatAge(new Date(liveDiagnostic.lastTick).toISOString())}</span>}
                    </div>
                  </div>
                  <span className={cn(
                    "text-[10px] px-2 py-0.5 rounded border font-semibold shrink-0",
                    isHealthy ? "bg-green-500/10 text-green-400 border-green-500/20" : symbolData.status === "no_data" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20",
                  )}>
                    {isHealthy ? "current" : symbolData.status === "no_data" ? "no data" : "stale"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 pt-3 border-t border-border/20 text-[11px] text-muted-foreground">
          <span>Total stored candles: {(dataStatus?.totalStorage ?? 0).toLocaleString()}</span>
          <span className="mx-2">-</span>
          <span>Streaming now: {streamingSymbols.map((entry) => entry.symbol).join(", ") || "none"}</span>
          <span className="mx-2">-</span>
          <a href="data" className="text-primary underline underline-offset-2 hover:no-underline">View full data console -&gt;</a>
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-4">
        <SectionHeader
          icon={Zap}
          title="Service Runtime Status"
          sub={`${promotedServiceCount} promoted runtime(s) - ${stagedServiceCount} staged candidate(s) across registered services`}
        />
        {promotedServiceCount === 0 && (
          <div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3.5 py-2.5 text-xs text-amber-300">
            Candidate emission is disabled because no promoted service runtimes are active. No new V3.1 trades can open until a service runtime is promoted.
            {legacyOpenTrades.length > 0 ? " Legacy open trades remain visible until they close or are reset." : ""}
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {lifecycleCards.map((service) => (
            <div key={service.serviceId} className="rounded-lg border border-border/40 bg-muted/10 p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                {service.promotedRuntimeArtifactId
                  ? <ArrowUpRight className="w-3.5 h-3.5 text-green-400" />
                  : service.stagedCandidateArtifactId
                    ? <Activity className="w-3.5 h-3.5 text-amber-400" />
                    : <ArrowDownRight className="w-3.5 h-3.5 text-muted-foreground" />}
                <span className="text-xs font-mono font-bold text-foreground">{service.serviceId}</span>
              </div>
              <div className="text-[10px] text-muted-foreground mb-1.5">{getSymbolLabel(service.serviceId)}</div>
              <div className="space-y-0.5">
                <div className="text-[10px] text-muted-foreground">
                  {service.promotedRuntimeArtifactId
                    ? `Promoted runtime ${service.promotedRuntimeVersion ?? ""}`.trim()
                    : service.stagedCandidateArtifactId
                      ? "Candidate staged"
                      : "No promoted runtime"}
                </div>
                {service.nextRequiredAction && (
                  <div className="text-[10px] text-muted-foreground">Next: {service.nextRequiredAction}</div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-border/20 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          <span>Streaming symbols: <span className="text-foreground font-medium">{streamingSymbols.length}</span></span>
          <span>Registered services: <span className="text-foreground font-medium">{ACTIVE_SERVICE_SYMBOLS.length}</span></span>
          <span>Allocator role: <span className="text-foreground font-medium">capital and exposure gatekeeper</span></span>
          <span>Service goal: <span className="text-foreground font-medium">promote validated service runtimes, then let the allocator rank candidates</span></span>
        </div>
      </div>

      {overviewLoading && !overview && (
        <div className="text-center py-10 text-muted-foreground text-sm">Loading system state...</div>
      )}
    </div>
  );
}
