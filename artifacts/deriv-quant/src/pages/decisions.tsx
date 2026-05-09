import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetLatestSignals,
  useGetPendingSignals,
  getGetLatestSignalsQueryKey,
  getGetPendingSignalsQueryKey,
} from "@workspace/api-client-react";
import type {
  GetLatestSignalsParams,
  PendingSignalsResponse,
  SignalLog,
  SignalReviewResponse,
} from "@workspace/api-client-react";
import { formatNumber, cn } from "@/lib/utils";
import { downloadCSV, downloadJSON } from "@/lib/export";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Download,
  Filter,
  Info,
  Layers,
  ShieldAlert,
  Target,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { ACTIVE_SERVICE_SYMBOLS, getSymbolLabel } from "@/lib/symbolCatalog";

const PAGE_SIZE = 50;
const BASE = import.meta.env.BASE_URL || "/";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}api/${path.replace(/^\//, "")}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

type DecisionState = "traded" | "pending" | "approved" | "rejected" | "blocked" | "suppressed";

interface StateStyle {
  label: string;
  chip: string;
  icon: React.ElementType;
  row: string;
}

interface RuntimeLifecycleView {
  promotedRunId?: number | null;
  promotedAt?: string | null;
}

interface RuntimeModelView {
  lifecycle?: RuntimeLifecycleView | null;
}

interface RuntimeEvidenceView {
  promotedModelRunId: number | null;
  selectedRuntimeFamily: string | null;
  triggerTransition: string | null;
  selectedBucket: string | null;
  selectedMoveSizeBucket: string | null;
  setupMatch: number | null;
  triggerStrength: number | null;
  confidence: number | null;
  failReasons: string[];
  candidateProduced: boolean | null;
  candidateDirection: string | null;
  generatedAt: string | null;
  featureSnapshot: Record<string, unknown> | null;
  sourcePolicyId: string | null;
  runtimeArtifactId: string | null;
  rawPayload: Record<string, unknown>;
}

interface GateInfo {
  gate: string;
  detail: string;
}

const STATE_STYLES: Record<DecisionState, StateStyle> = {
  traded: { label: "Actioned", chip: "bg-green-500/12 text-green-400 border-green-500/25", icon: CheckCircle, row: "border-l-2 border-l-green-500/40" },
  pending: { label: "Pending", chip: "bg-amber-500/12 text-amber-400 border-amber-500/25", icon: Clock, row: "border-l-2 border-l-amber-500/40" },
  approved: { label: "Approved", chip: "bg-primary/12 text-primary border-primary/25", icon: Activity, row: "border-l-2 border-l-primary/30" },
  rejected: { label: "Rejected", chip: "bg-orange-500/12 text-orange-400 border-orange-500/25", icon: AlertTriangle, row: "border-l-2 border-l-orange-500/40" },
  blocked: { label: "Blocked", chip: "bg-red-500/12 text-red-400 border-red-500/25", icon: XCircle, row: "border-l-2 border-l-red-500/40" },
  suppressed: { label: "Suppressed", chip: "bg-slate-500/12 text-slate-400 border-slate-500/25", icon: Info, row: "border-l-2 border-l-slate-500/30" },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function compactDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactDateTimeSeconds(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPctValue(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatSignedPct(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(digits)}%`;
}

function formatPctPoints(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(digits)}%`;
}

function formatPercentScale(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(digits)}%`;
}

function humanizeKey(value: string | null | undefined) {
  if (!value) return "-";
  return value
    .replace(/\|/g, " | ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyDecision(sig: SignalLog): DecisionState {
  if (sig.executionStatus === "open" || sig.executionStatus === "executed" || sig.executionStatus === "closed") {
    return "traded";
  }
  if (sig.executionStatus === "pending") return "pending";
  if (!sig.allowedFlag) {
    const r = sig.admissionReason?.toLowerCase() ?? "";
    if (r.includes("composite") && r.includes("<")) return "rejected";
    if (r.includes("score") && r.includes("below")) return "rejected";
    if (r.includes("intelligence only") || r.includes("mode not active")) return "suppressed";
    return "blocked";
  }
  return "approved";
}

function parseBlockingGate(reason: string | null | undefined): GateInfo | null {
  if (!reason) return null;
  const r = reason;
  if (r.startsWith("crash300_runtime_evidence_below_mode_threshold")) {
    const native = r.match(/evidence=(\d+)/)?.[1] ?? "?";
    const min = r.match(/mode_min=(\d+)/)?.[1] ?? "?";
    return { gate: "CRASH300 Runtime Evidence Gate", detail: `Runtime evidence ${native}/100 < admission threshold ${min}` };
  }
  if (r.startsWith("boom300_score_below_mode_threshold")) {
    const native = r.match(/native=(\d+)/)?.[1] ?? "?";
    const min = r.match(/mode_min=(\d+)/)?.[1] ?? "?";
    return { gate: "BOOM300 Runtime Admission Gate", detail: `Runtime evidence ${native}/100 < admission threshold ${min}` };
  }
  if (r.startsWith("r75_") || r.startsWith("r100_")) {
    const native = r.match(/native=(\d+)/)?.[1] ?? "?";
    const min = r.match(/mode_min=(\d+)/)?.[1] ?? "?";
    return { gate: "Runtime Admission Gate", detail: `Runtime evidence ${native}/100 < admission threshold ${min}` };
  }
  if (/kill.?switch/i.test(r)) return { gate: "Kill Switch", detail: "Trading halted by kill switch" };
  if (/daily.*loss/i.test(r)) return { gate: "Daily Loss Limit", detail: "Daily loss limit reached" };
  if (/weekly.*loss/i.test(r)) return { gate: "Weekly Loss Limit", detail: "Weekly loss limit reached" };
  if (/drawdown/i.test(r)) return { gate: "Max Drawdown", detail: "Maximum drawdown exceeded" };
  if (/allocat/i.test(r)) return { gate: "Allocator", detail: "Allocator rejected the suggestion" };
  if (/coordinator/i.test(r)) return { gate: "Coordinator", detail: "Coordinator blocked execution" };
  if (/interpolat/i.test(r)) return { gate: "Data Quality", detail: "Interpolated candles caused the suggestion to be blocked" };
  return { gate: "Gate", detail: r.slice(0, 180) };
}

function extractRuntimeEvidence(sig: SignalLog, crashPromotedRunId?: number | null): RuntimeEvidenceView {
  const dims = asRecord(sig.runtimeEvidenceDimensions);
  const promotedModelRunId = optionalNumber(
    dims.promotedModelRunId
      ?? dims.runtimeModelRunId
      ?? dims.modelRunId
      ?? crashPromotedRunId
      ?? null,
  );
  const failRaw = dims.failReasons ?? dims.failureReasons ?? dims.reasons ?? null;
  const failReasons = Array.isArray(failRaw)
    ? failRaw.map((entry) => String(entry)).filter(Boolean)
    : optionalString(failRaw)
      ? [String(failRaw)]
      : [];
  const featureSnapshot = dims.featureSnapshot && typeof dims.featureSnapshot === "object"
    ? (dims.featureSnapshot as Record<string, unknown>)
    : null;

  return {
    promotedModelRunId,
    selectedRuntimeFamily: optionalString(dims.selectedRuntimeFamily ?? dims.runtimeFamily),
    triggerTransition: optionalString(dims.selectedTriggerTransition ?? dims.triggerTransition ?? dims.selectedTransition),
    selectedBucket: optionalString(dims.selectedBucket ?? dims.bucket),
    selectedMoveSizeBucket: optionalString(dims.selectedMoveSizeBucket ?? dims.moveSizeBucket ?? dims.predictedMoveSizeBucket),
    setupMatch: optionalNumber(dims.setupMatch ?? dims.setup_match ?? dims.runtimeSetupMatch),
    triggerStrength: optionalNumber(dims.triggerStrengthScore ?? dims.triggerStrength),
    confidence: optionalNumber(dims.confidence ?? dims.runtimeConfidence),
    failReasons,
    candidateProduced: optionalBoolean(dims.candidateProduced ?? dims.candidate_produced),
    candidateDirection: optionalString(dims.candidateDirection ?? dims.candidate_direction ?? sig.direction),
    generatedAt: optionalString(dims.generatedAt),
    featureSnapshot,
    sourcePolicyId: optionalString(dims.sourcePolicyId),
    runtimeArtifactId: optionalString(dims.runtimeArtifactId),
    rawPayload: dims,
  };
}

function isCrashDecisionStale(sig: SignalLog, promotedAt: string | null | undefined): boolean {
  if (sig.symbol !== "CRASH300" || !promotedAt) return false;
  const decisionTs = new Date(sig.ts).getTime();
  const promotedTs = new Date(promotedAt).getTime();
  if (!Number.isFinite(decisionTs) || !Number.isFinite(promotedTs)) return false;
  return decisionTs < promotedTs;
}

function allocatorOutcomeLabel(sig: SignalLog, state: DecisionState) {
  if (state === "traded") return "actioned";
  if (state === "approved") return "capital approved";
  if (state === "pending") return "awaiting execution";
  if (state === "suppressed") return "mode suppressed";
  return "not actioned";
}

function allocatorCapitalLabel(sig: SignalLog) {
  return sig.allocationPct != null && Number.isFinite(sig.allocationPct)
    ? `${sig.allocationPct.toFixed(1)}%`
    : "none";
}

function leverageLabel() {
  return "not emitted";
}

function executionStatusLabel(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ") : "not_set";
}

function runtimeSuggestionSummary(sig: SignalLog, runtimeEvidence: RuntimeEvidenceView) {
  return runtimeEvidence.triggerTransition
    ?? runtimeEvidence.selectedRuntimeFamily
    ?? runtimeEvidence.selectedBucket
    ?? "runtime suggestion";
}

function featureSnapshotPreview(featureSnapshot: Record<string, unknown> | null) {
  if (!featureSnapshot) return "none";
  const keys = Object.keys(featureSnapshot).slice(0, 6);
  if (keys.length === 0) return "none";
  return keys
    .map((key) => `${key}=${typeof featureSnapshot[key] === "number" ? formatNumber(Number(featureSnapshot[key]), 4) : String(featureSnapshot[key])}`)
    .join(", ");
}

function suggestionHeadline(sig: SignalLog, runtimeEvidence: RuntimeEvidenceView) {
  if (runtimeEvidence.selectedBucket) {
    return `Bucket ${humanizeKey(runtimeEvidence.selectedBucket)}`;
  }
  if (runtimeEvidence.selectedMoveSizeBucket) {
    return `Move-size ${humanizeKey(runtimeEvidence.selectedMoveSizeBucket)}`;
  }
  return "Service runtime suggestion";
}

function suggestionSubline(sig: SignalLog, runtimeEvidence: RuntimeEvidenceView) {
  const parts = [
    runtimeEvidence.triggerTransition ? humanizeKey(runtimeEvidence.triggerTransition) : null,
    runtimeEvidence.confidence != null ? `confidence ${formatPercentScale(runtimeEvidence.confidence)}` : null,
    runtimeEvidence.setupMatch != null ? `setup ${formatPercentScale(runtimeEvidence.setupMatch)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : humanizeKey(sig.regime ?? "service runtime");
}

function DirectionChip({ direction }: { direction: string | null | undefined }) {
  if (!direction) return <span className="text-muted-foreground/50 text-xs">-</span>;
  const buy = direction === "buy";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-bold uppercase", buy ? "text-emerald-400" : "text-red-400")}>
      {buy ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      {direction}
    </span>
  );
}

function StateChip({ state }: { state: DecisionState }) {
  const style = STATE_STYLES[state];
  const Icon = style.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border whitespace-nowrap", style.chip)}>
      <Icon className="w-3 h-3 shrink-0" /> {style.label}
    </span>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[] | string[];
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function DR({ label, value, highlight }: { label: string; value: string; highlight?: "green" | "red" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-[11px] tabular-nums font-medium text-right max-w-[72%]",
          highlight === "green" ? "text-emerald-400" : highlight === "red" ? "text-red-400" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function DecisionDetailPanel({
  sig,
  state,
  crashPromotedRunId,
  crashPromotedAt,
}: {
  sig: SignalLog;
  state: DecisionState;
  crashPromotedRunId?: number | null;
  crashPromotedAt?: string | null;
}) {
  const tp = sig.suggestedTp != null ? Math.abs(sig.suggestedTp) : null;
  const sl = sig.suggestedSl != null ? Math.abs(sig.suggestedSl) : null;
  const rr = sl && sl > 0 && tp ? tp / sl : null;
  const gate = parseBlockingGate(sig.admissionReason);
  const runtimeEvidence = extractRuntimeEvidence(sig, crashPromotedRunId);
  const isStaleCrashRuntime = isCrashDecisionStale(sig, crashPromotedAt);

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className="grid grid-cols-1 md:grid-cols-3 gap-4 px-4 py-4 bg-muted/5 border-t border-border/20"
    >
      <div className="space-y-3">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-primary" />
          Service Runtime Suggestion
        </h4>
        <div className="rounded-md border border-sky-500/20 bg-sky-500/5 p-2.5 space-y-1.5">
          <DR label="Promoted model run" value={String(runtimeEvidence.promotedModelRunId ?? crashPromotedRunId ?? "-")} />
          <DR label="Runtime family" value={runtimeEvidence.selectedRuntimeFamily ?? "-"} />
          <DR label="Trigger transition" value={runtimeEvidence.triggerTransition ?? "-"} />
          <DR label="Selected bucket" value={runtimeEvidence.selectedBucket ?? "-"} />
          <DR label="Move-size bucket" value={runtimeEvidence.selectedMoveSizeBucket ?? "-"} />
          <DR label="Direction" value={runtimeEvidence.candidateDirection ?? sig.direction ?? "-"} />
          <DR label="Setup match" value={formatPercentScale(runtimeEvidence.setupMatch)} />
          <DR label="Trigger strength" value={formatPercentScale(runtimeEvidence.triggerStrength)} />
          <DR label="Confidence" value={formatPercentScale(runtimeEvidence.confidence)} />
          <DR label="Expected move" value={formatPctPoints(sig.expectedMovePct)} />
          <DR label="Expected value" value={formatSignedPct(sig.expectedValue, 3)} highlight={sig.expectedValue && sig.expectedValue > 0 ? "green" : sig.expectedValue && sig.expectedValue < 0 ? "red" : undefined} />
          <DR label="Candidate produced" value={runtimeEvidence.candidateProduced == null ? "-" : runtimeEvidence.candidateProduced ? "true" : "false"} />
          <DR label="Fail reasons" value={runtimeEvidence.failReasons.length > 0 ? runtimeEvidence.failReasons.join(", ") : "-"} />
          <DR label="Generated at" value={runtimeEvidence.generatedAt ? compactDateTimeSeconds(runtimeEvidence.generatedAt) : compactDateTimeSeconds(sig.ts)} />
          <DR label="Runtime status" value={isStaleCrashRuntime ? "stale decision vs promoted runtime" : "current runtime epoch"} />
          <DR label="Source policy" value={runtimeEvidence.sourcePolicyId ?? "not emitted"} />
          <DR label="Runtime artifact" value={runtimeEvidence.runtimeArtifactId ?? "not emitted"} />
          <DR label="Feature snapshot" value={featureSnapshotPreview(runtimeEvidence.featureSnapshot)} />
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-primary" />
          Allocator Outcome
        </h4>
        <div className="rounded-md border border-border/30 bg-muted/20 p-2.5 space-y-1.5">
          <DR label="Decision state" value={allocatorOutcomeLabel(sig, state)} highlight={state === "traded" || state === "approved" ? "green" : "red"} />
          <DR label="Execution status" value={executionStatusLabel(sig.executionStatus)} />
          <DR label="Capital received" value={allocatorCapitalLabel(sig)} highlight={sig.allocationPct != null && sig.allocationPct > 0 ? "green" : undefined} />
          <DR label="Leverage" value={leverageLabel()} />
          <DR label="Mode" value={sig.mode ?? "not_set"} />
          <DR label="Allocator gate" value={sig.allowedFlag ? "passed" : "blocked"} highlight={sig.allowedFlag ? "green" : "red"} />
          {gate && <DR label="Blocking gate" value={gate.gate} highlight="red" />}
          {gate && <DR label="Gate detail" value={gate.detail} />}
          {!gate && sig.allowedFlag && <DR label="Why it advanced" value="Allocator approved the service suggestion for the active mode and capital rules." highlight="green" />}
          {!gate && !sig.allowedFlag && sig.admissionReason && <DR label="Raw blocker" value={sig.admissionReason} highlight="red" />}
        </div>
        <div className="rounded-md border border-border/30 bg-muted/20 p-2.5 space-y-1.5">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Trade Plan</div>
          <DR label="Take profit" value={tp != null ? formatPctPoints(tp, 2) : "-"} highlight="green" />
          <DR label="Stop loss" value={sl != null ? formatPctPoints(sl, 2) : "-"} highlight="red" />
          <DR label="R:R ratio" value={rr != null ? `${rr.toFixed(2)}:1` : "-"} />
          <DR label="Expected hold" value={sig.expectedHoldDays != null ? `${sig.expectedHoldDays.toFixed(1)}d` : "-"} />
          <DR label="Capture rate" value={formatPctValue(sig.captureRate, 1)} />
          <DR label="Empirical win rate" value={formatPctValue(sig.empiricalWinRate, 1)} />
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <Target className="w-3.5 h-3.5 text-primary" />
          Runtime Payload
        </h4>
        <div className="rounded-md border border-border/30 bg-muted/20 p-2.5 space-y-1.5">
          <DR label="Service" value={sig.symbol} />
          <DR label="Suggestion summary" value={runtimeSuggestionSummary(sig, runtimeEvidence)} />
          <DR label="Move bucket" value={runtimeEvidence.selectedBucket ? humanizeKey(runtimeEvidence.selectedBucket) : runtimeEvidence.selectedMoveSizeBucket ? humanizeKey(runtimeEvidence.selectedMoveSizeBucket) : "not emitted"} />`r`n          <DR label="Trigger transition" value={runtimeEvidence.triggerTransition ? humanizeKey(runtimeEvidence.triggerTransition) : "not emitted"} />`r`n          <DR label="Confidence" value={formatPercentScale(runtimeEvidence.confidence)} />
          <DR label="Suggested allocation" value={allocatorCapitalLabel(sig)} />
          <DR label="Timestamp" value={compactDateTimeSeconds(sig.ts)} />
        </div>
        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Service runtime payload</div>
          <div className="rounded-md bg-card/60 border border-border/30 p-2 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all max-h-64 overflow-auto">
            {JSON.stringify(runtimeEvidence.rawPayload, null, 2)}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function PendingBlock({ data }: { data: PendingSignalsResponse | undefined }) {
  if (!data || data.count === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/3">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-500/15">
        <Clock className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-amber-400">Awaiting Confirmation ({data.count})</span>
      </div>
      <div className="p-3 space-y-2">
        {data.signals.map((ps) => (
          <div
            key={`${ps.symbol}-${ps.strategyName}-${ps.direction}`}
            className="rounded-lg border border-border/50 bg-card p-3 flex items-center gap-4"
          >
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <DirectionChip direction={ps.direction} />
              <span className="font-semibold text-sm">{ps.symbol}</span>
              {ps.pyramidLevel > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/50 text-[10px] text-muted-foreground">
                  <Layers className="w-3 h-3" />
                  L{ps.pyramidLevel + 1}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0 max-w-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground">Confirmation</span>
                <span className="text-xs font-semibold tabular-nums text-amber-400">
                  {ps.confirmCount}/{ps.requiredConfirmations}
                </span>
              </div>
              <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full" style={{ width: `${ps.progressPct}%` }} />
              </div>
            </div>
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">
              awaiting confirmation
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Decisions() {
  const [symbolFilter, setSymbolFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const params: GetLatestSignalsParams = useMemo(() => {
    const next: GetLatestSignalsParams = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (symbolFilter) next.symbol = symbolFilter;
    if (statusFilter === "approved" || statusFilter === "blocked") next.status = statusFilter;
    return next;
  }, [page, symbolFilter, statusFilter]);

  const { data, isLoading } = useGetLatestSignals<SignalReviewResponse>(params, {
    query: { queryKey: getGetLatestSignalsQueryKey(params), refetchInterval: 5000 },
  });
  const { data: pendingData } = useGetPendingSignals<PendingSignalsResponse>({
    query: { queryKey: getGetPendingSignalsQueryKey(), refetchInterval: 5000 },
  });
  const { data: crashRuntimeModel } = useQuery<RuntimeModelView>({
    queryKey: ["calibration/runtime-model", "CRASH300"],
    queryFn: () => apiFetch<RuntimeModelView>("calibration/runtime-model/CRASH300"),
    refetchInterval: 5000,
  });

  const crashPromotedRunId = crashRuntimeModel?.lifecycle?.promotedRunId ?? null;
  const crashPromotedAt = crashRuntimeModel?.lifecycle?.promotedAt ?? null;
  const signals = data?.signals ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const dateFiltered = useMemo(() => {
    return signals.filter((sig) => {
      const ts = new Date(sig.ts);
      if (dateFrom && ts < new Date(dateFrom)) return false;
      if (dateTo) {
        const end = new Date(dateTo);
        end.setDate(end.getDate() + 1);
        if (ts >= end) return false;
      }
      return true;
    });
  }, [dateFrom, dateTo, signals]);

  const symbolOptions = useMemo(() => {
    const present = new Set<string>();
    signals.forEach((sig) => present.add(sig.symbol));
    return Array.from(present).sort();
  }, [signals]);

  const counts = useMemo(() => {
    const result: Record<DecisionState, number> = {
      traded: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      blocked: 0,
      suppressed: 0,
    };
    dateFiltered.forEach((sig) => {
      result[classifyDecision(sig)] += 1;
    });
    return result;
  }, [dateFiltered]);

  const hasFilters = Boolean(symbolFilter || statusFilter || dateFrom || dateTo);

  function clearFilters() {
    setSymbolFilter("");
    setStatusFilter("");
    setDateFrom("");
    setDateTo("");
    setPage(0);
  }

  return (
    <div className="space-y-4 max-w-[1500px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="w-6 h-6 text-primary" />
            Allocator Decisions
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Promoted CRASH300 runtime source: model run {crashPromotedRunId ?? "none"} at {compactDateTime(crashPromotedAt)}.
          </p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Suggested trade opportunities emitted by registered service runtimes, the allocator outcome, and the runtime payload behind each suggestion.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => downloadCSV(
              dateFiltered.map((sig) => {
                const state = classifyDecision(sig);
                const runtimeEvidence = extractRuntimeEvidence(sig, crashPromotedRunId);
                return {
                  time: new Date(sig.ts).toISOString(),
                  service: sig.symbol,
                  serviceLabel: getSymbolLabel(sig.symbol),
                  runtimeFamily: runtimeEvidence.selectedRuntimeFamily,
                  triggerTransition: runtimeEvidence.triggerTransition,
                  selectedBucket: runtimeEvidence.selectedBucket,
                  selectedMoveSizeBucket: runtimeEvidence.selectedMoveSizeBucket,
                  direction: sig.direction,
                  runtimeEvidence: sig.runtimeEvidence,
                  expectedMovePct: sig.expectedMovePct,
                  expectedValue: sig.expectedValue,
                  allocatorDecision: allocatorOutcomeLabel(sig, state),
                  state,
                  allocationPct: sig.allocationPct,
                  leverage: leverageLabel(),
                  executionStatus: sig.executionStatus,
                  admissionReason: sig.admissionReason,
                };
              }),
              "allocator_decisions",
            )}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors"
          >
            <Download className="w-3 h-3" />
            CSV
          </button>
          <button
            onClick={() => downloadJSON(dateFiltered as unknown as Record<string, unknown>[], "allocator_decisions")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors"
          >
            <Download className="w-3 h-3" />
            JSON
          </button>
        </div>
      </div>

      {total > 0 && (
        <div className="flex flex-wrap gap-3">
          {(["traded", "approved", "pending", "rejected", "blocked", "suppressed"] as DecisionState[]).map((state) => {
            const count = counts[state];
            if (count === 0 && state !== "approved") return null;
            const style = STATE_STYLES[state];
            return (
              <button
                key={state}
                onClick={() => setStatusFilter(
                  statusFilter === state
                    ? ""
                    : state === "blocked" || state === "rejected" || state === "suppressed"
                      ? "blocked"
                      : "approved",
                )}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors hover:opacity-80",
                  style.chip,
                )}
              >
                {count} {style.label}
              </button>
            );
          })}
          <span className="text-xs text-muted-foreground self-center tabular-nums ml-auto">{total} total</span>
        </div>
      )}

      <PendingBlock data={pendingData} />

      <div className="rounded-xl border border-border/50 bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <FilterSelect
            value={symbolFilter}
            onChange={(value) => {
              setSymbolFilter(value);
              setPage(0);
            }}
            options={symbolOptions.length > 0 ? symbolOptions : [...ACTIVE_SERVICE_SYMBOLS]}
            placeholder="All Services"
          />
          <span className="text-[10px] text-muted-foreground">From:</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(0);
            }}
            className="bg-card border border-border/50 rounded-md px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
          />
          <span className="text-[10px] text-muted-foreground">To:</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(0);
            }}
            className="bg-card border border-border/50 rounded-md px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
          />
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-3 h-3" />
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Activity className="w-6 h-6 text-muted-foreground/30 animate-pulse" />
            <span className="ml-2 text-sm text-muted-foreground">Loading allocator decisions...</span>
          </div>
        ) : dateFiltered.length === 0 ? (
          <div className="text-center py-16">
            <Zap className="w-10 h-10 text-muted-foreground/15 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {hasFilters ? "No allocator suggestions match the current filters" : "No allocator suggestions recorded yet"}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {!hasFilters && "Registered service runtimes emit suggestions here as they are evaluated by the allocator."}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1.65fr)_88px_minmax(0,1fr)_130px_100px_110px_150px_20px] gap-x-4 px-4 py-2.5 border-b border-border/40 bg-muted/10 text-[11px] text-muted-foreground uppercase tracking-wide font-medium">
              <span>Service / Suggestion</span>
              <span className="w-[88px] text-center">Dir</span>
              <span>Runtime</span>
              <span className="w-[130px] text-center">Allocator</span>
              <span className="w-[100px] text-right">Capital</span>
              <span className="w-[110px] text-center">Leverage</span>
              <span className="w-[150px] text-right">Time</span>
              <span className="w-5" />
            </div>

            <div className="divide-y divide-border/20">
              {dateFiltered.map((sig) => {
                const state = classifyDecision(sig);
                const style = STATE_STYLES[state];
                const runtimeEvidence = extractRuntimeEvidence(sig, crashPromotedRunId);
                const isExpanded = expandedId === sig.id;
                const staleCrashRuntime = isCrashDecisionStale(sig, crashPromotedAt);

                return (
                  <React.Fragment key={sig.id}>
                    <div
                      className={cn(
                        "grid grid-cols-[minmax(0,1.65fr)_88px_minmax(0,1fr)_130px_100px_110px_150px_20px] gap-x-4 px-4 py-3 items-center cursor-pointer hover:bg-muted/10 transition-colors",
                        style.row,
                        isExpanded && "bg-muted/5",
                      )}
                      onClick={() => setExpandedId((prev) => prev === sig.id ? null : sig.id)}
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-sm font-mono text-foreground shrink-0">{sig.symbol}</div>
                        <div className="mt-1 text-[12px] text-foreground truncate">
                          {suggestionHeadline(sig, runtimeEvidence)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                          {suggestionSubline(sig, runtimeEvidence)}
                        </div>
                      </div>

                      <div className="w-[88px] flex justify-center">
                        <DirectionChip direction={sig.direction} />
                      </div>

                      <div className="min-w-0">
                        <div className="text-[11px] text-foreground truncate">
                          {runtimeEvidence.selectedMoveSizeBucket
                            ? `Bucket ${humanizeKey(runtimeEvidence.selectedMoveSizeBucket)}`
                            : runtimeEvidence.selectedBucket
                              ? humanizeKey(runtimeEvidence.selectedBucket)
                              : "Bucket not emitted"}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
                          confidence {formatPercentScale(runtimeEvidence.confidence)} - expected move {formatPctPoints(sig.expectedMovePct)} - EV {formatSignedPct(sig.expectedValue, 3)}
                        </div>
                      </div>

                      <div className="w-[130px] flex justify-center">
                        <StateChip state={state} />
                      </div>

                      <div className="w-[100px] text-right text-sm font-semibold tabular-nums text-foreground">
                        {allocatorCapitalLabel(sig)}
                      </div>

                      <div className="w-[110px] flex justify-center">
                        <span className="text-[11px] text-muted-foreground">{leverageLabel()}</span>
                      </div>

                      <div className="w-[150px] text-right text-[11px] text-muted-foreground tabular-nums">
                        {compactDateTime(sig.ts)}
                        {sig.symbol === "CRASH300" && (
                          <div className={cn("text-[10px] mt-0.5", staleCrashRuntime ? "text-amber-300" : "text-emerald-300")}>
                            {staleCrashRuntime ? "stale runtime epoch" : "current runtime epoch"}
                          </div>
                        )}
                      </div>

                      <div className="w-5 flex justify-end">
                        {isExpanded ? (
                          <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                      </div>
                    </div>

                    <AnimatePresence>
                      {isExpanded && (
                        <DecisionDetailPanel
                          sig={sig}
                          state={state}
                          crashPromotedRunId={crashPromotedRunId}
                          crashPromotedAt={crashPromotedAt}
                        />
                      )}
                    </AnimatePresence>
                  </React.Fragment>
                );
              })}
            </div>
          </>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {page + 1} of {totalPages} | {total} total suggestions
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              className="p-1.5 rounded-md border border-border/50 hover:bg-muted/20 disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 rounded-md border border-border/50 hover:bg-muted/20 disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

