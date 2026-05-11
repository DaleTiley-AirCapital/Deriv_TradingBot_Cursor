import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock,
  Loader2,
  RotateCcw,
  Shield,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { ACTIVE_SERVICE_SYMBOLS, getSymbolLabel } from "@/lib/symbolCatalog";

const BASE = import.meta.env.BASE_URL || "/";

function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  return fetch(`${BASE}${path.replace(/^\//, "")}`, opts).then(async (response) => {
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  });
}

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}

interface OpenPosition {
  id: number;
  symbol: string;
  serviceId: string | null;
  serviceCandidateId: string | null;
  allocatorDecisionId: string | null;
  runtimeArtifactId: string | null;
  lifecyclePlanId: string | null;
  sourcePolicyId: string | null;
  attributionPath: string | null;
  attribution: "v3_service_allocator_path" | "legacy_pre_v3_1_allocator_path";
  strategyName: string;
  side: string;
  entryTs: string;
  entryPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  size: number;
  floatingPnl: number;
  floatingPnlPct: number;
  hoursRemaining: number;
  maxExitTs: string | null;
  peakPrice: number | null;
  confidence: number | null;
  mode: string;
}

interface ClosedTrade {
  id: number;
  symbol: string;
  serviceId: string | null;
  serviceCandidateId: string | null;
  allocatorDecisionId: string | null;
  runtimeArtifactId: string | null;
  lifecyclePlanId: string | null;
  sourcePolicyId: string | null;
  attributionPath: string | null;
  attribution: "v3_service_allocator_path" | "legacy_pre_v3_1_allocator_path";
  strategyName: string;
  side: string;
  entryTs: string;
  exitTs: string | null;
  entryPrice: number;
  exitPrice: number | null;
  sl: number;
  tp: number;
  size: number;
  pnl: number | null;
  status: string;
  mode: string;
  notes: string | null;
  confidence: number | null;
  exitReason: string | null;
  trailingStopPct: number | null;
  peakPrice: number | null;
}

interface OverviewMode {
  mode: string;
}

type TradeProvenance = {
  serviceId: string | null;
  serviceCandidateId: string | null;
  allocatorDecisionId: string | null;
  runtimeArtifactId: string | null;
  lifecyclePlanId: string | null;
  sourcePolicyId: string | null;
  attributionPath: string | null;
  attribution: "v3_service_allocator_path" | "legacy_pre_v3_1_allocator_path";
};

function isLegacyAttribution(value: string | null | undefined) {
  return value === "legacy_pre_v3_1_allocator_path";
}

function formatTs(ts: string | null | undefined) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatHoldTime(entryTs: string, exitTs?: string | null) {
  const from = new Date(entryTs).getTime();
  const to = exitTs ? new Date(exitTs).getTime() : Date.now();
  const diff = to - from;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 1) return `${Math.floor(diff / 60_000)}m`;
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function formatPnl(value: number | null | undefined) {
  if (value == null) return { text: "-", cls: "text-muted-foreground/50" };
  const positive = value >= 0;
  return {
    text: `${positive ? "+" : ""}$${Math.abs(value).toFixed(2)}`,
    cls: positive ? "text-green-400 font-semibold" : "text-red-400 font-semibold",
  };
}

function exitReasonLabel(reason: string | null | undefined): { text: string; cls: string } {
  if (!reason) return { text: "-", cls: "text-muted-foreground" };
  const value = reason.toLowerCase();
  if (value.includes("tp")) return { text: "TP hit", cls: "text-green-400" };
  if (value.includes("sl") || value.includes("stop")) return { text: "SL hit", cls: "text-red-400" };
  if (value.includes("trail")) return { text: "Trailing exit", cls: "text-amber-400" };
  if (value.includes("timeout") || value.includes("time")) return { text: "Time exit", cls: "text-muted-foreground" };
  return { text: reason.replace(/_/g, " "), cls: "text-muted-foreground" };
}

function SideChip({ side }: { side: string }) {
  const upper = side.toUpperCase();
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-bold uppercase", upper === "BUY" ? "text-green-400" : "text-red-400")}>
      {upper === "BUY" ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {upper}
    </span>
  );
}

function ModeChip({ mode }: { mode: string }) {
  const upper = mode.toUpperCase();
  const cls = upper === "PAPER"
    ? "bg-amber-500/10 text-amber-400 border-amber-500/25"
    : upper === "DEMO"
      ? "bg-blue-500/10 text-blue-400 border-blue-500/25"
      : upper === "REAL"
        ? "bg-green-500/10 text-green-400 border-green-500/25"
        : "bg-muted/30 text-muted-foreground border-border/40";
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold", cls)}>{upper}</span>;
}

function StrategyLabel({ name }: { name: string }) {
  const label = name
    .replace(/_engine.*$/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/R(\d+)/g, "R$1")
    .trim();
  return <span className="text-[11px] text-muted-foreground">{label}</span>;
}

function PnlPctBar({ pct, positive }: { pct: number; positive: boolean }) {
  const width = Math.min(Math.abs(pct), 100);
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted/30">
      <div className={cn("h-full rounded-full transition-all", positive ? "bg-green-500" : "bg-red-500")} style={{ width: `${width}%` }} />
    </div>
  );
}

function formatField(value: string | number | null | undefined) {
  if (value == null) return "-";
  const text = String(value).trim();
  return text.length > 0 ? text : "-";
}

function ProvenanceBlock(props: TradeProvenance) {
  const legacy = isLegacyAttribution(props.attribution);

  return (
    <div className="space-y-3">
      {legacy && (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          This trade was not opened through the current V3.1 service-runtime allocator path.
        </div>
      )}
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">Service</span><span className="font-medium">{formatField(props.serviceId)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Service candidate</span><span className="font-mono text-[11px]">{formatField(props.serviceCandidateId)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Allocator decision</span><span className="font-mono text-[11px]">{formatField(props.allocatorDecisionId)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Runtime artifact</span><span className="font-mono text-[11px]">{formatField(props.runtimeArtifactId)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Lifecycle plan</span><span className="font-mono text-[11px]">{formatField(props.lifecyclePlanId)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Source policy</span><span className="font-mono text-[11px]">{formatField(props.sourcePolicyId)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Attribution</span><span className={cn("font-medium", legacy ? "text-amber-300" : "text-green-400")}>{formatField(props.attribution)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Path</span><span className="font-mono text-[11px]">{formatField(props.attributionPath)}</span></div>
      </div>
    </div>
  );
}

function OpenPositionRow({ pos }: { pos: OpenPosition }) {
  const [expanded, setExpanded] = useState(false);
  const positive = pos.floatingPnl >= 0;
  const pnlFmt = formatPnl(pos.floatingPnl);
  const holdTime = formatHoldTime(pos.entryTs);
  const urgency = pos.hoursRemaining < 1 ? "red" : pos.hoursRemaining < 4 ? "amber" : null;
  const progressToTp = pos.side === "buy"
    ? (pos.currentPrice - pos.entryPrice) / (pos.tp - pos.entryPrice)
    : (pos.entryPrice - pos.currentPrice) / (pos.entryPrice - pos.tp);
  const tpProgressPct = Math.max(0, Math.min(progressToTp * 100, 100));

  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <div className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/10" onClick={() => setExpanded((value) => !value)}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SideChip side={pos.side} />
            <span className="text-sm font-bold text-foreground">{pos.symbol}</span>
            <ModeChip mode={pos.mode} />
            <div className="hidden sm:block"><StrategyLabel name={pos.strategyName} /></div>
          </div>
        </div>

        <div className="hidden shrink-0 items-center gap-6 text-xs text-muted-foreground md:flex">
          <div className="text-right"><div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Entry</div><div className="tabular-nums font-medium text-foreground">{pos.entryPrice.toFixed(4)}</div></div>
          <div className="text-right"><div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Current</div><div className="tabular-nums font-medium text-foreground">{pos.currentPrice.toFixed(4)}</div></div>
          <div className="text-right"><div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Hold</div><div className="tabular-nums font-medium text-foreground">{holdTime}</div></div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <div className={cn("text-base font-bold tabular-nums", pnlFmt.cls)}>{pnlFmt.text}</div>
            <div className={cn("text-[10px] tabular-nums", positive ? "text-green-400/70" : "text-red-400/70")}>
              {positive ? "+" : ""}{pos.floatingPnlPct.toFixed(2)}%
            </div>
          </div>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      <div className="px-4 pb-2">
        <PnlPctBar pct={Math.abs(pos.floatingPnlPct)} positive={positive} />
      </div>

      {expanded && (
        <div className="grid grid-cols-1 gap-4 border-t border-border/30 bg-muted/5 px-4 py-4 xl:grid-cols-4">
          <div className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground"><Zap className="h-3.5 w-3.5 text-primary" /> Why Opened</h4>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Strategy</span><StrategyLabel name={pos.strategyName} /></div>
              {pos.confidence != null && <div className="flex justify-between"><span className="text-muted-foreground">Confidence score</span><span className="font-semibold text-foreground">{Math.round(pos.confidence)}</span></div>}
              <div className="flex justify-between"><span className="text-muted-foreground">Entry time</span><span className="tabular-nums font-medium">{formatTs(pos.entryTs)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Size allocated</span><span className="tabular-nums font-medium">${pos.size.toFixed(2)}</span></div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground"><Target className="h-3.5 w-3.5 text-primary" /> Target Progress</h4>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Take Profit</span><span className="tabular-nums font-medium text-green-400">{pos.tp.toFixed(4)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Stop Loss</span><span className="tabular-nums font-medium text-red-400">{pos.sl.toFixed(4)}</span></div>
              <div>
                <div className="mb-1 flex justify-between"><span className="text-muted-foreground">Progress to TP</span><span className="tabular-nums text-muted-foreground">{tpProgressPct.toFixed(0)}%</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted/40"><div className="h-full rounded-full bg-green-500" style={{ width: `${tpProgressPct}%` }} /></div>
              </div>
              {pos.peakPrice != null && <div className="flex justify-between"><span className="text-muted-foreground">Peak price</span><span className="tabular-nums font-medium">{pos.peakPrice.toFixed(4)}</span></div>}
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground"><Timer className="h-3.5 w-3.5 text-primary" /> Hold & Risk</h4>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Time in trade</span><span className="tabular-nums font-medium">{holdTime}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Hours remaining</span><span className={cn("tabular-nums font-semibold", urgency === "red" ? "text-red-400" : urgency === "amber" ? "text-amber-400" : "text-foreground")}>{pos.hoursRemaining.toFixed(1)}h</span></div>
              {pos.maxExitTs && <div className="flex justify-between"><span className="text-muted-foreground">Max exit by</span><span className="tabular-nums font-medium">{formatTs(pos.maxExitTs)}</span></div>}
              <div className="flex justify-between"><span className="text-muted-foreground">Float P&L</span><span className={cn("tabular-nums font-bold", pnlFmt.cls)}>{pnlFmt.text}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Float P&L %</span><span className={cn("tabular-nums font-semibold", positive ? "text-green-400" : "text-red-400")}>{positive ? "+" : ""}{pos.floatingPnlPct.toFixed(2)}%</span></div>
            </div>
            {urgency && (
              <div className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]", urgency === "red" ? "border border-red-500/20 bg-red-500/8 text-red-400" : "border border-amber-500/20 bg-amber-500/8 text-amber-400")}>
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {urgency === "red" ? "Less than 1h before forced exit" : `${pos.hoursRemaining.toFixed(1)}h before max hold expires`}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground"><Shield className="h-3.5 w-3.5 text-primary" /> V3.1 Provenance</h4>
            <ProvenanceBlock
              serviceId={pos.serviceId}
              serviceCandidateId={pos.serviceCandidateId}
              allocatorDecisionId={pos.allocatorDecisionId}
              runtimeArtifactId={pos.runtimeArtifactId}
              lifecyclePlanId={pos.lifecyclePlanId}
              sourcePolicyId={pos.sourcePolicyId}
              attributionPath={pos.attributionPath}
              attribution={pos.attribution}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ClosedTradeRow({ t }: { t: ClosedTrade }) {
  const [expanded, setExpanded] = useState(false);
  const pnlFmt = formatPnl(t.pnl);
  const exitLbl = exitReasonLabel(t.exitReason);
  const holdTime = formatHoldTime(t.entryTs, t.exitTs);
  const pnlPct = t.pnl != null && t.size > 0 ? (t.pnl / t.size) * 100 : null;

  return (
    <>
      <tr className="cursor-pointer border-b border-border/20 transition-colors hover:bg-muted/10" onClick={() => setExpanded((value) => !value)}>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <SideChip side={t.side} />
            <span className="text-sm font-semibold">{t.symbol}</span>
            <ModeChip mode={t.mode} />
          </div>
          <StrategyLabel name={t.strategyName} />
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">{formatTs(t.entryTs)}</td>
        <td className="px-3 py-2.5 text-sm font-medium tabular-nums">{t.entryPrice.toFixed(4)}</td>
        <td className="px-3 py-2.5 text-sm tabular-nums text-muted-foreground">{t.exitPrice?.toFixed(4) ?? "-"}</td>
        <td className="px-3 py-2.5 text-center text-xs"><span className={exitLbl.cls}>{exitLbl.text}</span></td>
        <td className="px-3 py-2.5 text-center text-xs text-muted-foreground">{holdTime}</td>
        <td className="px-4 py-2.5 text-right">
          <span className={pnlFmt.cls}>{pnlFmt.text}</span>
          {pnlPct != null && <div className={cn("text-[10px] tabular-nums", pnlPct >= 0 ? "text-green-400/60" : "text-red-400/60")}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</div>}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/5">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid grid-cols-1 gap-4 text-xs sm:grid-cols-3">
              <div className="space-y-1">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Entry Context</p>
                {t.confidence != null && <div className="flex justify-between"><span className="text-muted-foreground">Confidence score</span><span className="font-semibold text-foreground">{Math.round(t.confidence)}</span></div>}
                <div className="flex justify-between"><span className="text-muted-foreground">Strategy</span><StrategyLabel name={t.strategyName} /></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Mode</span><ModeChip mode={t.mode} /></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Size allocated</span><span className="tabular-nums">${t.size.toFixed(2)}</span></div>
              </div>

              <div className="space-y-1">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Targets & Stops</p>
                <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="tabular-nums text-green-400">{t.tp.toFixed(4)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="tabular-nums text-red-400">{t.sl.toFixed(4)}</span></div>
                {t.trailingStopPct != null && <div className="flex justify-between"><span className="text-muted-foreground">Trailing stop</span><span className="tabular-nums">{t.trailingStopPct.toFixed(1)}%</span></div>}
                {t.peakPrice != null && <div className="flex justify-between"><span className="text-muted-foreground">Peak price</span><span className="tabular-nums">{t.peakPrice.toFixed(4)}</span></div>}
              </div>

              <div className="space-y-1">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Outcome</p>
                <div className="flex justify-between"><span className="text-muted-foreground">Exit reason</span><span className={exitLbl.cls}>{exitLbl.text}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Exit time</span><span className="tabular-nums">{formatTs(t.exitTs)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Hold time</span><span className="tabular-nums">{holdTime}</span></div>
                {t.pnl != null && <div className="flex justify-between"><span className="text-muted-foreground">Final P&L</span><span className={pnlFmt.cls}>{pnlFmt.text}</span></div>}
                {t.notes && <div className="mt-1.5 rounded-md bg-muted/20 px-2.5 py-1.5"><p className="text-[11px] leading-relaxed text-muted-foreground">{t.notes}</p></div>}
              </div>

              <div className="space-y-1 sm:col-span-3">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">V3.1 Provenance</p>
                <ProvenanceBlock
                  serviceId={t.serviceId}
                  serviceCandidateId={t.serviceCandidateId}
                  allocatorDecisionId={t.allocatorDecisionId}
                  runtimeArtifactId={t.runtimeArtifactId}
                  lifecyclePlanId={t.lifecyclePlanId}
                  sourcePolicyId={t.sourcePolicyId}
                  attributionPath={t.attributionPath}
                  attribution={t.attribution}
                />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AttributionSection({ closed }: { closed: ClosedTrade[] }) {
  const bySymbol: Record<string, { count: number; pnl: number; wins: number }> = {};
  const byStrategy: Record<string, { count: number; pnl: number; wins: number }> = {};

  for (const trade of closed) {
    if (!bySymbol[trade.symbol]) bySymbol[trade.symbol] = { count: 0, pnl: 0, wins: 0 };
    if (!byStrategy[trade.strategyName]) byStrategy[trade.strategyName] = { count: 0, pnl: 0, wins: 0 };
    bySymbol[trade.symbol].count += 1;
    bySymbol[trade.symbol].pnl += trade.pnl ?? 0;
    byStrategy[trade.strategyName].count += 1;
    byStrategy[trade.strategyName].pnl += trade.pnl ?? 0;
    if ((trade.pnl ?? 0) > 0) {
      bySymbol[trade.symbol].wins += 1;
      byStrategy[trade.strategyName].wins += 1;
    }
  }

  const symbols = Object.entries(bySymbol).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl));
  const strategies = Object.entries(byStrategy).sort((a, b) => b[1].count - a[1].count);

  if (closed.length === 0) {
    return (
      <div className="py-10 text-center">
        <BarChart2 className="mx-auto mb-2 h-8 w-8 text-muted-foreground/20" />
        <p className="text-sm text-muted-foreground">No closed trades to attribute</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-foreground"><Activity className="h-3.5 w-3.5 text-primary" /> By Symbol</h3>
        <div className="space-y-2">
          {symbols.map(([symbol, stats]) => {
            const pnlFmt = formatPnl(stats.pnl);
            const winRate = stats.count > 0 ? ((stats.wins / stats.count) * 100).toFixed(0) : "0";
            return (
              <div key={symbol} className="flex items-center justify-between text-xs">
                <span className="w-20 shrink-0 font-mono font-semibold text-foreground">{symbol}</span>
                <span className="tabular-nums text-muted-foreground">{stats.count} trades</span>
                <span className="tabular-nums text-muted-foreground">{winRate}% WR</span>
                <span className={cn("tabular-nums font-semibold", pnlFmt.cls)}>{pnlFmt.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-foreground"><Zap className="h-3.5 w-3.5 text-primary" /> By Strategy</h3>
        <div className="space-y-2">
          {strategies.map(([strategy, stats]) => {
            const pnlFmt = formatPnl(stats.pnl);
            const label = strategy.replace(/_engine.*$/i, "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
            const winRate = stats.count > 0 ? ((stats.wins / stats.count) * 100).toFixed(0) : "0";
            return (
              <div key={strategy} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex-1 truncate text-foreground">{label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{stats.count} trades</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{winRate}%</span>
                <span className={cn("shrink-0 tabular-nums font-semibold", pnlFmt.cls)}>{pnlFmt.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type Tab = "open" | "closed" | "attribution";

export default function Trades() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("open");
  const [modeFilter, setModeFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState("all");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);

  const { data: openPositions = [], isLoading: openLoading } = useQuery<OpenPosition[]>({
    queryKey: ["api/trade/positions"],
    queryFn: () => apiFetch("api/trade/positions"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const { data: closedTrades = [], isLoading: closedLoading } = useQuery<ClosedTrade[]>({
    queryKey: ["api/trade/history", modeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (modeFilter) params.set("mode", modeFilter);
      return apiFetch(`api/trade/history?${params}`);
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const { data: overview } = useQuery<OverviewMode>({
    queryKey: ["api/overview-mode"],
    queryFn: () => apiFetch("api/overview"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const winners = closedTrades.filter((trade) => (trade.pnl ?? 0) > 0);
  const losers = closedTrades.filter((trade) => (trade.pnl ?? 0) < 0);
  const totalPnl = closedTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const winRate = closedTrades.length > 0 ? (winners.length / closedTrades.length) * 100 : null;
  const avgWin = winners.length > 0 ? winners.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0) / winners.length : null;
  const avgLoss = losers.length > 0 ? losers.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0) / losers.length : null;
  const floatingPnl = openPositions.reduce((sum, trade) => sum + trade.floatingPnl, 0);

  const filteredOpenPositions = openPositions.filter((position) => serviceFilter === "all" || position.symbol === serviceFilter);
  const filteredClosedTrades = closedTrades.filter((trade) => serviceFilter === "all" || trade.symbol === serviceFilter);
  const legacyOpenPositions = filteredOpenPositions.filter((position) => isLegacyAttribution(position.attribution));

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "open", label: "Open Positions", count: filteredOpenPositions.length },
    { id: "closed", label: "Closed Trades", count: filteredClosedTrades.length },
    { id: "attribution", label: "Attribution" },
  ];

  const resetPaperTrading = async () => {
    setResetBusy(true);
    setResetErr(null);
    setResetMsg(null);
    try {
      const response = await apiFetch<{ message?: string }>("api/trade/paper/reset", { method: "POST" });
      setResetMsg(response.message ?? "Paper trading reset complete.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["api/trade/positions"] }),
        queryClient.invalidateQueries({ queryKey: ["api/trade/history"] }),
        queryClient.invalidateQueries({ queryKey: ["api/overview-mode"] }),
      ]);
    } catch (error) {
      setResetErr(error instanceof Error ? error.message : "Paper reset failed");
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div className="max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trade Lifecycle</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Service-filtered positions, closed trades, allocator outcomes, and symbol-service attribution
          </p>
        </div>
        {overview?.mode === "paper" && (
          <button
            onClick={() => void resetPaperTrading()}
            disabled={resetBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resetBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {resetBusy ? "Resetting Paper..." : "Reset Paper Trading"}
          </button>
        )}
      </div>

      {resetMsg && <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3 text-xs text-green-400">{resetMsg}</div>}
      {resetErr && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">{resetErr}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="rounded-xl border border-border/50 bg-card p-4"><p className="mb-1.5 flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground"><Clock className="h-3 w-3" /> Open</p><p className="text-2xl font-bold tabular-nums text-amber-400">{openPositions.length}</p></div>
        <div className="rounded-xl border border-border/50 bg-card p-4"><p className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">Float P&amp;L</p><p className={cn("text-2xl font-bold tabular-nums", floatingPnl >= 0 ? "text-green-400" : "text-red-400")}>{floatingPnl >= 0 ? "+" : ""}${floatingPnl.toFixed(2)}</p></div>
        <div className="rounded-xl border border-border/50 bg-card p-4"><p className="mb-1.5 flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground"><BarChart2 className="h-3 w-3" /> Closed</p><p className="text-2xl font-bold tabular-nums">{closedTrades.length}</p></div>
        <div className="rounded-xl border border-border/50 bg-card p-4"><p className="mb-1.5 flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground"><TrendingUp className="h-3 w-3" /> Win Rate</p><p className="text-2xl font-bold tabular-nums">{winRate != null ? `${winRate.toFixed(0)}%` : "-"}</p>{avgWin != null && avgLoss != null && <p className="mt-0.5 text-[10px] text-muted-foreground">W: +${avgWin.toFixed(2)} / L: ${avgLoss.toFixed(2)}</p>}</div>
        <div className="rounded-xl border border-border/50 bg-card p-4"><p className="mb-1.5 flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground"><TrendingDown className="h-3 w-3" /> Realised P&amp;L</p><p className={cn("text-2xl font-bold tabular-nums", totalPnl >= 0 ? "text-green-400" : "text-red-400")}>{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}</p></div>
      </div>

      <div className="flex gap-1 border-b border-border/50">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={cn("flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors", tab === item.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:border-border/50 hover:text-foreground")}
          >
            {item.label}
            {item.count != null && item.count > 0 && <span className="tabular-nums text-muted-foreground/70">({item.count})</span>}
          </button>
        ))}
      </div>

      {tab === "open" && (
        <div className="space-y-3">
          {legacyOpenPositions.length > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
              {legacyOpenPositions.length} open trade(s) were not opened through the current V3.1 service-runtime allocator path and are shown here as legacy attribution.
            </div>
          )}
          <div className="flex items-center gap-3">
            <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)} className="rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none">
              <option value="all">All Services</option>
              {ACTIVE_SERVICE_SYMBOLS.map((symbol) => <option key={symbol} value={symbol}>{symbol} - {getSymbolLabel(symbol)}</option>)}
            </select>
          </div>
          {openLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading positions...</p>
          ) : filteredOpenPositions.length === 0 ? (
            <div className="py-14 text-center">
              <CircleSlash className="mx-auto mb-3 h-10 w-10 text-muted-foreground/15" />
              <p className="text-sm text-muted-foreground">No open positions</p>
              <p className="mt-1 text-xs text-muted-foreground/60">No selected service positions are currently open.</p>
            </div>
          ) : (
            filteredOpenPositions.map((position) => <OpenPositionRow key={position.id} pos={position} />)
          )}
        </div>
      )}

      {tab === "closed" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)} className="rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none">
              <option value="all">All Services</option>
              {ACTIVE_SERVICE_SYMBOLS.map((symbol) => <option key={symbol} value={symbol}>{symbol} - {getSymbolLabel(symbol)}</option>)}
            </select>
            <select value={modeFilter} onChange={(event) => setModeFilter(event.target.value)} className="rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none">
              <option value="">All Modes</option>
              <option value="paper">Paper</option>
              <option value="demo">Demo</option>
              <option value="real">Real</option>
            </select>
          </div>

          {closedLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading trade history...</p>
          ) : filteredClosedTrades.length === 0 ? (
            <div className="py-14 text-center">
              <BarChart2 className="mx-auto mb-3 h-10 w-10 text-muted-foreground/15" />
              <p className="text-sm text-muted-foreground">No closed trades{modeFilter || serviceFilter !== "all" ? " matching filters" : ""}</p>
              <p className="mt-1 text-xs text-muted-foreground/60">Closed trades show symbol-service decision fields separately from portfolio execution results.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/40 bg-muted/10 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 text-left font-medium">Symbol / Strategy</th>
                      <th className="px-3 py-2.5 text-left font-medium">Entry</th>
                      <th className="px-3 py-2.5 text-left font-medium">Entry Price</th>
                      <th className="px-3 py-2.5 text-left font-medium">Exit Price</th>
                      <th className="px-3 py-2.5 text-center font-medium">Exit Reason</th>
                      <th className="px-3 py-2.5 text-center font-medium">Hold</th>
                      <th className="px-4 py-2.5 text-right font-medium">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredClosedTrades.map((trade) => <ClosedTradeRow key={trade.id} t={trade} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "attribution" && <AttributionSection closed={filteredClosedTrades} />}
    </div>
  );
}
