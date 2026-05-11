import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Download,
  Filter,
  Scale,
  Wallet,
  Zap,
} from "lucide-react";
import { ACTIVE_SERVICE_SYMBOLS, getSymbolLabel } from "@/lib/symbolCatalog";
import { downloadCSV, downloadJSON } from "@/lib/export";

const BASE = import.meta.env.BASE_URL || "/";

function apiFetch<T>(path: string): Promise<T> {
  return fetch(`${BASE}${path.replace(/^\//, "")}`).then(async (response) => {
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  });
}

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

interface AllocatorFeedCandidate {
  candidateId: string;
  serviceId: string;
  symbol: string;
  activeMode: string;
  runtimeArtifactId: string | null;
  sourcePolicyId: string | null;
  sourceSynthesisJobId: number | null;
  generatedAt: string;
  candleTs: string | null;
  direction: string;
  runtimeFamily: string | null;
  triggerTransition: string | null;
  predictedMoveSizeBucket: string | null;
  expectedMovePct: number | null;
  confidence: number | null;
  setupMatch: number | null;
  triggerStrengthScore: number | null;
  winRateEstimate: number | null;
  slHitRateEstimate: number | null;
  profitFactorEstimate: number | null;
  expectedMonthlyContributionPct: number | null;
  tp1Pct: number | null;
  tp2Pct: number | null;
  hardSlPct: number | null;
  lifecyclePlanId: string | null;
  requestedAllocationPct: number | null;
  requestedLeverage: number | null;
  warnings: unknown;
  blockers: unknown;
  executionStatus: string;
  openedTradeId: number | null;
}

interface AllocatorFeedDecision {
  decisionId: string;
  candidateId: string;
  serviceId: string;
  symbol: string;
  approved: boolean;
  rejectionReason: string | null;
  requestedAllocationPct: number | null;
  approvedAllocationPct: number | null;
  approvedCapitalAmount: number | null;
  requestedLeverage: number | null;
  approvedLeverage: number | null;
  finalTp1Pct: number | null;
  finalTp2Pct: number | null;
  finalHardSlPct: number | null;
  lifecyclePlanId: string | null;
  executionAllowed: boolean;
  activeMode: string;
  portfolioExposureBefore: number | null;
  portfolioExposureAfter: number | null;
  warnings: unknown;
  openedTradeId: number | null;
  tradeId: number | null;
  decidedAt: string;
}

interface FeedTrade {
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
}

interface AllocatorFeedEntry {
  decision: AllocatorFeedDecision;
  candidate: AllocatorFeedCandidate | null;
  trade: FeedTrade | null;
}

interface OpenTrade extends FeedTrade {
  currentPrice: number;
  floatingPnl: number;
  floatingPnlPct: number;
  hoursRemaining: number;
  maxExitTs: string | null;
  peakPrice: number | null;
  confidence: number | null;
}

function formatTs(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPct(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(digits)}%`;
}

function formatRatio(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(2)}`;
}

function humanize(value: string | null | undefined) {
  if (!value) return "-";
  return value.replace(/_/g, " ").replace(/\|/g, " | ");
}

function SideChip({ direction }: { direction: string }) {
  const sell = direction.toLowerCase() === "sell";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-bold uppercase", sell ? "text-red-400" : "text-emerald-400")}>
      {sell ? <ArrowDownRight className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
      {direction}
    </span>
  );
}

function DecisionChip({ approved, openedTrade }: { approved: boolean; openedTrade: boolean }) {
  if (openedTrade) {
    return <span className="inline-flex items-center gap-1 rounded border border-green-500/25 bg-green-500/12 px-2 py-0.5 text-[11px] font-semibold text-green-400"><CheckCircle className="w-3 h-3" /> Actioned</span>;
  }
  if (approved) {
    return <span className="inline-flex items-center gap-1 rounded border border-primary/25 bg-primary/12 px-2 py-0.5 text-[11px] font-semibold text-primary"><Activity className="w-3 h-3" /> Approved</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded border border-red-500/25 bg-red-500/12 px-2 py-0.5 text-[11px] font-semibold text-red-400"><AlertTriangle className="w-3 h-3" /> Rejected</span>;
}

function DetailRow({ label, value, accent }: { label: string; value: string; accent?: "green" | "red" | "amber" }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(
        "max-w-[65%] text-right font-medium break-all",
        accent === "green" && "text-green-400",
        accent === "red" && "text-red-400",
        accent === "amber" && "text-amber-400",
      )}>
        {value}
      </span>
    </div>
  );
}

function AllocatorDecisionRow({ entry }: { entry: AllocatorFeedEntry }) {
  const [expanded, setExpanded] = useState(false);
  const candidate = entry.candidate;
  const decision = entry.decision;
  const trade = entry.trade;
  const direction = candidate?.direction ?? trade?.side ?? "unknown";
  const runtimeLabel = candidate?.runtimeFamily
    ?? candidate?.triggerTransition
    ?? candidate?.predictedMoveSizeBucket
    ?? "runtime suggestion";

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      <div
        className="grid cursor-pointer grid-cols-[minmax(0,1.5fr)_90px_minmax(0,1.2fr)_130px_110px_110px_160px_20px] items-center gap-x-4 px-4 py-3 hover:bg-muted/10"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-foreground">{candidate?.serviceId ?? decision.serviceId}</span>
            <span className="text-[11px] text-muted-foreground">{getSymbolLabel(candidate?.serviceId ?? decision.serviceId)}</span>
          </div>
          <div className="mt-1 truncate text-xs text-foreground">{humanize(candidate?.triggerTransition ?? candidate?.runtimeFamily ?? runtimeLabel)}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {candidate?.sourcePolicyId ? `policy ${candidate.sourcePolicyId}` : "no policy id emitted"} - {candidate?.runtimeArtifactId ?? "no runtime artifact"}
          </div>
        </div>

        <div className="flex justify-center">
          <SideChip direction={direction} />
        </div>

        <div className="min-w-0">
          <div className="truncate text-xs text-foreground">{humanize(candidate?.predictedMoveSizeBucket ?? candidate?.runtimeFamily ?? "-")}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            expected move {formatPct(candidate?.expectedMovePct)} - confidence {formatPct((candidate?.confidence ?? null) != null ? (candidate?.confidence ?? 0) * 100 : null, 0)}
          </div>
        </div>

        <div className="flex justify-center">
          <DecisionChip approved={decision.approved} openedTrade={Boolean(trade)} />
        </div>

        <div className="text-right text-sm font-semibold tabular-nums text-foreground">
          {formatPct(decision.approvedAllocationPct)}
        </div>

        <div className="text-center text-xs text-muted-foreground">
          {decision.approvedLeverage && decision.approvedLeverage > 0 ? `${decision.approvedLeverage.toFixed(2)}x` : "none"}
        </div>

        <div className="text-right text-[11px] text-muted-foreground">
          <div>{formatTs(decision.decidedAt)}</div>
          <div className="mt-0.5">{trade ? `trade #${trade.id}` : "not executed"}</div>
        </div>

        <div className="flex justify-end text-muted-foreground">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {expanded && (
        <div className="grid grid-cols-1 gap-4 border-t border-border/20 bg-muted/5 px-4 py-4 md:grid-cols-3">
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground">Service Candidate</h4>
            <div className="space-y-1.5 rounded-md border border-border/30 bg-card/50 p-2.5">
              <DetailRow label="Candidate id" value={candidate?.candidateId ?? decision.candidateId} />
              <DetailRow label="Runtime artifact" value={candidate?.runtimeArtifactId ?? "not emitted"} />
              <DetailRow label="Source policy" value={candidate?.sourcePolicyId ?? "not emitted"} />
              <DetailRow label="Lifecycle plan" value={candidate?.lifecyclePlanId ?? "not emitted"} />
              <DetailRow label="Trigger transition" value={humanize(candidate?.triggerTransition)} />
              <DetailRow label="Predicted bucket" value={humanize(candidate?.predictedMoveSizeBucket)} />
              <DetailRow label="Expected move" value={formatPct(candidate?.expectedMovePct)} />
              <DetailRow label="Confidence" value={formatPct((candidate?.confidence ?? null) != null ? (candidate?.confidence ?? 0) * 100 : null, 0)} />
              <DetailRow label="Setup match" value={formatPct((candidate?.setupMatch ?? null) != null ? (candidate?.setupMatch ?? 0) * 100 : null, 0)} />
              <DetailRow label="Trigger strength" value={formatPct((candidate?.triggerStrengthScore ?? null) != null ? (candidate?.triggerStrengthScore ?? 0) * 100 : null, 0)} />
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground">Allocator Decision</h4>
            <div className="space-y-1.5 rounded-md border border-border/30 bg-card/50 p-2.5">
              <DetailRow label="Approved" value={decision.approved ? "true" : "false"} accent={decision.approved ? "green" : "red"} />
              <DetailRow label="Rejection reason" value={decision.rejectionReason ?? "none"} accent={decision.rejectionReason ? "red" : undefined} />
              <DetailRow label="Requested allocation" value={formatPct(decision.requestedAllocationPct)} />
              <DetailRow label="Approved allocation" value={formatPct(decision.approvedAllocationPct)} accent={decision.approved ? "green" : undefined} />
              <DetailRow label="Capital amount" value={formatMoney(decision.approvedCapitalAmount)} />
              <DetailRow label="Requested leverage" value={decision.requestedLeverage ? `${decision.requestedLeverage.toFixed(2)}x` : "none"} />
              <DetailRow label="Approved leverage" value={decision.approvedLeverage ? `${decision.approvedLeverage.toFixed(2)}x` : "none"} />
              <DetailRow label="TP1 / TP2 / SL" value={`${formatPct(decision.finalTp1Pct)} / ${formatPct(decision.finalTp2Pct)} / ${formatPct(decision.finalHardSlPct)}`} />
              <DetailRow label="Exposure before" value={formatMoney(decision.portfolioExposureBefore)} />
              <DetailRow label="Exposure after" value={formatMoney(decision.portfolioExposureAfter)} />
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground">Execution Result</h4>
            <div className="space-y-1.5 rounded-md border border-border/30 bg-card/50 p-2.5">
              <DetailRow label="Execution allowed" value={decision.executionAllowed ? "true" : "false"} accent={decision.executionAllowed ? "green" : "red"} />
              <DetailRow label="Trade opened" value={trade ? `yes (#${trade.id})` : "no"} accent={trade ? "green" : undefined} />
              <DetailRow label="Mode" value={decision.activeMode} />
              <DetailRow label="Trade attribution" value={trade?.attribution ?? "not executed"} accent={trade?.attribution === "legacy_pre_v3_1_allocator_path" ? "amber" : undefined} />
              <DetailRow label="Entry price" value={trade ? trade.entryPrice.toFixed(4) : "-"} />
              <DetailRow label="Trade size" value={trade ? formatMoney(trade.size) : "-"} />
              <DetailRow label="Status" value={trade?.status ?? "not opened"} />
              <DetailRow label="Decided at" value={formatTs(decision.decidedAt)} />
              <DetailRow label="Generated at" value={formatTs(candidate?.generatedAt)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Decisions() {
  const [serviceFilter, setServiceFilter] = useState("all");

  const { data: feed = [], isLoading } = useQuery<AllocatorFeedEntry[]>({
    queryKey: ["api/trade/allocator-feed"],
    queryFn: () => apiFetch("api/trade/allocator-feed?limit=200"),
    refetchInterval: 5000,
    staleTime: 3000,
  });

  const { data: openTrades = [] } = useQuery<OpenTrade[]>({
    queryKey: ["api/trade/positions"],
    queryFn: () => apiFetch("api/trade/positions"),
    refetchInterval: 5000,
    staleTime: 3000,
  });

  const filteredFeed = useMemo(
    () => feed.filter((entry) => serviceFilter === "all" || (entry.candidate?.serviceId ?? entry.decision.serviceId) === serviceFilter),
    [feed, serviceFilter],
  );

  const legacyOpenTrades = openTrades.filter((trade) => trade.attribution === "legacy_pre_v3_1_allocator_path");
  const approvedCount = filteredFeed.filter((entry) => entry.decision.approved).length;
  const actionedCount = filteredFeed.filter((entry) => Boolean(entry.trade)).length;
  const rejectedCount = filteredFeed.filter((entry) => !entry.decision.approved).length;

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Zap className="h-6 w-6 text-primary" />
            Allocator Decisions
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Service candidates emitted by promoted runtimes, allocator approvals or rejections, and the executed trade if one was opened.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => downloadCSV(filteredFeed.map((entry) => ({
              serviceId: entry.candidate?.serviceId ?? entry.decision.serviceId,
              candidateId: entry.candidate?.candidateId ?? entry.decision.candidateId,
              runtimeArtifactId: entry.candidate?.runtimeArtifactId ?? "",
              sourcePolicyId: entry.candidate?.sourcePolicyId ?? "",
              direction: entry.candidate?.direction ?? "",
              expectedMovePct: entry.candidate?.expectedMovePct ?? "",
              confidence: entry.candidate?.confidence ?? "",
              approved: entry.decision.approved,
              rejectionReason: entry.decision.rejectionReason ?? "",
              approvedAllocationPct: entry.decision.approvedAllocationPct ?? "",
              approvedCapitalAmount: entry.decision.approvedCapitalAmount ?? "",
              approvedLeverage: entry.decision.approvedLeverage ?? "",
              tradeId: entry.trade?.id ?? "",
              tradeAttribution: entry.trade?.attribution ?? "",
            })), "allocator_decisions")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            CSV
          </button>
          <button
            onClick={() => downloadJSON(filteredFeed as unknown as Record<string, unknown>[], "allocator_decisions")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            JSON
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-green-500/25 bg-green-500/12 px-3 py-1.5 text-xs font-medium text-green-400">{actionedCount} Actioned</span>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/12 px-3 py-1.5 text-xs font-medium text-primary">{approvedCount} Approved</span>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/12 px-3 py-1.5 text-xs font-medium text-red-400">{rejectedCount} Rejected</span>
        <span className="ml-auto self-center text-xs text-muted-foreground">{filteredFeed.length} visible</span>
      </div>

      {legacyOpenTrades.length > 0 && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-xs text-amber-300">
          {legacyOpenTrades.length} open trade(s) were not opened through the current V3.1 allocator path and are marked as legacy in Trade Lifecycle.
        </div>
      )}

      <div className="rounded-xl border border-border/50 bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={serviceFilter}
            onChange={(event) => setServiceFilter(event.target.value)}
            className="rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
          >
            <option value="all">All Services</option>
            {ACTIVE_SERVICE_SYMBOLS.map((serviceId) => (
              <option key={serviceId} value={serviceId}>
                {serviceId}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-border/50 bg-card py-20">
          <Activity className="h-5 w-5 animate-pulse text-muted-foreground/40" />
          <span className="ml-2 text-sm text-muted-foreground">Loading allocator decisions...</span>
        </div>
      ) : filteredFeed.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card px-6 py-20 text-center">
          <Scale className="mx-auto mb-3 h-10 w-10 text-muted-foreground/15" />
          <p className="text-sm text-muted-foreground">No service candidates emitted yet.</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            A V3.1 allocator row appears only after a streaming service with a promoted runtime emits a service candidate.
          </p>
          {legacyOpenTrades.length > 0 && (
            <p className="mt-3 text-xs text-amber-300">
              Open legacy trades exist, but they were not created through the current allocator decision flow.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredFeed.map((entry) => (
            <AllocatorDecisionRow key={entry.decision.decisionId} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
