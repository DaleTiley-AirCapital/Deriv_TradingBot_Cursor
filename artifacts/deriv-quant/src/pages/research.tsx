import { Fragment, useState, useRef, useEffect, useCallback, useMemo, createContext, useContext, type ReactNode } from "react";
import {
  FlaskConical, RefreshCw,
  Loader2, CheckCircle, XCircle,
  FileText, Clock, BarChart2, ChevronRight, Download, Activity,
  Target, Zap, TrendingUp, TrendingDown, Search, ChevronDown, ChevronUp, Trash2, Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDurationCompact } from "@/lib/time";
import { formatWorkerTaskLabel, type WorkerJobUi } from "@/lib/workerJobs";
import {
  ACTIVE_SERVICE_SYMBOLS,
  SERVICE_SELECTOR_OPTIONS,
  SYMBOL_CATALOG,
  getSymbolLabel,
  getSymbolGroup,
  getGroupedSymbols,
  isEnabledService,
  isScaffoldedService,
} from "@/lib/symbolCatalog";
import { CleanCanonicalTab, HistoricalDownloadCard, useResearchDataStatus } from "./data";

const BASE = import.meta.env.BASE_URL || "/";

function apiFetch(path: string, opts?: RequestInit) {
  return fetch(`${BASE}api/${path.replace(/^\//, "")}`, opts).then(async r => {
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const d = await r.json(); msg = d.error ?? d.message ?? msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  });
}

const CALIB_PASS_SESSION_KEY = "deriv_calib_pass_run";
const RESEARCH_CUSTOM_SERVICES_KEY = "deriv_research_custom_services_v1";
const RESEARCH_DIAGNOSTIC_HISTORY_KEY = "deriv_research_diagnostic_history_v1";

type DiagnosticHistoryEntry = {
  id: string;
  service: string;
  action: "parity" | "runtime-trigger-validation" | "optimiser";
  status: string;
  detail: string;
  at: string;
};

type ServiceStatusDisclosureKey = "runtime" | "blockers" | "warnings";

interface PassStatusResult {
  id: number;
  symbol?: string;
  status: string;
  passName?: string | null;
  totalMoves?: number | null;
  processedMoves?: number | null;
  failedMoves?: number | null;
  windowDays?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  errors?: string[];
  errorSummary?: unknown;
  metaJson?: Record<string, unknown> | null;
}

type CalibrationRunContextValue = {
  runId: number | null;
  symbol: string | null;
  status: PassStatusResult | null;
  /** Last finished run (failed/completed/partial) so the UI can still show errors after polling stops. */
  lastTerminalRun: { symbol: string; status: PassStatusResult } | null;
  /** Polling active for an in-flight server run */
  isPassRunActive: boolean;
  beginPassRun: (runId: number, symbol: string) => void;
  /** Stop polling and session if the active run was for this symbol (e.g. DB reset). */
  clearPassRunForSymbol: (symbol: string) => void;
};

const CalibrationRunContext = createContext<CalibrationRunContextValue | null>(null);

function useCalibrationRun(): CalibrationRunContextValue {
  const v = useContext(CalibrationRunContext);
  if (!v) throw new Error("useCalibrationRun: missing provider");
  return v;
}

/** Keeps pass-run polling alive while viewing the symbol-service research workspace. */
function CalibrationRunProvider({ children }: { children: ReactNode }) {
  const [runId, setRunId] = useState<number | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [status, setStatus] = useState<PassStatusResult | null>(null);
  const [lastTerminalRun, setLastTerminalRun] = useState<{ symbol: string; status: PassStatusResult } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopInterval = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const beginPassRun = useCallback((rid: number, sym: string) => {
    stopInterval();
    try {
      sessionStorage.setItem(CALIB_PASS_SESSION_KEY, JSON.stringify({ runId: rid, symbol: sym }));
    } catch { /* ignore */ }
    setLastTerminalRun(null);
    setRunId(rid);
    setSymbol(sym);
    setStatus(null);
  }, []);

  const clearPassRunForSymbol = useCallback((sym: string) => {
    if (symbol !== sym) return;
    stopInterval();
    try { sessionStorage.removeItem(CALIB_PASS_SESSION_KEY); } catch { /* ignore */ }
    setRunId(null);
    setSymbol(null);
    setStatus(null);
    setLastTerminalRun(prev => (prev?.symbol === sym ? null : prev));
  }, [symbol]);

  // Restore session and drop stale "running" entries
  useEffect(() => {
    (async () => {
      try {
        const raw = sessionStorage.getItem(CALIB_PASS_SESSION_KEY);
        if (!raw) return;
        const p = JSON.parse(raw) as { runId: number; symbol: string };
        const s = (await apiFetch(`calibration/run-status/${p.runId}`)) as PassStatusResult;
        setStatus(s);
        if (s.status === "running") {
          setRunId(p.runId);
          setSymbol(p.symbol);
        } else {
          sessionStorage.removeItem(CALIB_PASS_SESSION_KEY);
          setLastTerminalRun({ symbol: p.symbol, status: s });
        }
      } catch {
        try { sessionStorage.removeItem(CALIB_PASS_SESSION_KEY); } catch { /* ignore */ }
      }
    })();
  }, []);

  useEffect(() => {
    if (!runId) return;

    const tick = async () => {
      try {
        const s = (await apiFetch(`calibration/run-status/${runId}`)) as PassStatusResult;
        setStatus(s);
        const done =
          s.status === "completed" || s.status === "failed" || s.status === "partial" || s.status === "cancelled";
        if (done) {
          stopInterval();
          try { sessionStorage.removeItem(CALIB_PASS_SESSION_KEY); } catch { /* ignore */ }
          const symForRun = symbol;
          if (symForRun) setLastTerminalRun({ symbol: symForRun, status: s });
          setRunId(null);
          setSymbol(null);
          setStatus(null);
        }
      } catch {
        /* transient network errors  keep polling */
      }
    };

    void tick();
    intervalRef.current = setInterval(tick, 1800);
    return () => stopInterval();
  }, [runId]);

  const value: CalibrationRunContextValue = {
    runId,
    symbol,
    status,
    lastTerminalRun,
    isPassRunActive: runId !== null,
    beginPassRun,
    clearPassRunForSymbol,
  };

  return (
    <CalibrationRunContext.Provider value={value}>
      {children}
    </CalibrationRunContext.Provider>
  );
}

const ACTIVE_SYMBOLS: string[] = [...ACTIVE_SERVICE_SYMBOLS];
const BACKTEST_ACTIVE_SYMBOLS = ["all", ...ACTIVE_SYMBOLS];
type DomainId = "active";
type ResearchTabId = "data" | "calibration" | "synthesis" | "runtime" | "reports";
const RESEARCH_WINDOWS = [
  { days: 30, label: "1 month" },
  { days: 90, label: "3 months" },
  { days: 180, label: "6 months" },
  { days: 270, label: "9 months" },
  { days: 365, label: "12 months" },
] as const;

function windowLabel(days: number): string {
  return RESEARCH_WINDOWS.find(w => w.days === days)?.label ?? `${days} days`;
}

function normalizeTargetProfile(profile: string | null | undefined): string {
  if (profile === "return_amplification") return "return_first";
  return profile ?? "default";
}

function targetProfileLabel(profile: string | null | undefined): string {
  switch (normalizeTargetProfile(profile)) {
    case "return_first":
      return "return-first / profit amplification";
    case "default":
      return "default";
    default:
      return profile ? String(profile).replaceAll("_", " ") : "default";
  }
}

function searchProfileLabel(profile: string | null | undefined): string {
  return profile ? String(profile).replaceAll("_", " ") : "n/a";
}

function readCustomResearchServices(): string[] {
  try {
    const raw = localStorage.getItem(RESEARCH_CUSTOM_SERVICES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value ?? "").toUpperCase()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeCustomResearchServices(services: string[]): void {
  try {
    localStorage.setItem(RESEARCH_CUSTOM_SERVICES_KEY, JSON.stringify(Array.from(new Set(services))));
  } catch {
    // Ignore storage failures and keep the current session usable.
  }
}

function readDiagnosticHistory(service: string, action: DiagnosticHistoryEntry["action"]): DiagnosticHistoryEntry[] {
  try {
    const raw = localStorage.getItem(RESEARCH_DIAGNOSTIC_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DiagnosticHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry.service === service && entry.action === action);
  } catch {
    return [];
  }
}

function appendDiagnosticHistory(entry: DiagnosticHistoryEntry): DiagnosticHistoryEntry[] {
  try {
    const raw = localStorage.getItem(RESEARCH_DIAGNOSTIC_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const existing = Array.isArray(parsed) ? (parsed as DiagnosticHistoryEntry[]) : [];
    const next = [entry, ...existing].slice(0, 60);
    localStorage.setItem(RESEARCH_DIAGNOSTIC_HISTORY_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [entry];
  }
}

function getWindowRange(windowDays: number): {
  startTs: number;
  endTs: number;
  startDateStr: string;
  endDateStr: string;
} {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, windowDays) + 1);
  start.setHours(0, 0, 0, 0);
  return {
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000),
    startDateStr: start.toISOString().slice(0, 10),
    endDateStr: end.toISOString().slice(0, 10),
  };
}

function StatusPill({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400 border border-green-500/25"><CheckCircle className="w-3 h-3" />{yes}</span>
    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/15 text-red-400 border border-red-500/25"><XCircle className="w-3 h-3" />{no}</span>;
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
      <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="font-mono break-all">{msg}</span>
    </div>
  );
}

function SuccessBox({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
      <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="break-all">{msg}</span>
    </div>
  );
}

//  Backtest Tab 

interface V3Trade {
  entryTs: number;
  exitTs: number;
  symbol: string;
  direction: "buy" | "sell";
  engineName: string;
  entryType: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  projectedMovePct: number;
  runtimeEvidence: number | null;
  modelSource?: string | null;
  runtimeModelRunId?: number | null;
  runtimeFamily?: string | null;
  selectedBucket?: string | null;
  qualityTier?: string | null;
  confidence?: number | null;
  setupMatch?: number | null;
  protectionActivationPct?: number | null;
  dynamicProtectionDistancePct?: number | null;
  protectionMinHoldBars?: number | null;
  protectionActivated?: boolean;
  regimeAtEntry: string;
  holdBars: number;
  pnlPct: number;
  leg1Hit: boolean;
  mfePct: number;
  maePct: number;
  admissionPolicyWouldBlock?: boolean | null;
  admissionPolicyBlockedReasons?: string[] | null;
  admissionPolicyMode?: "off" | "preview" | "enforce" | null;
}

type V3TradeExport = V3Trade & {
};

interface V3Summary {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnlPct: number;
  summedTradePnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  totalPnlPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  summedTradeDrawdownPct: number;
  avgHoldBars: number;
  leg1HitRate: number;
  byEngine: Record<string, { count: number; wins: number; avgPnlPct: number }>;
  byExitReason: Record<string, number>;
  admissionPolicyEnabled?: boolean;
  admissionPolicyMode?: "off" | "preview" | "enforce";
  admissionPolicyConfig?: Crash300AdmissionPolicyConfig;
  candidatesBlockedByAdmissionPolicy?: number;
  blockedReasonsCounts?: Record<string, number>;
  tradesWouldHaveBeenBlocked?: number;
  winsBlocked?: number | null;
  lossesBlocked?: number | null;
  slHitsBlocked?: number | null;
  resultingWinRate?: number | null;
  resultingTradeCount?: number | null;
  capitalModel?: {
    startingCapitalUsd: number;
    allocationPct: number;
    maxConcurrentTrades: number;
    compoundingEnabled: boolean;
    syntheticEquityUsd: number;
    syntheticPositionSizeUsd: number;
    equityCurveModel: string;
    tradePnlBasis: string;
  };
  endingCapitalUsd?: number;
  netProfitUsd?: number;
  accountReturnPct?: number;
  allocatedCapitalReturnPct?: number;
  averageTradePnlPct?: number;
  maxDrawdownUsd?: number;
  accountMaxDrawdownPct?: number;
  largestWinUsd?: number;
  largestLossUsd?: number;
  averageWinUsd?: number;
  averageLossUsd?: number;
}

type BacktestTierMode = "A" | "AB" | "ABC" | "ALL";
type Crash300AdmissionPolicyMode = "off" | "preview" | "enforce";

type Crash300AdmissionPolicyConfig = {
  enabled: boolean;
  mode: Crash300AdmissionPolicyMode;
  blockWrongDirectionWithTrigger: boolean;
  blockPostCrashRecoveryUp: boolean;
  blockUpRecovery10PlusPct: boolean;
  blockRecoveryUpOnDownMove: boolean;
  blockCrashDownOnUpMove: boolean;
};

type Crash300AdmissionPolicyPreset =
  | "off"
  | "preview_wrong_direction"
  | "enforce_wrong_direction"
  | "enforce_wrong_direction_plus_up_recovery_10_plus"
  | "enforce_wrong_direction_plus_post_crash_recovery"
  | "custom";

type V3BacktestJobStatus = {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  mode: string;
  tierMode: string;
  status: string;
  phase: string;
  progressPct: number;
  message?: string | null;
  errorSummary?: unknown;
  resultSummary?: Record<string, unknown> | null;
  persistedRunIds?: Record<string, number> | null;
  params?: Record<string, unknown> | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastHeartbeatAt?: string | null;
};

type EliteSynthesisSearchProfileUi = "fast" | "balanced" | "deep";
type EliteSynthesisTargetProfileUi = "default" | "return_amplification" | "return_first";

type EliteSynthesisJobStatusUi = {
  id: number;
  serviceId: string;
  symbol: string;
  status: string;
  stage: string;
  progressPct: number;
  currentPass?: number;
  maxPasses?: number;
  message?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  heartbeatAt?: string | null;
  windowDays?: number | null;
  searchProfile?: string | null;
  targetProfile?: string | null;
  displayState?: string | null;
  artifactStatus?: Record<string, unknown> | null;
  artifactDiagnostics?: string[] | null;
  resultSummary?: Record<string, unknown> | null;
  candidateRuntimeArtifactsCount?: number;
  baselineRecordsCount?: number;
};

function synthesisResultStateCode(job: EliteSynthesisJobStatusUi): string {
  if (job.resultSummary && typeof job.resultSummary === "object") {
    const code = String((job.resultSummary as Record<string, unknown>).resultState ?? "");
    if (code) return code;
  }
  return job.displayState ? String(job.displayState) : "";
}

function synthesisResultStateLabel(job: EliteSynthesisJobStatusUi): string {
  const resultState = synthesisResultStateCode(job);
  const resultSummary = job.resultSummary && typeof job.resultSummary === "object"
    ? job.resultSummary as Record<string, unknown>
    : {};
  const targetProfileNormalized = String(resultSummary.targetProfileNormalized ?? "");
  if (!resultState) return "n/a";
  switch (resultState) {
    case "completed_target_achieved":
      return "Completed - target achieved";
    case "completed_exhausted_no_target":
      return targetProfileNormalized === "return_first"
        ? "Completed - no return-first target found"
        : "Completed - target not achieved";
    case "completed_baseline_only":
      return "Completed - baseline only";
    case "completed_foundation_incomplete":
      return "Completed - foundation incomplete";
    case "completed_missing_artifact":
      return "Completed - artifact missing";
    case "failed_validation":
      return "Failed - validation";
    case "rebuilt_policy_evaluation_failed":
      return "Completed - rebuilt policy evaluation failed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    default:
      return resultState.replaceAll("_", " ");
  }
}

function synthesisStatusTone(job: EliteSynthesisJobStatusUi): string {
  const resultState = synthesisResultStateCode(job);
  if (resultState === "completed_missing_artifact" || resultState === "failed_validation") {
    return "bg-red-500/15 text-red-300 border-red-500/30";
  }
  if (job.status === "completed" && resultState === "completed_target_achieved") {
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  }
  if (job.status === "completed") {
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  }
  if (job.status === "failed" || job.status === "cancelled") {
    return "bg-red-500/15 text-red-300 border-red-500/30";
  }
  return "bg-cyan-500/15 text-cyan-200 border-cyan-500/30";
}

const BACKTEST_TIER_MODES: Array<{ value: BacktestTierMode; label: string }> = [
  { value: "A", label: "A only" },
  { value: "AB", label: "A+B" },
  { value: "ABC", label: "A+B+C" },
  { value: "ALL", label: "All tiers" },
];

const CRASH300_ADMISSION_POLICY_PRESETS: Array<{
  value: Crash300AdmissionPolicyPreset;
  label: string;
  config: Crash300AdmissionPolicyConfig;
}> = [
  {
    value: "off",
    label: "Baseline / Policy Off",
    config: {
      enabled: false,
      mode: "off",
      blockWrongDirectionWithTrigger: false,
      blockPostCrashRecoveryUp: false,
      blockUpRecovery10PlusPct: false,
      blockRecoveryUpOnDownMove: false,
      blockCrashDownOnUpMove: false,
    },
  },
  {
    value: "preview_wrong_direction",
    label: "Preview: wrong-direction block only",
    config: {
      enabled: true,
      mode: "preview",
      blockWrongDirectionWithTrigger: true,
      blockPostCrashRecoveryUp: false,
      blockUpRecovery10PlusPct: false,
      blockRecoveryUpOnDownMove: true,
      blockCrashDownOnUpMove: true,
    },
  },
  {
    value: "enforce_wrong_direction",
    label: "Enforce: wrong-direction block only",
    config: {
      enabled: true,
      mode: "enforce",
      blockWrongDirectionWithTrigger: true,
      blockPostCrashRecoveryUp: false,
      blockUpRecovery10PlusPct: false,
      blockRecoveryUpOnDownMove: true,
      blockCrashDownOnUpMove: true,
    },
  },
  {
    value: "enforce_wrong_direction_plus_up_recovery_10_plus",
    label: "Enforce: wrong-direction + block up|recovery|10_plus_pct",
    config: {
      enabled: true,
      mode: "enforce",
      blockWrongDirectionWithTrigger: true,
      blockPostCrashRecoveryUp: false,
      blockUpRecovery10PlusPct: true,
      blockRecoveryUpOnDownMove: true,
      blockCrashDownOnUpMove: true,
    },
  },
  {
    value: "enforce_wrong_direction_plus_post_crash_recovery",
    label: "Enforce: wrong-direction + block post_crash_recovery_up",
    config: {
      enabled: true,
      mode: "enforce",
      blockWrongDirectionWithTrigger: true,
      blockPostCrashRecoveryUp: true,
      blockUpRecovery10PlusPct: false,
      blockRecoveryUpOnDownMove: true,
      blockCrashDownOnUpMove: true,
    },
  },
];

const DEFAULT_CRASH300_ADMISSION_POLICY =
  CRASH300_ADMISSION_POLICY_PRESETS[0].config;

function cloneCrash300AdmissionPolicy(
  config: Crash300AdmissionPolicyConfig,
): Crash300AdmissionPolicyConfig {
  return { ...config };
}

function crash300AdmissionPolicyEquals(
  left: Crash300AdmissionPolicyConfig,
  right: Crash300AdmissionPolicyConfig,
) {
  return (
    left.enabled === right.enabled &&
    left.mode === right.mode &&
    left.blockWrongDirectionWithTrigger === right.blockWrongDirectionWithTrigger &&
    left.blockPostCrashRecoveryUp === right.blockPostCrashRecoveryUp &&
    left.blockUpRecovery10PlusPct === right.blockUpRecovery10PlusPct &&
    left.blockRecoveryUpOnDownMove === right.blockRecoveryUpOnDownMove &&
    left.blockCrashDownOnUpMove === right.blockCrashDownOnUpMove
  );
}

function elapsedLabel(startedAt: string | null) {
  if (!startedAt) return "n/a";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  return formatDurationCompact(Math.floor(ms / 1000));
}

function heartbeatAgeLabel(heartbeatAt: string | null) {
  if (!heartbeatAt) return "n/a";
  const ms = Date.now() - new Date(heartbeatAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  return `${Math.floor(ms / 1000)}s ago`;
}

function presetForCrash300AdmissionPolicy(
  config: Crash300AdmissionPolicyConfig,
): Crash300AdmissionPolicyPreset {
  return (
    CRASH300_ADMISSION_POLICY_PRESETS.find((preset) =>
      crash300AdmissionPolicyEquals(preset.config, config),
    )?.value ?? "custom"
  );
}

interface V3Result {
  symbol: string;
  tierMode?: BacktestTierMode;
  startTs: number;
  endTs: number;
  totalBars: number;
  runtimeModel?: {
    enabled?: boolean;
    applied?: boolean;
    reason?: string;
    useCalibratedRuntimeProfiles?: boolean;
    mode?: string | null;
    source?: string | null;
    sourceRunId?: number | null;
    entryModel?: string | null;
    tpBucketCount?: number;
    dynamicTpEnabled?: boolean;
    modelSourceCounts?: Record<string, number>;
  };
  trades: V3Trade[];
  moveOverlap?: {
    movesInWindow: number;
    capturedMoves: number;
    missedMoves: number;
    captureRate: number;
    ghostTrades: number;
    ghostTradeRate: number;
  };
  admissionPolicy?: {
    enabled: boolean;
    mode: Crash300AdmissionPolicyMode;
    config: Crash300AdmissionPolicyConfig;
    candidatesBlockedByAdmissionPolicy: number;
    blockedReasonsCounts: Record<string, number>;
    tradesWouldHaveBeenBlocked: number;
    winsBlocked: number | null;
    lossesBlocked: number | null;
    slHitsBlocked: number | null;
    resultingWinRate: number | null;
    resultingTradeCount: number | null;
  };
  summary: V3Summary;
}

interface PersistedV3BacktestHistoryRun {
  id: number;
  symbol: string;
  startTs: number;
  endTs: number;
  mode: string;
  tierMode: BacktestTierMode;
  runtimeModelRunId: number | null;
  summary: V3Summary;
  createdAt: string;
}

function isValidV3ResultShape(value: unknown): value is V3Result {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<V3Result>;
  return (
    typeof r.symbol === "string" &&
    Array.isArray(r.trades) &&
    typeof r.summary === "object" &&
    r.summary != null &&
    typeof r.totalBars === "number"
  );
}

function pct(v: number) {
  return (v * 100).toFixed(2) + "%";
}

function formatTs(ts: number) {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function holdLabel(bars: number) {
  const hours = bars / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function ExitReasonBadge({ reason }: { reason: string }) {
  const colors: Record<string, string> = {
    leg1_tp: "bg-green-500/15 text-green-400 border-green-500/25",
    hard_sl: "bg-red-500/15 text-red-400 border-red-500/25",
    mfe_reversal: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    trailing_stop: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    trailing_exit: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    protected_exit: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    tp_hit: "bg-green-500/15 text-green-400 border-green-500/25",
    sl_hit: "bg-red-500/15 text-red-400 border-red-500/25",
    max_duration: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  };
  const labels: Record<string, string> = {
    tp_hit: "TP Hit",
    sl_hit: "SL Hit",
    trailing_stop: "Protected Exit",
    trailing_exit: "Protected Exit",
    protected_exit: "Protected Exit",
    max_duration: "Max Duration",
    leg1_tp: "Leg 1 TP",
    hard_sl: "Hard SL",
    mfe_reversal: "MFE Reversal",
  };
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium border", colors[reason] ?? "bg-muted/30 text-muted-foreground border-border/30")}>
      {labels[reason] ?? reason.replace(/_/g, " ")}
    </span>
  );
}

function exitReasonSortValue(reason: string): number {
  const order = ["tp_hit", "protected_exit", "trailing_exit", "trailing_stop", "sl_hit", "max_duration"];
  const idx = order.indexOf(reason);
  return idx >= 0 ? idx : order.length;
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-lg bg-muted/20 border border-border/30">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-sm font-semibold font-mono">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function summarizeBacktestGroup(results: Record<string, V3Result>) {
  const rows = Object.values(results);
  const totals = rows.reduce((acc, result) => {
    const s = result.summary;
    acc.trades += s.tradeCount;
    acc.wins += s.winCount;
    acc.losses += s.lossCount;
    acc.totalPnlPct += s.totalPnlPct;
    acc.maxDrawdownPct = Math.max(acc.maxDrawdownPct, s.maxDrawdownPct);
    if (Number.isFinite(s.profitFactor)) {
      acc.profitFactorSum += s.profitFactor;
      acc.profitFactorCount += 1;
    }
    for (const [reason, count] of Object.entries(s.byExitReason ?? {})) {
      acc.exits[reason] = (acc.exits[reason] ?? 0) + count;
    }
    const overlap = result.moveOverlap;
    if (overlap) {
      acc.movesInWindow += overlap.movesInWindow;
      acc.capturedMoves += overlap.capturedMoves;
      acc.missedMoves += overlap.missedMoves;
      acc.ghostTrades += overlap.ghostTrades;
    }
    return acc;
  }, {
    trades: 0,
    wins: 0,
    losses: 0,
    totalPnlPct: 0,
    maxDrawdownPct: 0,
    profitFactorSum: 0,
    profitFactorCount: 0,
    exits: {} as Record<string, number>,
    movesInWindow: 0,
    capturedMoves: 0,
    missedMoves: 0,
    ghostTrades: 0,
  });

  return {
    ...totals,
    winRate: totals.trades > 0 ? totals.wins / totals.trades : 0,
    profitFactor: totals.profitFactorCount > 0 ? totals.profitFactorSum / totals.profitFactorCount : 0,
    captureRate: totals.movesInWindow > 0 ? totals.capturedMoves / totals.movesInWindow : 0,
    ghostTradeRate: totals.trades > 0 ? totals.ghostTrades / totals.trades : 0,
  };
}

function SymbolBacktestSection({ result }: { result: V3Result }) {
  const s = result.summary;
  const trades = result.trades;
  const [showAll, setShowAll] = useState(false);
  const displayTrades = showAll ? trades : trades.slice(0, 30);
  const runtime = result.runtimeModel;
    const scoringCounts = runtime?.modelSourceCounts ?? {};
  const runtimeApplied = runtime?.applied ?? runtime?.enabled ?? false;
  const runtimeReason = runtime?.reason ?? "unknown";
  const overlap = result.moveOverlap;
  const admissionPolicy = result.admissionPolicy;
  const showAdmissionPolicy =
    result.symbol === "CRASH300" &&
    admissionPolicy &&
    admissionPolicy.config;
  const startingCapitalUsd = s.capitalModel?.startingCapitalUsd ?? 600;

  return (
    <div className="space-y-4">
      {/* Summary grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SummaryCard label="Trades" value={String(s.tradeCount)} sub={`${s.winCount}W / ${s.lossCount}L`} />
        <SummaryCard label="Win rate" value={pct(s.winRate)} />
        <SummaryCard label="Avg Trade P&L" value={pct(s.averageTradePnlPct ?? s.avgPnlPct)} />
        <SummaryCard label="Summed Trade P&L" value={pct(s.summedTradePnlPct ?? s.totalPnlPct)} />
        <SummaryCard label="Account Return" value={pct(s.accountReturnPct ?? 0)} sub={`Estimated on $${startingCapitalUsd.toFixed(0)}`} />
        <SummaryCard label="Estimated Profit" value={`$${Number(s.netProfitUsd ?? 0).toFixed(2)}`} sub={`Ending $${Number(s.endingCapitalUsd ?? startingCapitalUsd).toFixed(2)}`} />
        <SummaryCard label="Profit factor" value={isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : ""} />
        <SummaryCard label="Account Drawdown" value={pct(s.accountMaxDrawdownPct ?? 0)} sub={`$${Number(s.maxDrawdownUsd ?? 0).toFixed(2)}`} />
        <SummaryCard label="Avg hold" value={holdLabel(s.avgHoldBars)} />
        <SummaryCard label="Leg1 hit rate" value={pct(s.leg1HitRate)} />
      </div>

      <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-xs">
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <span>
            <span className="text-muted-foreground">Runtime model: </span>
            <span className={runtimeApplied ? "text-emerald-300 font-semibold" : "text-red-300 font-semibold"}>
              {runtimeApplied ? runtime?.source ?? "enabled" : "not applied"}
            </span>
          </span>
          <span><span className="text-muted-foreground">Reason: </span>{runtimeReason.replace(/_/g, " ")}</span>
          <span>
            <span className="text-muted-foreground">Setting: </span>
            <span className={runtime?.useCalibratedRuntimeProfiles ? "text-emerald-300" : "text-red-300"}>
              use_calibrated_runtime_profiles={String(runtime?.useCalibratedRuntimeProfiles ?? false)}
            </span>
          </span>
          <span><span className="text-muted-foreground">Run: </span>{runtime?.sourceRunId ?? "none"}</span>
          <span><span className="text-muted-foreground">Entry: </span>{runtime?.entryModel ?? "service_default"}</span>
          <span><span className="text-muted-foreground">Tier mode: </span>{result.tierMode ?? "ALL"}</span>
          <span><span className="text-muted-foreground">Capital model: </span>${startingCapitalUsd.toFixed(0)} start @ {((s.capitalModel?.allocationPct ?? 0) * 100).toFixed(0)}% allocation</span>
          <span><span className="text-muted-foreground">Synthetic size: </span>${Number(s.capitalModel?.syntheticPositionSizeUsd ?? 0).toFixed(0)}</span>
          <span><span className="text-muted-foreground">Compounding: </span>{String(s.capitalModel?.compoundingEnabled ?? false)}</span>
          <span>
            <span className="text-muted-foreground">TP buckets: </span>
            <span className={runtime?.dynamicTpEnabled ? "text-emerald-300" : "text-amber-300"}>
              {runtime?.tpBucketCount ?? 0}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">Decision source: </span>
            {Object.keys(scoringCounts).length > 0
              ? Object.entries(scoringCounts).map(([k, v]) => `${k}=${v}`).join(", ")
              : "no signals"}
          </span>
        </div>
        {!runtimeApplied && (
          <div className="mt-2 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-red-200">
            This run is not using promoted runtime evidence yet. Results remain outside the promoted symbol-service runtime path until the runtime reason is "applied".
          </div>
        )}
      </div>

      {overlap && (
        <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              <span className="text-muted-foreground">Move capture: </span>
              <span className={overlap.captureRate >= 0.8 ? "text-emerald-300 font-semibold" : "text-amber-300 font-semibold"}>
                {overlap.capturedMoves}/{overlap.movesInWindow} ({pct(overlap.captureRate)})
              </span>
            </span>
            <span><span className="text-muted-foreground">Missed moves: </span>{overlap.missedMoves}</span>
            <span>
              <span className="text-muted-foreground">Outside calibrated moves: </span>
              <span className={overlap.ghostTradeRate <= 0.2 ? "text-emerald-300" : "text-red-300"}>
                {overlap.ghostTrades} ({pct(overlap.ghostTradeRate)})
              </span>
            </span>
          </div>
        </div>
      )}

      {showAdmissionPolicy && (
        <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-xs space-y-2">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              <span className="text-muted-foreground">Admission policy: </span>
              <span className={admissionPolicy.enabled ? "text-cyan-300 font-semibold" : "text-muted-foreground"}>
                {admissionPolicy.enabled ? "enabled" : "off"}
              </span>
            </span>
            <span><span className="text-muted-foreground">Mode: </span>{admissionPolicy.mode}</span>
            <span><span className="text-muted-foreground">Candidates blocked: </span>{admissionPolicy.candidatesBlockedByAdmissionPolicy}</span>
            <span><span className="text-muted-foreground">Trades would be blocked: </span>{admissionPolicy.tradesWouldHaveBeenBlocked}</span>
            <span><span className="text-muted-foreground">Wins blocked: </span>{admissionPolicy.winsBlocked ?? "n/a"}</span>
            <span><span className="text-muted-foreground">Losses blocked: </span>{admissionPolicy.lossesBlocked ?? "n/a"}</span>
            <span><span className="text-muted-foreground">SL hits blocked: </span>{admissionPolicy.slHitsBlocked ?? "n/a"}</span>
            <span>
              <span className="text-muted-foreground">Resulting win rate: </span>
              {typeof admissionPolicy.resultingWinRate === "number" ? pct(admissionPolicy.resultingWinRate) : "n/a"}
            </span>
            <span><span className="text-muted-foreground">Resulting trade count: </span>{admissionPolicy.resultingTradeCount ?? "n/a"}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(admissionPolicy.config)
              .filter(([key, value]) => key !== "enabled" && key !== "mode" && value === true)
              .map(([key]) => (
                <span
                  key={key}
                  className="inline-flex items-center rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200"
                >
                  {key}
                </span>
              ))}
            {Object.entries(admissionPolicy.config).every(([key, value]) => key === "enabled" || key === "mode" || value !== true) && (
              <span className="text-[11px] text-muted-foreground">No admission-policy block flags enabled for this run.</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(admissionPolicy.blockedReasonsCounts ?? {}).length > 0 ? (
              Object.entries(admissionPolicy.blockedReasonsCounts ?? {}).map(([reason, count]) => (
                <span
                  key={reason}
                  className="inline-flex items-center gap-1 rounded border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200"
                >
                  <span className="font-mono">{reason}</span>
                  <span className="text-cyan-100">{count}</span>
                </span>
              ))
            ) : (
              <span className="text-[11px] text-muted-foreground">No blocked reasons recorded for this run.</span>
            )}
          </div>
        </div>
      )}

      {/* By engine */}
      {Object.keys(s.byEngine).length > 0 && (
        <div className="rounded-lg border border-border/30 overflow-hidden">
          <div className="px-3 py-2 bg-muted/10 border-b border-border/20">
            <span className="text-[11px] font-medium text-muted-foreground">By engine</span>
          </div>
          <div className="divide-y divide-border/20">
            {Object.entries(s.byEngine).map(([engine, stats]) => (
              <div key={engine} className="px-3 py-2 flex items-center justify-between text-xs">
                <span className="font-mono text-muted-foreground truncate">{engine}</span>
                <div className="flex items-center gap-4 shrink-0">
                  <span>{stats.count} trades</span>
                  <span>{stats.wins}W</span>
                  <span className={stats.avgPnlPct >= 0 ? "text-green-400" : "text-red-400"}>
                    avg {pct(stats.avgPnlPct)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By exit reason */}
      {Object.keys(s.byExitReason).length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">Exits:</span>
          {Object.entries(s.byExitReason)
            .sort(([a], [b]) => exitReasonSortValue(a) - exitReasonSortValue(b))
            .map(([reason, count]) => (
            <span key={reason} className="flex items-center gap-1">
              <ExitReasonBadge reason={reason} />
              <span className="text-[10px] text-muted-foreground">{count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Trades table */}
      {trades.length > 0 && (
        <div className="rounded-lg border border-border/30 overflow-hidden">
          <div className="px-3 py-2 bg-muted/10 border-b border-border/20 flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              Trades ({trades.length})
            </span>
            {trades.length > 30 && (
              <button
                onClick={() => setShowAll(v => !v)}
                className="text-[11px] text-primary hover:underline"
              >
                {showAll ? "Show top 30" : `Show all ${trades.length}`}
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="border-b border-border/20 bg-muted/5 text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">Dir</th>
                  <th className="px-2 py-1.5 text-left font-medium">Engine</th>
                  <th className="px-2 py-1.5 text-left font-medium">Model Source</th>
                  <th className="px-2 py-1.5 text-left font-medium">Entry</th>
                  <th className="px-2 py-1.5 text-left font-medium">Exit</th>
                  <th className="px-2 py-1.5 text-right font-medium">Hold</th>
                  <th className="px-2 py-1.5 text-right font-medium">Entry $</th>
                  <th className="px-2 py-1.5 text-right font-medium">Exit $</th>
                  <th className="px-2 py-1.5 text-right font-medium">MFE</th>
                  <th className="px-2 py-1.5 text-right font-medium">MAE</th>
                  <th className="px-2 py-1.5 text-center font-medium">Exit</th>
                  <th className="px-2 py-1.5 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/10">
                {displayTrades.map((t, i) => (
                  <tr key={i} className="hover:bg-muted/10 transition-colors">
                    <td className="px-2 py-1.5">
                      <span className={cn("px-1 py-0.5 rounded text-[10px] font-medium",
                        t.direction === "buy" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400")}>
                        {t.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground max-w-[120px] truncate" title={t.engineName}>
                      {t.engineName.replace(/_engine$/, "").replace(/_/g, " ")}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground max-w-[140px] truncate" title={t.modelSource ?? "unknown"}>
                      {(t.modelSource ?? "unknown").replace(/_/g, " ")}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{formatTs(t.entryTs)}</td>
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{formatTs(t.exitTs)}</td>
                    <td className="px-2 py-1.5 text-right">{holdLabel(t.holdBars)}</td>
                    <td className="px-2 py-1.5 text-right">{t.entryPrice.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right">{t.exitPrice.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right text-green-400">{pct(t.mfePct)}</td>
                    <td className="px-2 py-1.5 text-right text-red-400">{pct(t.maePct)}</td>
                    <td className="px-2 py-1.5 text-center"><ExitReasonBadge reason={t.exitReason} /></td>
                    <td className={cn("px-2 py-1.5 text-right font-semibold",
                      t.pnlPct >= 0 ? "text-green-400" : "text-red-400")}>
                      {t.pnlPct >= 0 ? "+" : ""}{pct(t.pnlPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function BacktestTab({
  domain,
  windowDays,
  lockedSymbol,
}: {
  domain: DomainId;
  windowDays: number;
  lockedSymbol?: string;
}) {
  const backtestSymbols = BACKTEST_ACTIVE_SYMBOLS;

  const [symbol, setSymbol] = useState(lockedSymbol ?? backtestSymbols[0] ?? "all");
  const [tierMode, setTierMode] = useState<BacktestTierMode>("ALL");
  const [admissionPolicyPreset, setAdmissionPolicyPreset] =
    useState<Crash300AdmissionPolicyPreset>("off");
  const [admissionPolicyConfig, setAdmissionPolicyConfig] = useState<Crash300AdmissionPolicyConfig>(
    cloneCrash300AdmissionPolicy(DEFAULT_CRASH300_ADMISSION_POLICY),
  );
  const [running, setRunning] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<Record<string, V3Result> | null>(null);
  const [tierSweep, setTierSweep] = useState<Record<BacktestTierMode, Record<string, V3Result>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [historyRuns, setHistoryRuns] = useState<PersistedV3BacktestHistoryRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<number | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [latestPersistedRunIds, setLatestPersistedRunIds] = useState<Record<string, number>>({});
  const [historyRunLoadError, setHistoryRunLoadError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<V3BacktestJobStatus | null>(null);
  const [jobAdminDiagnostic, setJobAdminDiagnostic] = useState<string | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startingCapitalUsd = 600;

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  useEffect(() => {
    return () => { if (jobPollRef.current) clearInterval(jobPollRef.current); };
  }, []);

  useEffect(() => {
    if (!backtestSymbols.includes(symbol)) {
      setSymbol(backtestSymbols[0] ?? "all");
    }
  }, [domain, backtestSymbols, symbol]);

  useEffect(() => {
    if (symbol !== "CRASH300") {
      setAdmissionPolicyPreset("off");
      setAdmissionPolicyConfig(cloneCrash300AdmissionPolicy(DEFAULT_CRASH300_ADMISSION_POLICY));
    }
  }, [symbol]);

  const crash300PolicyRequest =
    symbol === "CRASH300"
      ? cloneCrash300AdmissionPolicy(admissionPolicyConfig)
      : undefined;

  useEffect(() => {
    if (lockedSymbol && symbol !== lockedSymbol) {
      setSymbol(lockedSymbol);
    }
  }, [lockedSymbol, symbol]);

  const setAdmissionPolicyPresetValue = (presetValue: Crash300AdmissionPolicyPreset) => {
    setAdmissionPolicyPreset(presetValue);
    if (presetValue === "custom") return;
    const preset = CRASH300_ADMISSION_POLICY_PRESETS.find((item) => item.value === presetValue);
    if (preset) {
      setAdmissionPolicyConfig(cloneCrash300AdmissionPolicy(preset.config));
    }
  };

  const updateAdmissionPolicyToggle = (
    key: keyof Crash300AdmissionPolicyConfig,
    value: boolean,
  ) => {
    setAdmissionPolicyConfig((prev) => {
      const next = { ...prev, [key]: value };
      const matchedPreset = presetForCrash300AdmissionPolicy(next);
      setAdmissionPolicyPreset(matchedPreset);
      if (matchedPreset !== "custom") {
        return cloneCrash300AdmissionPolicy(
          CRASH300_ADMISSION_POLICY_PRESETS.find((preset) => preset.value === matchedPreset)?.config ?? next,
        );
      }
      return next;
    });
  };

  const loadBacktestHistory = async (sym = symbol, silent = false) => {
    if (!sym || sym === "all") {
      setHistoryRuns([]);
      return;
    }
    if (!silent) setHistoryLoading(true);
    try {
      const d = await apiFetch(`backtest/v3/history?symbol=${encodeURIComponent(sym)}&limit=30`) as { runs?: PersistedV3BacktestHistoryRun[] };
      setHistoryRuns(Array.isArray(d.runs) ? d.runs : []);
    } catch {
      if (!silent) setHistoryRuns([]);
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  };

  const loadBacktestHistoryRun = async (runId: number) => {
    setErr(null);
    setHistoryRunLoadError(null);
    setSelectedHistoryRunId(runId);
    try {
      const d = await apiFetch(`backtest/v3/history/${runId}`) as { run?: { symbol?: string; result?: V3Result } };
      const run = d.run;
      if (!run?.symbol || !isValidV3ResultShape(run.result)) {
        throw new Error(`Run ${runId} has malformed or empty persisted result data.`);
      }
      const selectedSymbol = String(run.symbol);
      setSymbol(selectedSymbol);
      setTierMode(run.result.tierMode ?? "ALL");
      if (selectedSymbol === "CRASH300" && run.result.admissionPolicy?.config) {
        const nextConfig = cloneCrash300AdmissionPolicy(run.result.admissionPolicy.config);
        setAdmissionPolicyConfig(nextConfig);
        setAdmissionPolicyPreset(presetForCrash300AdmissionPolicy(nextConfig));
      } else {
        setAdmissionPolicyConfig(cloneCrash300AdmissionPolicy(DEFAULT_CRASH300_ADMISSION_POLICY));
        setAdmissionPolicyPreset("off");
      }
      setResults({ [selectedSymbol]: run.result });
      setTierSweep(null);
    } catch (e: any) {
      const msg = e?.message ?? "Failed to load selected backtest run";
      setHistoryRunLoadError(msg);
      setErr(msg);
      setResults(null);
      setTierSweep(null);
    }
  };

  useEffect(() => {
    void loadBacktestHistory(symbol);
  }, [symbol]);

  useEffect(() => {
    setHistoryExpanded(false);
  }, [symbol]);

  const shouldUseAsyncBacktest = symbol === "CRASH300" && windowDays >= 60;

  const stopRunTimers = () => {
    setRunning(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const stopJobPolling = () => {
    if (jobPollRef.current) {
      clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    }
  };

  const pollBacktestJob = (jobId: number, targetSymbol: string) => {
    stopJobPolling();
    const tick = async () => {
      try {
        const statusResp = await apiFetch(`backtest/v3/jobs/${jobId}`) as { job?: V3BacktestJobStatus };
        const job = statusResp.job ?? null;
        setActiveJob(job);
        if (!job) return;
        if (job.status === "completed") {
          stopJobPolling();
          stopRunTimers();
          try {
            const resultResp = await apiFetch(`backtest/v3/jobs/${jobId}/result`) as {
              result?: {
                persistedRunIds?: Record<string, number>;
                summaryBySymbol?: Record<string, unknown>;
              };
            };
            const persisted = resultResp.result?.persistedRunIds ?? {};
            setLatestPersistedRunIds(persisted);
            await loadBacktestHistory(targetSymbol, true);
            const runId = persisted[targetSymbol];
            if (runId) {
              await loadBacktestHistoryRun(runId);
            } else {
              setJobAdminDiagnostic(`Backtest job ${jobId} completed, but no persisted run id was returned for ${targetSymbol}.`);
            }
          } catch (e: any) {
            setJobAdminDiagnostic(e?.message ?? `Backtest job ${jobId} completed, but persisted result retrieval failed.`);
          }
          return;
        }
        if (job.status === "failed") {
          stopJobPolling();
          stopRunTimers();
          setErr(String(job.message ?? "Long backtest failed"));
        }
      } catch (e: any) {
        stopJobPolling();
        stopRunTimers();
        setJobAdminDiagnostic(e?.message ?? "Failed to poll long backtest job");
      }
    };
    void tick();
    jobPollRef.current = setInterval(() => { void tick(); }, 2000);
  };

  const run = async () => {
    setRunning(true);
    setErr(null);
    setHistoryRunLoadError(null);
    setJobAdminDiagnostic(null);
    setResults(null);
    setTierSweep(null);
    setActiveJob(null);
    setElapsed(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      const { startTs, endTs } = getWindowRange(windowDays);
      const body: Record<string, unknown> = { symbol, startTs, endTs, tierMode, startingCapitalUsd };
      if (crash300PolicyRequest) body.crash300AdmissionPolicy = crash300PolicyRequest;

      if (shouldUseAsyncBacktest) {
        const d = await apiFetch("backtest/v3/run-async", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }) as { jobId?: number };
        const jobId = Number(d.jobId ?? 0);
        if (!Number.isInteger(jobId) || jobId <= 0) {
          throw new Error("Long backtest did not return a valid job id.");
        }
        pollBacktestJob(jobId, symbol);
        return;
      }

      const d = await apiFetch("backtest/v3/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setResults(d.results as Record<string, V3Result>);
      setLatestPersistedRunIds((d.persistedRunIds as Record<string, number> | undefined) ?? {});
      await loadBacktestHistory(symbol, true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      if (!shouldUseAsyncBacktest) {
        stopRunTimers();
      }
    }
  };

  const runTierSweep = async () => {
    setSweeping(true);
    setErr(null);
    setHistoryRunLoadError(null);
    setResults(null);
    setTierSweep(null);
    setElapsed(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      const { startTs, endTs } = getWindowRange(windowDays);
      const sweep = {} as Record<BacktestTierMode, Record<string, V3Result>>;

      for (const mode of BACKTEST_TIER_MODES.map(item => item.value)) {
        const body: Record<string, unknown> = { symbol, startTs, endTs, tierMode: mode, startingCapitalUsd };
        if (crash300PolicyRequest) body.crash300AdmissionPolicy = crash300PolicyRequest;
        const d = await apiFetch("backtest/v3/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        sweep[mode] = d.results as Record<string, V3Result>;
        setLatestPersistedRunIds((d.persistedRunIds as Record<string, number> | undefined) ?? {});
      }

      setTierSweep(sweep);
      setResults(sweep[tierMode] ?? sweep.ALL);
      await loadBacktestHistory(symbol, true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSweeping(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const totalTrades = results
    ? Object.values(results).reduce((s, r) => s + r.trades.length, 0)
    : null;

  function downloadJson(data: unknown, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function toTradeExportShape(trade: V3Trade, exportSymbol: string): V3TradeExport & { symbol: string } {
    return {
      ...trade,
      symbol: exportSymbol,
    };
  }

  function exportSummary() {
    if (!results) return;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const summary = {
      exported_at: new Date().toISOString(),
      params: {
        symbol,
        tierMode,
        ...getWindowRange(windowDays),
        decisionGate: "runtime-platform-state",
        startingCapitalUsd,
        crash300AdmissionPolicy: crash300PolicyRequest ?? null,
      },
      symbols: Object.fromEntries(
        Object.entries(results).map(([sym, r]) => [sym, {
          totalBars: r.totalBars,
          runtimeModel: r.runtimeModel ?? null,
          admissionPolicy: r.admissionPolicy ?? null,
          summary: r.summary,
          totalTrades: r.trades.length,
          wins: r.trades.filter(t => t.pnlPct > 0).length,
          losses: r.trades.filter(t => t.pnlPct <= 0).length,
          winRate: r.trades.length > 0
            ? +((r.trades.filter(t => t.pnlPct > 0).length / r.trades.length) * 100).toFixed(1)
            : 0,
          avgPnlPct: r.trades.length > 0
            ? +(r.trades.reduce((s, t) => s + t.pnlPct, 0) / r.trades.length).toFixed(2)
            : 0,
          avgRuntimeEvidence: r.trades.length > 0
            ? +(r.trades.reduce((s, t) => s + (t.runtimeEvidence ?? 0), 0) / r.trades.length).toFixed(1)
            : 0,
          bestTrade: r.trades.length > 0
            ? +(Math.max(...r.trades.map(t => t.pnlPct))).toFixed(2)
            : 0,
          worstTrade: r.trades.length > 0
            ? +(Math.min(...r.trades.map(t => t.pnlPct))).toFixed(2)
            : 0,
        }])
      ),
    };
    downloadJson(summary, `bt-summary-${timestamp}.json`);
  }

  function exportTrades() {
    if (!results) return;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const allTrades = Object.entries(results).flatMap(([sym, r]) =>
      r.trades.map(t => ({ ...t, symbol: sym }))
    ).sort((a, b) => (a.entryTs ?? 0) - (b.entryTs ?? 0));
    downloadJson({
      exported_at: new Date().toISOString(),
      params: {
        symbol,
        tierMode,
        ...getWindowRange(windowDays),
        decisionGate: "runtime-platform-state",
        startingCapitalUsd,
        crash300AdmissionPolicy: crash300PolicyRequest ?? null,
      },
      admissionPolicyBySymbol: Object.fromEntries(
        Object.entries(results).map(([sym, r]) => [sym, r.admissionPolicy ?? null]),
      ),
      summaryBySymbol: Object.fromEntries(
        Object.entries(results).map(([sym, r]) => [sym, r.summary]),
      ),
      total_trades: allTrades.length,
      trades: allTrades.map(trade => toTradeExportShape(trade, trade.symbol)),
    }, `bt-trades-${timestamp}.json`);
  }

  async function exportAttribution() {
    if (symbol !== "CRASH300") {
      setErr("Trade-outcome attribution export is currently available for CRASH300 only.");
      return;
    }
    const runId = selectedHistoryRunId ?? latestPersistedRunIds.CRASH300;
    if (!runId) {
      setErr("Run a CRASH300 backtest or select a persisted CRASH300 run before exporting attribution.");
      return;
    }
    try {
      setErr(null);
      const data = await apiFetch(`backtest/v3/history/${runId}/attribution`) as { report?: unknown };
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      downloadJson(data.report ?? data, `bt-attribution-CRASH300-${timestamp}.json`);
    } catch (e: any) {
      setErr(`Attribution export failed: ${e?.message ?? "Unknown error"}`);
    }
  }

  async function exportCalibrationReconciliation() {
    if (symbol !== "CRASH300") {
      setErr("Calibration reconciliation export is currently available for CRASH300 only.");
      return;
    }
    const runId = selectedHistoryRunId ?? latestPersistedRunIds.CRASH300;
    if (!runId) {
      setErr("Run a CRASH300 backtest or select a persisted CRASH300 run before exporting calibration reconciliation.");
      return;
    }
    try {
      setErr(null);
      const data = await apiFetch(`backtest/v3/history/${runId}/calibration-reconciliation`) as { report?: unknown };
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      downloadJson(data.report ?? data, `bt-calibration-reconciliation-CRASH300-${timestamp}.json`);
    } catch (e: any) {
      setErr(`Calibration reconciliation export failed: ${e?.message ?? "Unknown error"}`);
    }
  }

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Validate Runtime</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Backtest replays selected service runtime logic against historical candles.
            Backtest, parity, trigger, and optimiser checks are internal validation stages in the simplified workflow.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">{lockedSymbol ? "Service" : "Symbol"}</label>
            {lockedSymbol ? (
              <div className="w-full text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">
                {getSymbolLabel(lockedSymbol)}
              </div>
            ) : (
              <select
                value={symbol}
                onChange={e => setSymbol(e.target.value)}
                className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
              >
                {backtestSymbols.map(s => (
                  <option key={s} value={s}>
                    {s === "all" ? "All active services" : getSymbolLabel(s)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Window</label>
            <div className="w-full text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">
              {windowLabel(windowDays)} (shared)
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Range</label>
            <div className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground font-mono">
              {getWindowRange(windowDays).startDateStr}  {getWindowRange(windowDays).endDateStr}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Run</label>
            <button
              onClick={run}
              disabled={running || sweeping}
              className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {running
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <BarChart2 className="w-3.5 h-3.5" />}
              {running ? `Running ${formatDurationCompact(elapsed)}` : "Validate Runtime"}
            </button>
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-[11px] text-muted-foreground">
            Heavy exports and trade-level artifacts live under <span className="text-foreground font-medium">Reports</span>.
          </div>
        </div>

        <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-[11px] text-muted-foreground">
          Manual tier sweeps and admission-policy diagnostics are internal validation details and export through <span className="text-foreground font-medium">Reports</span>.
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {results !== null && totalTrades !== null && totalTrades > 0 && (
            <>
              <button
                onClick={exportSummary}
                className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Export Summary JSON
              </button>
              <button
                onClick={exportTrades}
                className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Export Trades JSON
              </button>
              {symbol === "CRASH300" && (
                <>
                  <button
                    onClick={() => void exportAttribution()}
                    className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
                    title="Export deterministic CRASH300 trade-outcome attribution for the selected or latest persisted backtest run"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Attribution JSON
                  </button>
                  <button
                    onClick={() => void exportCalibrationReconciliation()}
                    className="flex items-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border transition-colors"
                    title="Export CRASH300 trade-vs-calibration reconciliation for the selected or latest persisted backtest run"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Calibration Reconciliation JSON
                  </button>
                </>
              )}
            </>
          )}

          {(running || sweeping) && (
            <p className="text-xs text-muted-foreground">
              {shouldUseAsyncBacktest
                ? "Queued long-window backtest. The UI will poll progress and load the persisted run when it completes."
                : "Loading candles and replaying bars  this may take up to 2 minutes for all symbols."}
            </p>
          )}

        </div>

        {activeJob && (
          <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-cyan-100">Long Backtest Job #{activeJob.id}</p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {activeJob.symbol}  {windowLabel(windowDays)}  {activeJob.phase}  {activeJob.status}
                </p>
              </div>
              <span className="text-xs font-mono text-cyan-200">{Number(activeJob.progressPct ?? 0)}%</span>
            </div>
            <div className="h-2 rounded bg-background/70 overflow-hidden">
              <div
                className="h-full bg-cyan-400 transition-all duration-300"
                style={{ width: `${Math.max(0, Math.min(100, Number(activeJob.progressPct ?? 0)))}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span>Message: <span className="text-foreground">{activeJob.message ?? "Processing"}</span></span>
              <span>Heartbeat: <span className="text-foreground">{activeJob.lastHeartbeatAt ? new Date(activeJob.lastHeartbeatAt).toLocaleTimeString() : "n/a"}</span></span>
              {activeJob.completedAt && (
                <span>Completed: <span className="text-foreground">{new Date(activeJob.completedAt).toLocaleTimeString()}</span></span>
              )}
            </div>
          </div>
        )}

        {jobAdminDiagnostic && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-amber-200">Backtest job admin diagnostic</p>
            <p className="text-[11px] text-amber-100/90 mt-1">{jobAdminDiagnostic}</p>
          </div>
        )}

        {err && <ErrorBox msg={err} />}
        {historyRunLoadError && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-amber-200">Backtest run could not be loaded</p>
            <p className="text-[11px] text-amber-100/90 mt-1">
              {historyRunLoadError}
            </p>
            <p className="text-[11px] text-amber-100/80 mt-1">
              Select another run or execute a fresh backtest to regenerate valid artifacts.
            </p>
          </div>
        )}

        <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Run History</span>
              {historyRuns.length > 0 && (
                <span className="text-[11px] text-muted-foreground">({historyRuns.length} runs)</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                if (!historyExpanded) void loadBacktestHistory(symbol);
                setHistoryExpanded(v => !v);
              }}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {historyExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {historyExpanded ? "Hide history" : "Show history"}
            </button>
          </div>

          {historyExpanded && (
            <div className="space-y-2">
              {historyLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />Loading run history
                </div>
              )}
              {!historyLoading && symbol === "all" && (
                <p className="text-xs text-muted-foreground">Select a service to inspect persisted backtest runs.</p>
              )}
              {!historyLoading && symbol !== "all" && historyRuns.length === 0 && (
                <p className="text-xs text-muted-foreground">No persisted backtest runs recorded yet for {symbol}.</p>
              )}
              {!historyLoading && historyRuns.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-border/30 text-muted-foreground">
                        <th className="text-left py-2 pr-3 font-medium">ID</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-left px-3 py-2 font-medium">Trades</th>
                        <th className="text-left px-3 py-2 font-medium">WR</th>
                        <th className="text-left px-3 py-2 font-medium">PF</th>
                        <th className="text-left px-3 py-2 font-medium">Started</th>
                        <th className="text-left px-3 py-2 font-medium">Use</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRuns.map(run => {
                        const summaryRecord = asUiRecord(run.summary);
                        const tradeCount = Number(summaryRecord.totalTrades ?? summaryRecord.tradeCount ?? 0);
                        const isSelected = selectedHistoryRunId === run.id;
                        return (
                          <tr key={run.id} className={cn("border-b border-border/10 last:border-b-0", isSelected && "bg-primary/5")}>
                            <td className="py-2 pr-3 text-foreground font-medium">#{run.id}</td>
                            <td className="px-3 py-2">
                              <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
                                completed
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{tradeCount}</td>
                            <td className="px-3 py-2 text-muted-foreground">{pct(Number(run.summary?.winRate ?? 0))}</td>
                            <td className="px-3 py-2 text-muted-foreground">{Number(run.summary?.profitFactor ?? 0).toFixed(2)}</td>
                            <td className="px-3 py-2 text-muted-foreground">{formatRuntimeDate(run.createdAt)}</td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => void loadBacktestHistoryRun(run.id)}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors",
                                  isSelected
                                    ? "border-primary/30 bg-primary/10 text-primary"
                                    : "border-border/40 bg-background text-muted-foreground hover:text-foreground hover:border-border",
                                )}
                              >
                                {isSelected ? "Selected" : "Load run"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {results !== null && (
        <div className="space-y-5">
          {tierSweep && (
            <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-4 overflow-x-auto">
              <h3 className="text-sm font-semibold text-cyan-100 mb-3">Tier Sweep Comparison</h3>
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="text-muted-foreground border-b border-cyan-500/20">
                    <th className="text-left py-2 pr-3 font-medium">Mode</th>
                    <th className="text-right py-2 px-3 font-medium">Trades</th>
                    <th className="text-right py-2 px-3 font-medium">Win rate</th>
                    <th className="text-right py-2 px-3 font-medium">Summed Trade P&L</th>
                    <th className="text-right py-2 px-3 font-medium">Drawdown</th>
                    <th className="text-right py-2 px-3 font-medium">PF</th>
                    <th className="text-right py-2 px-3 font-medium">Captured</th>
                    <th className="text-right py-2 px-3 font-medium">Ghost</th>
                    <th className="text-left py-2 pl-3 font-medium">Exits</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cyan-500/10">
                  {BACKTEST_TIER_MODES.map(mode => {
                    const summary = summarizeBacktestGroup(tierSweep[mode.value] ?? {});
                    return (
                      <tr key={mode.value} className={mode.value === tierMode ? "bg-cyan-500/10" : ""}>
                        <td className="py-2 pr-3 font-semibold text-cyan-100">{mode.label}</td>
                        <td className="py-2 px-3 text-right">{summary.trades}</td>
                        <td className="py-2 px-3 text-right">{pct(summary.winRate)}</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", summary.totalPnlPct >= 0 ? "text-green-400" : "text-red-400")}>
                          {summary.totalPnlPct >= 0 ? "+" : ""}{pct(summary.totalPnlPct)}
                        </td>
                        <td className="py-2 px-3 text-right">{pct(summary.maxDrawdownPct)}</td>
                        <td className="py-2 px-3 text-right">{summary.profitFactor.toFixed(2)}</td>
                        <td className="py-2 px-3 text-right">
                          {summary.capturedMoves}/{summary.movesInWindow} ({pct(summary.captureRate)})
                        </td>
                        <td className="py-2 px-3 text-right">
                          {summary.ghostTrades} ({pct(summary.ghostTradeRate)})
                        </td>
                        <td className="py-2 pl-3">
                          {Object.entries(summary.exits)
                            .sort(([a], [b]) => exitReasonSortValue(a) - exitReasonSortValue(b))
                            .map(([reason, count]) => `${reason}:${count}`)
                            .join("  ")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {totalTrades === 0 ? (
            <div className="rounded-xl border border-border/30 bg-card p-6 text-center">
              <BarChart2 className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">0 trades returned</p>
              <p className="text-xs text-muted-foreground mt-1">
                No signals passed engine gates in the selected range ({getWindowRange(windowDays).startDateStr}  {getWindowRange(windowDays).endDateStr}).
                Check the runtime wiring, promoted model, and mode/symbol settings before changing engine logic.
              </p>
            </div>
          ) : (
            Object.entries(results).map(([sym, result]) => (
              result.trades.length > 0 && (
                <div key={sym} className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
                  <div className="flex items-center gap-2 border-b border-border/20 pb-3">
                    <ChevronRight className="w-4 h-4 text-primary" />
                    <h3 className="text-sm font-semibold">{sym}</h3>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {result.totalBars.toLocaleString()} bars  {result.trades.length} trades
                    </span>
                  </div>
                  <SymbolBacktestSection result={result} />
                </div>
              )
            ))
          )}

          {/* Symbols with 0 trades */}
          {Object.entries(results).filter(([, r]) => r.trades.length === 0).map(([sym, r]) => (
            <div key={sym} className="rounded-xl border border-border/30 bg-card p-3 flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground">{sym}</span>
              <span className="text-xs text-muted-foreground">
                 {r.totalBars.toLocaleString()} bars processed, 0 trades
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

//  Move Calibration support types 

interface BehaviorOverview {
  symbol: string;
  totalTrades: number;
  totalSignalsFired: number;
  totalBlocked: number;
  overallWinRate: number;
  overallBlockedRate: number;
  recommendedScanCadenceMins: number;
  lastUpdated: string;
  engineProfiles?: Array<{
    engineName: string;
    tradeCount: number;
    winRate: number;
    avgPnlPct: number;
    signalFrequencyPerDay: number;
    sampleDays: number;
  }>;
}

interface ProfitabilityPath {
  name: string;
  estimatedMonthlyReturnPct: number;
  captureablePct: number;
  holdDays: number;
  confidence: string;
}

interface CalibrationProfile {
  id: number;
  symbol: string;
  moveType: string;
  windowDays: number;
  targetMoves: number;
  capturedMoves: number;
  missedMoves: number;
  fitScore: number;
  missReasons: Array<{ reason: string; count: number }> | null;
  avgMovePct: number;
  medianMovePct: number;
  avgHoldingHours: number;
  avgCaptureablePct: number;
  avgHoldabilityScore: number;
  engineCoverage: unknown | null;
  precursorSummary: unknown | null;
  triggerSummary: unknown | null;
  feeddownSchema: unknown | null;
  profitabilitySummary: {
    paths: ProfitabilityPath[];
    topPath: string;
    estimatedFitAdjustedReturn: number;
  } | null;
  lastRunId: number | null;
  generatedAt: string;
}

interface PassRun {
  id: number;
  symbol: string;
  passName: string;
  status: string;
  totalMoves: number;
  processedMoves: number;
  failedMoves: number;
  windowDays: number;
  startedAt: string;
  completedAt?: string | null;
  metaJson?: Record<string, unknown> | null;
}

interface SymbolResearchProfileUi {
  lastRunId?: number;
  moveCount?: number;
  moveFamilyDistribution?: Record<string, number>;
  estimatedTradesPerMonth?: number;
  recommendedHoldProfile?: Record<string, unknown>;
  recommendedScanIntervalSeconds?: number;
  recommendedEntryModel?: string;
  recommendedTpModel?: Record<string, unknown>;
  recommendedSlModel?: Record<string, unknown>;
  recommendedLifecycleProtectionModel?: Record<string, unknown>;
  recommendedTrailingModel?: Record<string, unknown>;
  estimatedFitAdjustedMonthlyReturnPct?: number;
  engineTypeRecommendation?: string;
  researchStatus?: string;
}

interface RuntimeSymbolModelUi {
  sourceRunId?: number;
  entryModel?: string;
  tpModel?: Record<string, unknown>;
  recommendedScoreGates?: Record<string, number>;
  expectedTradesPerMonth?: number;
  recommendedScanIntervalSeconds?: number;
  promotedAt?: string;
  suggestedAt?: string;
}

interface RuntimeModelStateUi {
  researchProfile?: SymbolResearchProfileUi | null;
  stagedModel?: RuntimeSymbolModelUi | null;
  promotedModel?: RuntimeSymbolModelUi | null;
  lifecycle?: {
    hasResearchProfile?: boolean;
    hasStagedModel?: boolean;
    hasPromotedModel?: boolean;
    latestRunId?: number | null;
    stagedRunId?: number | null;
    promotedRunId?: number | null;
    runtimeSource?: string;
    stagedAt?: string | null;
    promotedAt?: string | null;
    stagedOptimisationRunId?: number | null;
    promotedOptimisationRunId?: number | null;
    stagedOptimisationCandidateId?: number | null;
    promotedOptimisationCandidateId?: number | null;
    promotedMatchesStaged?: boolean;
    stagedTpBucketCount?: number;
    promotedTpBucketCount?: number;
    stagedDynamicTpEnabled?: boolean;
    promotedDynamicTpEnabled?: boolean;
    driftPendingPromotion?: boolean;
  };
}

interface ServiceLifecycleStatusUi {
  serviceId: string;
  symbol: string;
  dataCoverageStatus: "not_ready" | "stale" | "ready";
  latestCandleTs: string | null;
  streamState: "active" | "inactive";
  calibrationStatus: "not_run" | "complete";
  latestCalibrationRunId: number | null;
  synthesisStatus: string;
  latestSynthesisJobId: number | null;
  stagedCandidateArtifactId: string | null;
  stagedCandidateSourceRunId: number | null;
  promotedRuntimeArtifactId: string | null;
  promotedRuntimeVersion: string | null;
  promotedRuntimeSourcePolicyId: string | null;
  runtimeValidationStatus: "not_run" | "running" | "passed" | "failed";
  parityStatus: "not_run" | "running" | "passed" | "failed";
  triggerValidationStatus: "not_run" | "running" | "passed" | "failed";
  activeMode: "paper" | "demo" | "real" | "idle" | "multi";
  executionAllowedForActiveMode: boolean;
  allocatorConnected: boolean;
  latestScannerStatus?: string | null;
  latestScannerReason?: string | null;
  latestScannerAt?: string | null;
  nextRequiredAction: string;
  workflowStages?: Array<{
    label: string;
    status: "complete" | "incomplete" | "blocked" | "warning";
    sourceRunId: string | number | null;
    timestamp: string | null;
    nextAction: string | null;
    blockers: string[];
  }>;
  blockers: string[];
  warnings: string[];
}

interface ServicePromotedRuntimeUi {
  artifactId: string;
  version: string;
  sourceCandidateArtifactId?: string | null;
  sourceSynthesisJobId?: number | null;
  sourcePolicyId: string | null;
  promotedAt: string;
  runtimeFamily: string | null;
  triggerTransition: string | null;
  selectedBucket: string | null;
  selectedMoveSizeBucket: string | null;
  direction: "buy" | "sell" | null;
  expectedPerformance?: Record<string, unknown>;
  validationStatus?: {
    runtimeValidationStatus?: string;
    parityStatus?: string;
    triggerValidationStatus?: string;
    runtimeMimicReady?: boolean;
  };
  warnings?: string[];
  allowedModes?: {
    paper?: boolean;
    demo?: boolean;
    real?: boolean;
  };
}

interface ResearchDataStatusUi {
  symbols: Array<{
    symbol: string;
    tier: string;
    count1m: number;
    count5m: number;
    totalCandles: number;
    oldestDate: string | null;
    newestDate: string | null;
    lastBacktestDate: string | null;
    status: string;
  }>;
  totalStorage: number;
  symbolCount: number;
}

interface ParityDiagnosticsUi {
  failureReasonCounts?: Record<string, number>;
  selectedRuntimeFamilyCounts?: Record<string, number>;
  selectedBucketCounts?: Record<string, number>;
  directionMatrixCounts?: Record<string, number>;
  noCoordinatorOutput?: number;
  runtimeCalibratedSetupWeak?: number;
  gateComponentFailures?: Record<string, number>;
}

interface ParityReportUi {
  generatedAt?: string;
  promotedModelRunId?: number | null;
  stagedModelRunId?: number | null;
  totals?: {
    totalMoves?: number;
    matchedMoves?: number;
    noCandidate?: number;
    familyMismatch?: number;
    directionMismatch?: number;
    bucketMismatch?: number;
    setupEvidenceFailed?: number;
    runtimeModelMissing?: number;
    invalidRuntimeModel?: number;
  };
  diagnostics?: ParityDiagnosticsUi;
  verdicts?: Array<Record<string, unknown>>;
}

//  Move Calibration Tab 

const CALIB_ACTIVE_SYMBOLS: string[] = [...ACTIVE_SYMBOLS];
const PASS_NAMES = ["all", "enrichment", "family_inference", "model_synthesis"];
const MOVE_TYPES_FILTER_GENERIC = [
  "all",
  "breakout",
  "continuation",
  "reversal",
  "spike_cluster_recovery",
  "exhaustion",
  "drift_recovery",
  "uncategorized_emerging_pattern",
  "unknown",
];
function moveTypesFilterForSymbol(sym: string): string[] {
  if (sym === "BOOM300") return ["all", "boom_expansion"];
  if (sym === "CRASH300") return ["all", "crash_expansion"];
  return MOVE_TYPES_FILTER_GENERIC;
}
function strategyFamiliesForSymbol(sym: string): string[] {
  if (sym === "BOOM300") return ["all", "boom_expansion"];
  if (sym === "CRASH300") return ["all", "crash_expansion"];
  return [
    "all",
    "reversal",
    "continuation",
    "breakout",
    "spike_cluster_recovery",
    "exhaustion",
    "drift_recovery",
    "uncategorized_emerging_pattern",
  ];
}
const TIERS = ["A", "B", "C", "D"];
const TIER_COLORS: Record<string, string> = {
  A: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
  B: "text-sky-400 bg-sky-500/10 border-sky-500/25",
  C: "text-amber-400 bg-amber-500/10 border-amber-500/25",
  D: "text-red-400 bg-red-500/10 border-red-500/25",
};
const TYPE_COLORS: Record<string, string> = {
  breakout:     "text-purple-400 bg-purple-500/10 border-purple-500/25",
  continuation: "text-sky-400 bg-sky-500/10 border-sky-500/25",
  reversal:     "text-amber-400 bg-amber-500/10 border-amber-500/25",
  unknown:      "text-muted-foreground bg-muted/20 border-border/30",
  boom_expansion: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
  crash_expansion: "text-rose-400 bg-rose-500/10 border-rose-500/25",
  spike_cluster_recovery: "text-indigo-300 bg-indigo-500/10 border-indigo-500/25",
  exhaustion: "text-orange-300 bg-orange-500/10 border-orange-500/25",
  drift_recovery: "text-cyan-300 bg-cyan-500/10 border-cyan-500/25",
  uncategorized_emerging_pattern: "text-slate-300 bg-slate-500/10 border-slate-500/25",
};

function formatMoveTypeLabel(type: string): string {
  if (type === "boom_expansion") return "Boom Expansion";
  if (type === "crash_expansion") return "Crash Expansion";
  if (type === "spike_cluster_recovery") return "Spike Cluster Recovery";
  if (type === "drift_recovery") return "Drift Recovery";
  if (type === "uncategorized_emerging_pattern") return "Uncategorized Emerging Pattern";
  return type;
}

function TierPill({ tier }: { tier: string }) {
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
      {tier}
    </span>
  );
}

function formatRuntimeDate(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function formatOptionalDecimal(value: unknown, digits = 2): string {
  if (value == null || value === "") return "not estimated";
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toFixed(digits) : "not estimated";
}

function formatOptionalPct(value: unknown, digits = 2): string {
  if (value == null || value === "") return "not estimated";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "not estimated";
  const pctValue = numberValue > 0 && numberValue <= 1 ? numberValue * 100 : numberValue;
  return `${pctValue.toFixed(digits)}%`;
}

function nativeExpansionType(type?: string | null): boolean {
  return type === "boom_expansion" || type === "crash_expansion";
}

function percentileAt(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx] ?? 0;
}

function relativeNativeTier(score: number, sortedScoresAsc: number[]): "A" | "B" | "C" {
  const aCutoff = percentileAt(sortedScoresAsc, 0.75);
  const bCutoff = percentileAt(sortedScoresAsc, 0.35);
  return score >= aCutoff ? "A" : score >= bCutoff ? "B" : "C";
}

function relativeNativePercentile(score: number, sortedScoresAsc: number[]): number {
  if (sortedScoresAsc.length <= 1) return 100;
  let countAtOrBelow = 0;
  for (const candidate of sortedScoresAsc) {
    if (candidate <= score) countAtOrBelow++;
  }
  return Math.round(((countAtOrBelow - 1) / (sortedScoresAsc.length - 1)) * 100);
}

function TypePill({ type }: { type: string }) {
  const label = formatMoveTypeLabel(type);
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border", TYPE_COLORS[type] ?? TYPE_COLORS.unknown)}>
      {label}
    </span>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono font-medium text-foreground text-right max-w-[70%] break-words whitespace-normal">
        {value}
      </span>
    </div>
  );
}

function CompactDisclosure({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/30 bg-background/40 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/10 transition-colors"
      >
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function DiagnosticHistoryPanel({
  entries,
  expanded,
  onToggle,
  emptyMessage,
}: {
  entries: DiagnosticHistoryEntry[];
  expanded: boolean;
  onToggle: () => void;
  emptyMessage: string;
}) {
  return (
    <div className="rounded-lg border border-border/30 bg-background/40 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/10 transition-colors"
      >
        <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
          <Clock className="w-3.5 h-3.5 text-muted-foreground" />
          Run History
        </span>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          {expanded ? "Hide history" : "Show history"}
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/20 px-3 py-3">
          {entries.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{emptyMessage}</p>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div key={entry.id} className="rounded border border-border/30 bg-muted/10 px-3 py-2 text-[11px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                      entry.status === "failed"
                        ? "border-red-500/30 bg-red-500/10 text-red-300"
                        : entry.status === "completed"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                          : "border-primary/30 bg-primary/10 text-primary"
                    )}>
                      {entry.status}
                    </span>
                    <span className="text-muted-foreground">{formatRuntimeDate(entry.at)}</span>
                  </div>
                  <p className="mt-1 text-foreground">{entry.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function asNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatPct(v: unknown, digits = 2): string {
  const n = asNum(v);
  return n == null ? "" : `${n.toFixed(digits)}%`;
}

function formatModelDetails(
  model: Record<string, unknown> | undefined,
  kind: "tp" | "sl" | "lifecycle",
): string {
  if (!model || Object.keys(model).length === 0) return "";

  if (kind === "tp") {
    const target = formatPct(model.targetPct, 2);
    const rationale = typeof model.rationale === "string" ? model.rationale : "";
    return [target ? `target ${target}` : "", rationale].filter(Boolean).join(" - ");
  }

  if (kind === "sl") {
    const structural = model.structural === true ? "structural" : "";
    const risk = formatPct(model.maxInitialRiskPct, 2);
    return [structural, risk ? `max risk ${risk}` : ""].filter(Boolean).join(" - ");
  }

  const activation = formatPct(model.protectionActivationPct ?? model.activationProfitPct, 2);
  const distance = formatPct(model.dynamicProtectionDistancePct ?? model.trailingDistancePct, 2);
  const hold = asNum(model.minimumProtectionMinutes ?? model.minHoldMinutesBeforeTrail);
  const policy = typeof model.policy === "string" ? model.policy : "";
  return [
    activation ? `protect ${activation}` : "",
    distance ? `floor distance ${distance}` : "",
    hold != null ? `min hold ${Math.round(hold)}m` : "",
    policy,
  ].filter(Boolean).join(" - ");
}

function DomainCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30">
        {icon}
        <span className="text-xs font-semibold text-foreground">{title}</span>
      </div>
      <div className="px-4 py-3 flex-1 space-y-0.5">{children}</div>
    </div>
  );
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface DetectResult {
  symbol: string;
  detected: number;
  savedToDb: number;
  windowDays: number;
  movesDetected?: number;
  totalCandlesScanned?: number;
  interpolatedExcluded?: number;
  movesByType?: Record<string, number>;
  movesByTier?: Record<string, number>;
}

interface MoveTypeStats {
  count: number;
  avgMovePct: number;
  medianMovePct: number;
  avgHoldHours: number;
  engineCoverage: number;
  avgCaptureablePct: number;
  avgHoldabilityScore: number;
}

interface AggregateResult {
  symbol: string;
  totalMoves: number;
  byMoveType: Record<string, MoveTypeStats>;
  overall: {
    targetMoves: number;
    capturedMoves: number;
    missedMoves: number;
    fitScore: number;
    avgMovePct: number;
    medianMovePct: number;
    avgHoldHours: number;
    avgCaptureablePct: number;
    avgHoldabilityScore: number;
    avgMfe: number | null;
    missReasons: Array<{ reason: string; count: number }>;
    engineCoverage: Record<string, { matched: number; fired: number; missRate: number }>;
    qualityDistribution: Record<string, number>;
    behaviorPatterns: Record<string, number>;
    leadInShapes: Record<string, number>;
    directionSplit: { up: number; down: number };
  };
  generatedAt: string;
}

interface EngineRow {
  engineName?: string;
  matchedMoves: number;
  wouldFireCount: number;
  fireRate: number;
  avgMissMovePct: number;
  topMissReasons?: string[];
}

interface DetectedMove {
  id: number;
  symbol: string;
  moveType: string;
  qualityTier: string;
  qualityScore?: number;
  direction: string;
  movePct: number;
  holdingMinutes: number;
  leadInShape: string;
  startTs: number;
}

function MoveCalibrationTab({
  domain,
  windowDays,
  lockedSymbol,
  hideReportsActions = false,
  showAdvancedDiagnostics = false,
  showIntegratedEliteSynthesis = true,
}: {
  domain: DomainId;
  windowDays: number;
  lockedSymbol?: string;
  hideReportsActions?: boolean;
  showAdvancedDiagnostics?: boolean;
  showIntegratedEliteSynthesis?: boolean;
}) {
  const calibRun = useCalibrationRun();
  const calibrationSymbols = CALIB_ACTIVE_SYMBOLS;
  const [symbol, setSymbol] = useState(lockedSymbol ?? calibrationSymbols[0] ?? "BOOM300");
  const [minMovePct, setMinMovePct] = useState(0.05);
  const [clearExisting, setClearExisting] = useState(true);
  const [strategyFamily, setStrategyFamily] = useState("all");

  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [detectErr, setDetectErr] = useState<string | null>(null);

  const [aggregate, setAggregate] = useState<AggregateResult | null>(null);
  const [aggLoading, setAggLoading] = useState(false);

  const [targetMovesStats, setTargetMovesStats] = useState<{
    totalMoves: number;
    medianMagnitudePct: number | null;
    medianQualityScore: number | null;
    moveTypeDistribution: Record<string, number>;
    qualityDistribution: Record<string, number>;
  } | null>(null);

  const [behaviorProfile, setBehaviorProfile] = useState<BehaviorOverview | null>(null);
  const [buildingProfile, setBuildingProfile] = useState(false);
  const [calibProfile, setCalibProfile] = useState<CalibrationProfile | null>(null);
  const [researchProfile, setResearchProfile] = useState<SymbolResearchProfileUi | null>(null);
  const [runtimeModel, setRuntimeModel] = useState<RuntimeModelStateUi | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState<"stage" | "promote" | null>(null);
  const [runtimeErr, setRuntimeErr] = useState<string | null>(null);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [parityBusy, setParityBusy] = useState(false);
  const [parityErr, setParityErr] = useState<string | null>(null);
  const [parityReport, setParityReport] = useState<ParityReportUi | null>(null);
  const [optimiserBusy, setOptimiserBusy] = useState<"run" | "stage" | "refresh" | "cancel" | null>(null);
  const [optimiserRunId, setOptimiserRunId] = useState<number | null>(null);
  const [optimiserStatus, setOptimiserStatus] = useState<Record<string, unknown> | null>(null);
  const [optimiserErr, setOptimiserErr] = useState<string | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);

  const [engines, setEngines] = useState<EngineRow[]>([]);
  const [engineLoading, setEngineLoading] = useState(false);

  const [moves, setMoves] = useState<DetectedMove[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const [moveTypeFilter, setMoveTypeFilter] = useState("all");
  const [movesExpanded, setMovesExpanded] = useState(false);

  const [scope, setScope] = useState<"detect" | "passes" | "full">("full");
  const [runElapsed, setRunElapsed] = useState(0);
  const prevCalibStatusRef = useRef<string | undefined>(undefined);
  const [showDebugTools, setShowDebugTools] = useState(false);
  const [preflight, setPreflight] = useState<{
    latestCandleTs?: number;
    base1mCount: number;
    base1mGapCount: number;
    base1mInterpolatedCount: number;
    base1mCoveragePct: number;
    readyForCalibration: boolean;
    integrityStatus: "healthy" | "reconcile_required";
    recommendedAction: string;
  } | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  const [passName, setPassName] = useState("all");
  const [passMinTier, setPassMinTier] = useState("");
  const [passMoveType, setPassMoveType] = useState("all");
  const [maxMoves, setMaxMoves] = useState("");
  const [passErr, setPassErr] = useState<string | null>(null);

  const passForThisSymbol = calibRun.isPassRunActive && calibRun.symbol === symbol;
  const passStatus = (() => {
    if (calibRun.runId !== null && calibRun.symbol === symbol && calibRun.status) {
      return calibRun.status;
    }
    const term = calibRun.lastTerminalRun;
    if (term && term.symbol === symbol) {
      return term.status;
    }
    return null;
  })();

  const [historyDetailId, setHistoryDetailId] = useState<number | null>(null);
  const [historyDetail, setHistoryDetail] = useState<PassStatusResult | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);

  const [runs, setRuns] = useState<PassRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsExpanded, setRunsExpanded] = useState(false);

  const [exportBusy, setExportBusy] = useState<Record<string, boolean>>({});
  const [resetBusy, setResetBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importType, setImportType] = useState<"auto" | "moves" | "passes" | "profile" | "comparison">("auto");
  const [importReplace, setImportReplace] = useState(true);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const loadDomains = useCallback(async (sym: string, family?: string) => {
    setAggLoading(true);
    setDomainLoading(true);
    setEngineLoading(true);
    const profilePath = (family && family !== "all") ? family : "all";
    try {
      const [agg, eng, beh, calib, rawMovesResp, rp, runtime] = await Promise.all([
        apiFetch(`calibration/aggregate/${sym}`).catch(() => null),
        apiFetch(`calibration/engine/${sym}`).catch(() => null),
        apiFetch(`behavior/profile/${sym}`).catch(() => null),
        apiFetch(`calibration/profile/${sym}/${profilePath}`).catch(() => null),
        apiFetch(`calibration/moves/${sym}`).catch(() => null),
        apiFetch(`calibration/research-profile/${sym}`).catch(() => null),
        apiFetch(`calibration/runtime-model/${sym}`).catch(() => null),
      ]);
      setAggregate(agg);
      setEngines(eng?.engines ?? []);
      setBehaviorProfile(beh ?? null);
      setCalibProfile(calib ?? null);
      setResearchProfile(rp ?? null);
      setRuntimeModel(runtime ?? null);

      // Compute Target Moves stats directly from the moves endpoint (constraint #9  source: /api/calibration/moves/:symbol)
      const rawMoves: Array<{ movePct?: number | string | null; moveType?: string | null; qualityTier?: string | null; qualityScore?: number | string | null }> =
        rawMovesResp?.moves ?? [];
      if (rawMoves.length > 0) {
        const mags = rawMoves
          .map(m => Number(m.movePct ?? 0))
          .filter(v => !isNaN(v))
          .sort((a, b) => a - b);
        const mid = Math.floor(mags.length / 2);
        const medianMag = mags.length > 0 ? mags[mid] : null;
        const qualScores = rawMoves
          .map(m => Number(m.qualityScore ?? 0))
          .filter(v => !isNaN(v))
          .sort((a, b) => a - b);
        const medianQuality = qualScores.length > 0 ? qualScores[Math.floor(qualScores.length / 2)] : null;
        const moveTypeDist = rawMoves.reduce<Record<string, number>>((acc, m) => {
          const t = String(m.moveType ?? "unknown");
          acc[t] = (acc[t] ?? 0) + 1;
          return acc;
        }, {});
        const nativeScores = rawMoves.every(m => nativeExpansionType(m.moveType))
          ? rawMoves.map(m => Number(m.qualityScore ?? 0)).filter(v => !isNaN(v)).sort((a, b) => a - b)
          : [];
        const qualityDist = rawMoves.reduce<Record<string, number>>((acc, m) => {
          const score = Number(m.qualityScore ?? 0);
          const t = nativeScores.length >= 10 && !isNaN(score)
            ? relativeNativeTier(score, nativeScores)
            : String(m.qualityTier ?? "?");
          acc[t] = (acc[t] ?? 0) + 1;
          return acc;
        }, {});
        setTargetMovesStats({
          totalMoves: rawMoves.length,
          medianMagnitudePct: medianMag,
          medianQualityScore: medianQuality,
          moveTypeDistribution: moveTypeDist,
          qualityDistribution: qualityDist,
        });
      } else {
        setTargetMovesStats(null);
      }
    } finally {
      setAggLoading(false);
      setDomainLoading(false);
      setEngineLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (sym: string) => {
    setRunsLoading(true);
    try {
      const d = await apiFetch(`calibration/runs/${sym}`).catch(() => null);
      setRuns(d?.runs ?? []);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const loadMoves = useCallback(async (sym: string, type?: string) => {
    setMovesLoading(true);
    try {
      const params = new URLSearchParams();
      if (type && type !== "all") params.set("moveType", type);
      const qs = params.toString();
      const d = await apiFetch(`calibration/moves/${sym}${qs ? "?" + qs : ""}`);
      setMoves(d.moves ?? []);
    } catch {
      setMoves([]);
    } finally {
      setMovesLoading(false);
    }
  }, []);

  const loadPreflight = useCallback(async (sym: string) => {
    setPreflightLoading(true);
    try {
      const d = await apiFetch(`calibration/preflight/${sym}`);
      setPreflight(d);
    } catch {
      setPreflight(null);
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    if (lockedSymbol && symbol !== lockedSymbol) {
      setSymbol(lockedSymbol);
      setDetectResult(null);
      setDetectErr(null);
      setStrategyFamily("all");
      setMoveTypeFilter("all");
      return;
    }
    if (!calibrationSymbols.includes(symbol)) {
      setSymbol(calibrationSymbols[0] ?? "BOOM300");
      setDetectResult(null);
      setDetectErr(null);
      setStrategyFamily("all");
      setMoveTypeFilter("all");
    }
  }, [domain, calibrationSymbols, lockedSymbol, symbol]);

  useEffect(() => {
    setOptimiserRunId(null);
    setOptimiserStatus(null);
    setOptimiserErr(null);
    setParityReport(null);
    setParityErr(null);
  }, [symbol]);

  useEffect(() => {
    loadDomains(symbol, strategyFamily);
    loadMoves(symbol, moveTypeFilter);
    loadRuns(symbol);
    loadPreflight(symbol);
  }, [symbol]);

  // Recovery path: if a run is already "running" on the backend (e.g. page refresh,
  // new browser tab, or stale session storage), re-attach local polling automatically.
  useEffect(() => {
    if (calibRun.isPassRunActive) return;
    const running = runs.find(r => r.status === "running");
    if (!running) return;
    calibRun.beginPassRun(running.id, symbol);
  }, [runs, symbol, calibRun]);

  useEffect(() => {
    setHistoryDetailId(null);
    setHistoryDetail(null);
  }, [symbol]);

  useEffect(() => {
    loadMoves(symbol, moveTypeFilter);
  }, [moveTypeFilter]);

  useEffect(() => {
    setMoveTypeFilter(strategyFamily);
    loadDomains(symbol, strategyFamily);
  }, [strategyFamily]);

  useEffect(() => {
    if (!detecting && !passForThisSymbol) {
      setRunElapsed(0);
      return;
    }
    setRunElapsed(0);
    const id = setInterval(() => setRunElapsed(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [detecting, passForThisSymbol]);

  useEffect(() => {
    const st = calibRun.status?.status;
    if (
      prevCalibStatusRef.current === "running" &&
      st &&
      st !== "running" &&
      calibRun.symbol === symbol
    ) {
      void Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadRuns(symbol),
        loadPreflight(symbol),
      ]);
    }
    prevCalibStatusRef.current = st;
  }, [calibRun.status?.status, calibRun.symbol, symbol, strategyFamily, moveTypeFilter, loadDomains, loadMoves, loadRuns, loadPreflight]);

  const resetCalibration = async (): Promise<void> => {
    if (
      !window.confirm(
        `Clear all move calibration for ${symbol}? This deletes detected moves, pass rows, profiles, and run history for this symbol.`,
      )
    ) {
      return;
    }
    setResetBusy(true);
    setDetectErr(null);
    setPassErr(null);
    try {
      await apiFetch(`calibration/reset/${symbol}`, { method: "POST" });
      calibRun.clearPassRunForSymbol(symbol);
      setDetectResult(null);
      await Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadRuns(symbol),
        loadPreflight(symbol),
      ]);
    } catch (e: unknown) {
      setDetectErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setResetBusy(false);
    }
  };

  const detectMoves = async (): Promise<boolean> => {
    setDetecting(true);
    setDetectErr(null);
    setDetectResult(null);
    try {
      const d = await apiFetch(`calibration/detect-moves/${symbol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays, minMovePct, clearExisting }),
      });
      setDetectResult(d);
      await Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadPreflight(symbol),
      ]);
      return true;
    } catch (e: unknown) {
      setDetectErr(e instanceof Error ? e.message : "Detection failed");
      return false;
    } finally {
      setDetecting(false);
    }
  };

  const openRunHistoryDetail = async (id: number) => {
    setHistoryDetailId(id);
    setHistoryDetailLoading(true);
    try {
      const s = (await apiFetch(`calibration/run-status/${id}`)) as PassStatusResult;
      setHistoryDetail(s);
    } catch {
      setHistoryDetail(null);
    } finally {
      setHistoryDetailLoading(false);
    }
  };

  const runPasses = async (overridePassName?: string): Promise<boolean> => {
    setPassErr(null);
    try {
      const pn = overridePassName ?? passName;
      const body: Record<string, unknown> = {
        windowDays,
        passName: pn,
        continueOnMoveErrors: false,
      };
      if (passMinTier) body.minTier = passMinTier;
      const effectiveMoveType = passMoveType !== "all" ? passMoveType : (strategyFamily !== "all" ? strategyFamily : undefined);
      if (effectiveMoveType) body.moveType = effectiveMoveType;
      if (maxMoves && !isNaN(Number(maxMoves))) body.maxMoves = Number(maxMoves);
      const url = `${BASE}api/calibration/run-passes/${symbol}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.status === 409 && typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId as number, symbol);
        return true;
      }
      if (!r.ok) {
        setPassErr(String(d.error ?? `HTTP ${r.status}`));
        return false;
      }
      if (typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId, symbol);
        return true;
      }
      setPassErr("No run id returned from server");
      return false;
    } catch (e: unknown) {
      setPassErr(e instanceof Error ? e.message : "Pass run failed");
      return false;
    }
  };

  const runFullCalibration = async (): Promise<boolean> => {
    setPassErr(null);
    setDetectErr(null);
    try {
      const body: Record<string, unknown> = {
        windowDays,
        minMovePct,
        force: true,
      };
      if (passMinTier) body.minTier = passMinTier;
      const effectiveMoveType = passMoveType !== "all" ? passMoveType : (strategyFamily !== "all" ? strategyFamily : undefined);
      if (effectiveMoveType) body.moveType = effectiveMoveType;
      if (maxMoves && !isNaN(Number(maxMoves))) body.maxMoves = Number(maxMoves);

      const url = `${BASE}api/calibration/full/${symbol}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.status === 409 && typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId as number, symbol);
        return true;
      }
      if (!r.ok) {
        setPassErr(String(d.error ?? `HTTP ${r.status}`));
        return false;
      }
      if (typeof d.runId === "number") {
        calibRun.beginPassRun(d.runId, symbol);
        setDetectResult((d.detectSummary as DetectResult | null | undefined) ?? null);
        await loadPreflight(symbol);
        return true;
      }
      setPassErr("Full calibration did not return a run id");
      return false;
    } catch (e: unknown) {
      setPassErr(e instanceof Error ? e.message : "Full calibration failed");
      return false;
    }
  };

  const effectiveScope: "detect" | "passes" | "full" = showDebugTools ? scope : "full";

  const runScope = async () => {
    if (effectiveScope === "detect") {
      await detectMoves();
    } else if (effectiveScope === "passes") {
      // Scope "Run All Passes" always forces passName="all" regardless of the pass selector,
      // so the selector only affects explicit single-pass reruns from run history.
      await runPasses("all");
    } else {
      await runFullCalibration();
    }
  };

  const doExport = async (key: string, endpoint: string, filename: string) => {
    setExportBusy(p => ({ ...p, [key]: true }));
    try {
      const d = await apiFetch(endpoint);
      downloadJson(d, filename);
    } catch (e: unknown) {
      alert(`Export failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setExportBusy(p => ({ ...p, [key]: false }));
    }
  };

  const buildPhaseIdentifierEndpoint = (mode: "summary" | "sample" | "full") => {
    const effectiveWindowDays = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
    const { startTs, endTs } = getWindowRange(effectiveWindowDays);
    const query = new URLSearchParams();
    if (startTs) query.set("startTs", String(startTs));
    if (endTs) query.set("endTs", String(endTs));
    if (mode === "sample") query.set("limit", "5");
    return `calibration/runtime-model/${symbol}/phase-identifiers${mode === "summary" ? "/summary" : ""}?${query.toString()}`;
  };

  const exportPhaseIdentifiers = async (mode: "summary" | "sample" | "full") => {
    const key = `phase-${mode}`;
    const dateSuffix = new Date().toISOString().slice(0, 10);
    const filenames = {
      summary: `crash300_phase_identifier_summary_${dateSuffix}.json`,
      sample: `crash300_phase_identifier_sample_${dateSuffix}.json`,
      full: `crash300_phase_identifier_report_${dateSuffix}.json`,
    } as const;
    setRuntimeErr(null);
    setRuntimeNotice(null);
    setExportBusy(p => ({ ...p, [key]: true }));
    try {
      const d = await apiFetch(buildPhaseIdentifierEndpoint(mode));
      downloadJson(d, filenames[mode]);
      setRuntimeNotice(
        mode === "summary"
          ? "Downloaded CRASH300 phase identifier summary report."
          : mode === "sample"
            ? "Downloaded CRASH300 phase identifier sample report."
            : "Downloaded CRASH300 full phase identifier report.",
      );
    } catch (e: unknown) {
      setRuntimeErr(e instanceof Error ? e.message : "Phase identifier export failed");
    } finally {
      setExportBusy(p => ({ ...p, [key]: false }));
    }
  };

  const updateRuntimeModel = async (action: "stage" | "promote") => {
    setRuntimeBusy(action);
    setRuntimeErr(null);
    setRuntimeNotice(null);
    try {
      const result = await apiFetch(`calibration/runtime-model/${symbol}/${action}`, { method: "POST" }) as {
        model?: RuntimeSymbolModelUi;
      };
      const runtime = await apiFetch(`calibration/runtime-model/${symbol}`).catch(() => null) as RuntimeModelStateUi | null;
      setRuntimeModel(runtime ?? null);
      const model = result?.model;
      const runId = model?.sourceRunId ?? runtime?.lifecycle?.[action === "stage" ? "stagedRunId" : "promotedRunId"] ?? "n/a";
      const actionTime = model?.promotedAt ?? runtime?.lifecycle?.[action === "stage" ? "stagedAt" : "promotedAt"] ?? null;
      const bucketCount = action === "stage"
        ? runtime?.lifecycle?.stagedTpBucketCount
        : runtime?.lifecycle?.promotedTpBucketCount;
      setRuntimeNotice(
        `${action === "stage" ? "Staged" : "Promoted"} ${symbol} runtime model from run ${runId} at ${formatRuntimeDate(actionTime)}. ` +
        `Dynamic TP buckets: ${bucketCount ?? 0}.`,
      );
    } catch (e: unknown) {
      setRuntimeErr(e instanceof Error ? e.message : `Runtime ${action} failed`);
    } finally {
      setRuntimeBusy(null);
    }
  };

  const runParityReport = async () => {
    setParityBusy(true);
    setParityErr(null);
    try {
      const report = await apiFetch(`calibration/runtime-model/${symbol}/parity-report?windowDays=${windowDays}`) as ParityReportUi;
      setParityReport(report);
    } catch (e: unknown) {
      setParityErr(e instanceof Error ? e.message : "Parity report failed");
    } finally {
      setParityBusy(false);
    }
  };

  const refreshOptimiserStatus = async (runId = optimiserRunId, silent = false) => {
    if (!runId) return;
    if (!silent) {
      setOptimiserBusy("refresh");
      setOptimiserErr(null);
    }
    try {
      const status = await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest/${runId}`) as Record<string, unknown>;
      setOptimiserStatus(status);
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Optimiser status failed");
    } finally {
      if (!silent) setOptimiserBusy(null);
    }
  };

  const runBacktestOptimiser = async () => {
    if (optimiserLockedByParity) {
      setOptimiserErr("Optimiser disabled: CRASH300 runtime does not recognise calibrated moves yet.");
      return;
    }
    setOptimiserBusy("run");
    setOptimiserErr(null);
    setRuntimeNotice(null);
    try {
      const started = await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays, maxIterations: 5, enableAiReview: false }),
      }) as { runId?: number };
      const runId = Number(started.runId);
      setOptimiserRunId(runId);
      setOptimiserStatus(started as unknown as Record<string, unknown>);
      setRuntimeNotice(`Backtest optimiser started for ${symbol}. Winner will be staged only, not promoted.`);
      window.setTimeout(() => void refreshOptimiserStatus(runId), 2500);
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Optimiser start failed");
    } finally {
      setOptimiserBusy(null);
    }
  };

  const cancelOptimiser = async () => {
    if (!optimiserRunId) return;
    setOptimiserBusy("cancel");
    setOptimiserErr(null);
    try {
      await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest/${optimiserRunId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "cancelled_from_research_ui" }),
      });
      await refreshOptimiserStatus(optimiserRunId);
      setRuntimeNotice(`Backtest optimiser cancellation requested for ${symbol} (run ${optimiserRunId}).`);
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Optimiser cancel failed");
    } finally {
      setOptimiserBusy(null);
    }
  };

  const stageOptimiserWinner = async () => {
    if (!optimiserRunId) return;
    setOptimiserBusy("stage");
    setOptimiserErr(null);
    try {
      const staged = await apiFetch(`calibration/runtime-model/${symbol}/optimise-backtest/${optimiserRunId}/stage-winner`, {
        method: "POST",
      }) as Record<string, unknown>;
      setOptimiserStatus(staged);
      const runtime = await apiFetch(`calibration/runtime-model/${symbol}`).catch(() => null) as RuntimeModelStateUi | null;
      setRuntimeModel(runtime ?? null);
      setRuntimeNotice("Optimised winner staged. Runtime is not promoted until you click Promote To Runtime.");
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Stage optimiser winner failed");
    } finally {
      setOptimiserBusy(null);
    }
  };

  const inferImportType = (filename: string, payload: Record<string, unknown>): "moves" | "passes" | "profile" | "comparison" | null => {
    const lower = filename.toLowerCase();
    if (lower.includes("calibration_moves_")) return "moves";
    if (lower.includes("calibration_passes_")) return "passes";
    if (lower.includes("calibration_profile_")) return "profile";
    if (lower.includes("calibration_comparison_")) return "comparison";
    if (Array.isArray(payload.moves) || Array.isArray(payload.detected_moves)) return "moves";
    if (Array.isArray(payload.runs) || payload.rawPassRecords || Array.isArray(payload.precursorPasses) || Array.isArray(payload.behaviorPasses)) return "passes";
    if (Array.isArray(payload.profiles)) return "profile";
    if (payload.aggregateDomain || payload.engineDomain || payload.scoringDomain) return "comparison";
    return null;
  };

  const importCalibrationFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImportBusy(true);
    setImportError(null);
    setImportMessage(null);
    const notes: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const text = await file.text();
        const payload = JSON.parse(text) as Record<string, unknown>;
        const resolvedType = importType === "auto" ? inferImportType(file.name, payload) : importType;
        if (!resolvedType) {
          notes.push(`${file.name}: skipped (could not infer import type)`);
          continue;
        }
        const response = await fetch(
          `${BASE}api/calibration/import/${symbol}?type=${resolvedType}&replace=${importReplace ? "true" : "false"}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          throw new Error(`${file.name}: ${String(body.error ?? `HTTP ${response.status}`)}`);
        }
        notes.push(`${file.name}: imported as ${resolvedType}`);
      }
      setImportMessage(notes.length > 0 ? notes.join(" | ") : "No files imported.");
      await Promise.all([
        loadDomains(symbol, strategyFamily),
        loadMoves(symbol, moveTypeFilter),
        loadRuns(symbol),
        loadPreflight(symbol),
      ]);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImportBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const movesMagnitudeSummary = (() => {
    if (moves.length === 0) return null;
    const sorted = [...moves].map(m => m.movePct).sort((a, b) => a - b);
    const idx = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
    return {
      min: sorted[0],
      p25: idx(0.25),
      median: idx(0.5),
      p75: idx(0.75),
      p90: idx(0.9),
      max: sorted[sorted.length - 1],
      count: sorted.length,
    };
  })();

  const calibrationCoverage = calibProfile
    ? {
        source: "Synthesized calibration profile",
        targetMoves: calibProfile.targetMoves,
        capturedMoves: calibProfile.capturedMoves,
        missedMoves: calibProfile.missedMoves,
        fitScore: calibProfile.fitScore,
        avgMovePct: calibProfile.avgMovePct,
        avgCaptureablePct: calibProfile.avgCaptureablePct,
        avgHoldabilityScore: calibProfile.avgHoldabilityScore,
      }
    : aggregate?.overall
      ? {
          source: "Current service replay aggregate",
          targetMoves: aggregate.overall.targetMoves,
          capturedMoves: aggregate.overall.capturedMoves,
          missedMoves: aggregate.overall.missedMoves,
          fitScore: aggregate.overall.fitScore,
          avgMovePct: aggregate.overall.avgMovePct,
          avgCaptureablePct: aggregate.overall.avgCaptureablePct,
          avgHoldabilityScore: aggregate.overall.avgHoldabilityScore,
      }
      : null;

  const nativeMoveScores = moves.every((m) => nativeExpansionType(m.moveType))
    ? moves.map((m) => Number(m.qualityScore ?? 0)).filter((v) => !isNaN(v)).sort((a, b) => a - b)
    : [];
  const moveRows = moves.map((m) => {
    const score = Number(m.qualityScore ?? 0);
    const relativeTier = nativeMoveScores.length >= 10 && !isNaN(score)
      ? relativeNativeTier(score, nativeMoveScores)
      : m.qualityTier;
    const qualityPercentile = nativeMoveScores.length >= 10 && !isNaN(score)
      ? relativeNativePercentile(score, nativeMoveScores)
      : null;
    return { ...m, relativeTier, qualityPercentile };
  });
  const displayedMoves = movesExpanded ? moveRows : moveRows.slice(0, 20);
  const optimiserRun = (optimiserStatus?.run ?? null) as Record<string, unknown> | null;
  const optimiserPhase = String(optimiserRun?.phase ?? "n/a");
  const optimiserHeartbeatRaw = optimiserRun?.lastHeartbeatAt;
  const optimiserHeartbeat = typeof optimiserHeartbeatRaw === "string" ? formatRuntimeDate(optimiserHeartbeatRaw) : "n/a";
  const optimiserIsRunning = String(optimiserRun?.status ?? "").toLowerCase() === "running";
  const optimiserWinner = (optimiserRun?.winnerMetrics ?? null) as Record<string, unknown> | null;
  const optimiserWinnerMetrics = (optimiserWinner?.metrics ?? null) as Record<string, unknown> | null;
  const optimiserBaseline = (optimiserRun?.baselineMetrics ?? null) as Record<string, unknown> | null;
  const optimiserCandidates = (optimiserStatus?.candidates ?? []) as Array<Record<string, unknown>>;
  const optimiserSelected = optimiserCandidates.find(c => c.selected === true);
  const optimiserFailureReason = String(
    optimiserStatus?.failureReason ??
    ((optimiserRun?.errorSummary as Record<string, unknown> | undefined)?.error ?? ""),
  ).trim();
  const optimiserFailureStack = String(
    optimiserStatus?.failureStack ??
    ((optimiserRun?.errorSummary as Record<string, unknown> | undefined)?.stack ?? ""),
  ).trim();
  const parityTotals = parityReport?.totals ?? null;
  const parityMatchedMoves = Number(parityTotals?.matchedMoves ?? 0);
  const parityHasAnyMatches = parityMatchedMoves > 0;
  const optimiserHasExistingRun = optimiserRunId != null || optimiserRun != null;
  const optimiserLockedByParity = !parityHasAnyMatches;
  const parityDiagnostics = parityReport?.diagnostics ?? null;
  const parityFailureRows = Object.entries(parityDiagnostics?.failureReasonCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityFamilyRows = Object.entries(parityDiagnostics?.selectedRuntimeFamilyCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityBucketRows = Object.entries(parityDiagnostics?.selectedBucketCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityDirectionRows = Object.entries(parityDiagnostics?.directionMatrixCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const parityGateRows = Object.entries(parityDiagnostics?.gateComponentFailures ?? {}).sort((a, b) => b[1] - a[1]);

  useEffect(() => {
    if (!optimiserRunId || !optimiserIsRunning) return;
    const id = window.setInterval(() => {
      void refreshOptimiserStatus(optimiserRunId, true);
    }, 2000);
    return () => window.clearInterval(id);
  }, [optimiserRunId, optimiserIsRunning]);

  return (
    <div className="space-y-5">

      {/*  Controls  */}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        {/* Scope row */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Calibration Controls</h3>
          <button
            type="button"
            onClick={() => {
              setShowDebugTools(prev => {
                const next = !prev;
                if (!next) setScope("full");
                return next;
              });
            }}
            className="text-[11px] px-2.5 py-1 rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
          >
            {showDebugTools ? "Hide Debug Tools" : "Show Debug Tools"}
          </button>
        </div>

        {/* Shared controls */}
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{lockedSymbol ? "Service" : "Symbol"}</span>
            {lockedSymbol ? (
              <div className="text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">
                {getSymbolLabel(lockedSymbol)}
              </div>
            ) : (
              <select
                value={symbol}
                onChange={e => {
                  const s = e.target.value;
                  setSymbol(s);
                  setDetectResult(null);
                  setDetectErr(null);
                  setStrategyFamily("all");
                  setMoveTypeFilter("all");
                }}
                className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
              >
                {calibrationSymbols.map(s => <option key={s} value={s}>{getSymbolLabel(s)}</option>)}
              </select>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Window</span>
            <div className="text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">
              {windowLabel(windowDays)} (shared)
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Strategy Family</span>
            <select
              value={strategyFamily}
              onChange={e => setStrategyFamily(e.target.value)}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {strategyFamiliesForSymbol(symbol).map((family) => (
                <option key={family} value={family}>{formatMoveTypeLabel(family)}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Min Move %</span>
            <select
              value={minMovePct}
              onChange={e => setMinMovePct(Number(e.target.value))}
              className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
            >
              {[0.02, 0.03, 0.05, 0.08, 0.10].map(p => <option key={p} value={p}>{(p * 100).toFixed(0)}%</option>)}
            </select>
          </div>

          {showDebugTools && scope === "detect" && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer self-end pb-1.5">
              <input
                type="checkbox"
                checked={clearExisting}
                onChange={e => setClearExisting(e.target.checked)}
                className="accent-primary"
              />
              Clear existing
            </label>
          )}

          {/* Debug-only pass controls */}
          {showDebugTools && (scope === "passes" || scope === "full") && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Pass</span>
                <select
                  value={passName}
                  onChange={e => setPassName(e.target.value)}
                  className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                >
                  {PASS_NAMES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Min Tier</span>
                <select
                  value={passMinTier}
                  onChange={e => setPassMinTier(e.target.value)}
                  className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                >
                  <option value="">Any</option>
                  {TIERS.map(t => <option key={t} value={t}>Tier {t}+</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Max Moves</span>
                <input
                  type="number"
                  value={maxMoves}
                  onChange={e => setMaxMoves(e.target.value)}
                  placeholder="all"
                  className="w-20 text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                />
              </div>
            </>
          )}

          {showDebugTools && (
            <div className="flex items-center gap-1 bg-background border border-border/50 rounded-lg p-0.5 self-end">
              {(["full", "detect", "passes"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={cn(
                    "text-[11px] px-2.5 py-1 rounded-md transition-colors font-medium",
                    scope === s
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s === "detect" ? "Detect Moves Only" : s === "passes" ? "Run All Passes" : "Run Full Calibration"}
                </button>
              ))}
            </div>
          )}

          {/* Unified Run button */}
          <button
            onClick={runScope}
            disabled={detecting || passForThisSymbol}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50 self-end",
              effectiveScope === "full"
                ? "bg-emerald-600 text-white"
                : effectiveScope === "passes"
                  ? "bg-amber-500/80 text-black"
                  : "bg-primary text-primary-foreground"
            )}
          >
            {(detecting || passForThisSymbol) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {detecting ? "Detecting" : passForThisSymbol ? "Running calibration" :
              effectiveScope === "detect" ? "Detect Moves" : effectiveScope === "passes" ? "Run Calibration Pipeline" : "Run Full Calibration"}
          </button>

          <button
            onClick={() => { loadDomains(symbol, strategyFamily); loadMoves(symbol, moveTypeFilter); loadRuns(symbol); loadPreflight(symbol); }}
            disabled={aggLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border self-end"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", aggLoading && "animate-spin")} />
            Refresh
          </button>

          <button
            type="button"
            onClick={() => void resetCalibration()}
            disabled={resetBusy || detecting || passForThisSymbol}
            title="Delete moves, pass results, profiles, and run history for this symbol"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 self-end disabled:opacity-50"
          >
            {resetBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Clear calibration
          </button>
        </div>

        {/* Elapsed timer */}
        {(detecting || passForThisSymbol) && runElapsed > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
            <Loader2 className="w-3 h-3 animate-spin" />
            Elapsed: <strong className="text-foreground font-mono">{formatDurationCompact(runElapsed)}</strong>
          </div>
        )}

        <div className="rounded-lg border border-border/40 bg-muted/10 p-3 space-y-2">
          {(() => {
            const currentStage = (passStatus?.metaJson as { stage?: string } | null)?.stage;
            const reconcileRunning = passStatus?.status === "running" && currentStage === "Data Integrity";
            const readinessLabel = reconcileRunning
              ? "running reconcile"
              : preflight?.readyForCalibration
                ? "healthy"
                : "reconcile required";
            const readinessClass = reconcileRunning
              ? "text-sky-300 border-sky-500/30 bg-sky-500/10"
              : preflight?.readyForCalibration
                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                : "text-amber-300 border-amber-500/30 bg-amber-500/10";
            return (
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">Calibration Readiness</span>
            {preflightLoading ? (
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> checking
              </span>
            ) : (
              <span
                className={cn(
                  "text-[11px] px-2 py-0.5 rounded border",
                  readinessClass
                )}
              >
                {readinessLabel}
              </span>
            )}
          </div>
            );
          })()}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Last candle</div>
              <div className="font-mono text-foreground">
                {preflight?.latestCandleTs
                  ? new Date(preflight.latestCandleTs * 1000).toLocaleString()
                  : ""}
              </div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">1m candles</div>
              <div className="font-mono text-foreground">{preflight?.base1mCount?.toLocaleString?.() ?? ""}</div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Missing gaps</div>
              <div className="font-mono text-foreground">{preflight?.base1mGapCount ?? ""}</div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Interpolated</div>
              <div className="font-mono text-foreground">{preflight?.base1mInterpolatedCount ?? ""}</div>
            </div>
            <div className="rounded border border-border/30 bg-background/40 p-2">
              <div className="text-muted-foreground">Coverage</div>
              <div className="font-mono text-foreground">{preflight?.base1mCoveragePct != null ? `${preflight.base1mCoveragePct}%` : ""}</div>
            </div>
          </div>
          {preflight?.recommendedAction && (
            <p className="text-[11px] text-muted-foreground">
              Recommended action: <span className="text-foreground font-mono">{preflight.recommendedAction}</span>
            </p>
          )}
        </div>

        {detectErr && <ErrorBox msg={detectErr} />}
        {detectResult && (
          <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">{detectResult.movesDetected} moves detected  {symbol} ({windowDays}d window)</span>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span>Candles scanned: <strong className="text-foreground">{detectResult.totalCandlesScanned?.toLocaleString()}</strong></span>
              <span>Interpolated excluded: <strong className="text-foreground">{detectResult.interpolatedExcluded}</strong></span>
              <span>Saved to DB: <strong className="text-foreground">{detectResult.savedToDb}</strong></span>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(detectResult.movesByType ?? {}).map(([type, cnt]) => (
                <span key={type} className={cn("px-1.5 py-0.5 rounded text-[10px] border", TYPE_COLORS[type] ?? TYPE_COLORS.unknown)}>
                  {type}: {cnt as number}
                </span>
              ))}
              {Object.entries(detectResult.movesByTier ?? {}).map(([tier, cnt]) => (
                <span key={tier} className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
                  Tier {tier}: {cnt as number}
                </span>
              ))}
            </div>
          </div>
        )}

        {passErr && <ErrorBox msg={passErr} />}

        {passStatus && (
          <div className={cn(
            "rounded-lg border p-3 space-y-1.5",
            passStatus.status === "completed" ? "bg-green-500/10 border-green-500/20" :
            passStatus.status === "cancelled" ? "bg-amber-500/10 border-amber-500/20" :
            passStatus.status === "failed"    ? "bg-red-500/10 border-red-500/20" :
            "bg-primary/5 border-primary/20"
          )}>
            <div className="flex items-center gap-2">
              {passForThisSymbol && passStatus?.status === "running" && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              )}
              {passStatus.status === "completed" && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
              {passStatus.status === "cancelled" && <XCircle className="w-3.5 h-3.5 text-amber-300" />}
              {passStatus.status === "failed"    && <XCircle    className="w-3.5 h-3.5 text-red-400"   />}
              <span className="text-xs font-semibold text-foreground">
                {passStatus.status === "running"   ? "Calibration running" :
                 passStatus.status === "completed" ? "Calibration completed" :
                 passStatus.status === "cancelled" ? "Calibration cancelled" :
                 passStatus.status === "failed"    ? "Pass run failed" :
                 `Status: ${passStatus.status}`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {["Data Integrity", "Move Detection", "Deterministic Enrichment", "Family Inference", "Bucket Model Synthesis", "Research Profile Complete"].map((stage) => {
                const currentStage = (passStatus.metaJson as { stage?: string } | null)?.stage ?? "";
                const isActive = currentStage === stage;
                const isDone = ["Research Profile Complete"].includes(stage)
                  ? passStatus.status === "completed"
                  : false;
                return (
                  <span
                    key={stage}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded border",
                      isDone
                        ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                        : isActive
                          ? "text-primary border-primary/40 bg-primary/10"
                          : "text-muted-foreground border-border/30 bg-background/40"
                    )}
                  >
                    {stage}
                  </span>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {passStatus.totalMoves    != null && <span>Total: <strong className="text-foreground">{passStatus.totalMoves}</strong></span>}
              {passStatus.processedMoves != null && <span>Processed: <strong className="text-foreground">{passStatus.processedMoves}</strong></span>}
              {passStatus.failedMoves   != null && (
                <span title="Number of pass-level errors recorded (same move can count more than once only if multiple passes error)">
                  Pass errors: <strong className="text-foreground">{passStatus.failedMoves}</strong>
                </span>
              )}
              {passStatus.passName                  && <span>Pass: <strong className="text-foreground">{passStatus.passName}</strong></span>}
              {(passStatus.metaJson as { progress?: { remainingMoves?: number } } | null)?.progress?.remainingMoves != null &&
                passStatus.status === "running" && (
                <span>Queue left: <strong className="text-foreground">{(passStatus.metaJson as { progress?: { remainingMoves?: number } }).progress?.remainingMoves}</strong></span>
              )}
            </div>
            {passStatus.status === "running" &&
              (passStatus.metaJson as { progress?: { label?: string } } | null)?.progress?.label && (
              <p className="text-[11px] font-mono text-primary">
                {(passStatus.metaJson as { progress?: { label?: string } }).progress?.label}
              </p>
            )}
            {(() => {
              const mj = passStatus.metaJson as { failure?: { kind?: string; moveId?: number; pass?: string; error?: string; hint?: string } } | null;
              const f = mj?.failure;
              if (!f || passStatus.status === "running") return null;
              return (
                <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] text-amber-100/90 space-y-1">
                  <p className="font-semibold text-amber-200">Run stopped  {f.kind ?? "failure"}</p>
                  {typeof f.moveId === "number" && <p className="font-mono">move id {f.moveId}{typeof f.pass === "string" ? `  ${f.pass}` : ""}</p>}
                  {typeof f.error === "string" && <p className="font-mono text-red-300/95 whitespace-pre-wrap">{f.error}</p>}
                  {typeof f.hint === "string" && <p className="text-muted-foreground">{f.hint}</p>}
                </div>
              );
            })()}
            {passStatus.errorSummary != null && (
              <p className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-all">
                {typeof passStatus.errorSummary === "string"
                  ? passStatus.errorSummary
                  : JSON.stringify(passStatus.errorSummary, null, 2)}
              </p>
            )}
          </div>
        )}

        <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Run History</span>
              {runs.length > 0 && (
                <span className="text-[11px] text-muted-foreground">({runs.length} runs)</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                if (!runsExpanded) loadRuns(symbol);
                setRunsExpanded(v => !v);
              }}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {runsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {runsExpanded ? "Hide history" : "Show history"}
            </button>
          </div>

          {runsExpanded && (
            <div className="space-y-2">
              {runsLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />Loading run history
                </div>
              )}
              {!runsLoading && runs.length === 0 && (
                <p className="text-xs text-muted-foreground">No calibration pass runs recorded yet for {symbol}.</p>
              )}
              {!runsLoading && runs.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-border/30 text-muted-foreground">
                        <th className="text-left py-2 pr-3 font-medium">ID</th>
                        <th className="text-left px-3 py-2 font-medium">Pass</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-left px-3 py-2 font-medium">Moves</th>
                        <th className="text-left px-3 py-2 font-medium">Processed</th>
                        <th className="text-left px-3 py-2 font-medium">Failed</th>
                        <th className="text-left px-3 py-2 font-medium">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.slice(0, 8).map((run) => (
                        <tr
                          key={run.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => void openRunHistoryDetail(run.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void openRunHistoryDetail(run.id);
                            }
                          }}
                          className={cn(
                            "border-b border-border/20 transition-colors cursor-pointer",
                            historyDetailId === run.id ? "bg-muted/30" : "hover:bg-muted/20",
                          )}
                        >
                          <td className="py-1.5 pr-3 font-mono text-muted-foreground">#{run.id}</td>
                          <td className="px-3 py-1.5 font-mono text-foreground">{run.passName}</td>
                          <td className="px-3 py-1.5">
                            <span className={cn(
                              "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border",
                              run.status === "completed" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/25" :
                              run.status === "cancelled" ? "text-amber-300 bg-amber-500/10 border-amber-500/25" :
                              run.status === "partial"   ? "text-amber-400 bg-amber-500/10 border-amber-500/25" :
                              run.status === "failed"    ? "text-red-400 bg-red-500/10 border-red-500/25" :
                              "text-sky-400 bg-sky-500/10 border-sky-500/25"
                            )}>
                              {run.status}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 font-mono text-foreground">{run.totalMoves ?? ""}</td>
                          <td className="px-3 py-1.5 font-mono text-foreground">{run.processedMoves ?? ""}</td>
                          <td className="px-3 py-1.5 font-mono text-foreground">{run.failedMoves ?? ""}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {run.startedAt ? new Date(run.startedAt).toLocaleString() : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showIntegratedEliteSynthesis && (
        <IntegratedEliteSynthesisCard service={symbol} windowDays={windowDays} />
      )}

      {/*  3-Domain Comparison  */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-0.5 mb-2">3-Domain Comparison</h3>
        {(aggLoading || domainLoading || engineLoading) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="w-4 h-4 animate-spin" />Loading calibration domains
          </div>
        )}
        {!(aggLoading || domainLoading || engineLoading) && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

            {/* Domain A  Current Engine Behavior (signal-first, from behavior layer) */}
            <DomainCard title="Current Engine Behavior" icon={<Activity className="w-3.5 h-3.5 text-amber-400" />}>
              {!behaviorProfile ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">No behavior profile available.</p>
                  <button
                    disabled={buildingProfile}
                    onClick={async () => {
                      setBuildingProfile(true);
                      try {
                        await apiFetch(`behavior/build/${symbol}`, { method: "POST" }).catch(() => null);
                        const beh = await apiFetch(`behavior/profile/${symbol}`).catch(() => null);
                        setBehaviorProfile(beh ?? null);
                      } catch (err) {
                        console.error("[BehaviorProfile] Build failed:", err);
                      } finally {
                        setBuildingProfile(false);
                      }
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border/50 text-muted-foreground text-[11px] hover:border-border hover:bg-muted/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {buildingProfile ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    {buildingProfile ? "Building" : "Build Behavior Profile"}
                  </button>
                </div>
              ) : (
                <>
                  <StatRow label="Total trades" value={behaviorProfile.totalTrades} />
                  <StatRow label="Signals fired" value={behaviorProfile.totalSignalsFired} />
                  <StatRow label="Blocked" value={behaviorProfile.totalBlocked} />
                  <StatRow label="Win rate" value={`${(behaviorProfile.overallWinRate * 100).toFixed(1)}%`} />
                  <StatRow label="Block rate" value={`${(behaviorProfile.overallBlockedRate * 100).toFixed(1)}%`} />
                  <StatRow label="Rec. scan cadence" value={`${behaviorProfile.recommendedScanCadenceMins}min`} />
                  {(behaviorProfile.engineProfiles ?? []).length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-1.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Engines</p>
                      {(behaviorProfile.engineProfiles ?? []).map(ep => (
                        <div key={ep.engineName} className="space-y-0.5">
                          <p className="text-[10px] font-mono font-semibold text-foreground truncate">{ep.engineName}</p>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Trades / WR</span>
                            <span className="font-mono text-foreground">{ep.tradeCount}  {(ep.winRate * 100).toFixed(1)}%</span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Avg PnL % (extracted)</span>
                            <span className={cn("font-mono", ep.avgPnlPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                              {(ep.avgPnlPct * 100).toFixed(2)}%
                            </span>
                          </div>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Signals/day</span>
                            <span className="font-mono text-foreground">{ep.signalFrequencyPerDay.toFixed(2)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {aggregate?.overall?.avgMfe != null && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20">
                      <StatRow
                        label="Avg MFE (structural)"
                        value={`${aggregate.overall.avgMfe.toFixed(2)}%`}
                      />
                      <p className="text-[9px] text-muted-foreground/60 mt-0.5">From behavior pass  max favorable excursion per move</p>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Updated {new Date(behaviorProfile.lastUpdated).toLocaleDateString()}
                  </p>
                </>
              )}
            </DomainCard>

            {/* Domain B  Target Moves (sourced from /api/calibration/moves/:symbol  constraint #9) */}
            <DomainCard title="Target Moves" icon={<Target className="w-3.5 h-3.5 text-primary" />}>
              {!targetMovesStats ? (
                <p className="text-[11px] text-muted-foreground">No moves detected. Run "Detect Moves" first.</p>
              ) : (
                <>
                  <StatRow label="Total moves" value={targetMovesStats.totalMoves} />
                  <StatRow
                    label="Median magnitude %"
                    value={targetMovesStats.medianMagnitudePct != null
                      ? `${(targetMovesStats.medianMagnitudePct * 100).toFixed(2)}%`
                      : ""}
                  />
                  <StatRow
                    label="Median raw quality score"
                    value={targetMovesStats.medianQualityScore != null
                      ? targetMovesStats.medianQualityScore.toFixed(1)
                      : ""}
                  />
                  {/* Avg hold from aggregate (computed from same moves table) */}
                  {aggregate?.overall && (
                    <>
                      <StatRow label="Avg move %" value={`${aggregate.overall.avgMovePct.toFixed(1)}%`} />
                      <StatRow label="Avg hold (hrs)" value={aggregate.overall.avgHoldHours?.toFixed(1) ?? ""} />
                      <StatRow label="Direction up/down" value={`${aggregate.overall.directionSplit?.up ?? 0} / ${aggregate.overall.directionSplit?.down ?? 0}`} />
                    </>
                  )}
                  <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">By family</p>
                    {Object.entries(targetMovesStats.moveTypeDistribution).map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between text-[11px]">
                        <TypePill type={type} />
                        <span className="font-mono text-foreground">{count}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 pt-1.5 border-t border-border/20">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Quality dist.</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(targetMovesStats.qualityDistribution).map(([tier, cnt]) => (
                        <span key={tier} className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold border", TIER_COLORS[tier] ?? TIER_COLORS.D)}>
                          {tier}: {cnt}
                        </span>
                      ))}
                    </div>
                  </div>
                  {aggregate?.overall && Object.keys(aggregate.overall.leadInShapes ?? {}).length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Lead-in shapes</p>
                      {Object.entries(aggregate.overall.leadInShapes).slice(0, 4).map(([shape, cnt]) => (
                        <div key={shape} className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">{shape}</span>
                          <span className="font-mono text-foreground">{cnt as number}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </DomainCard>

            {/* Domain C  Recommended Calibration (from stored profile and pass results) */}
            <DomainCard title="Recommended Calibration" icon={<Zap className="w-3.5 h-3.5 text-sky-400" />}>
              {!calibProfile && !researchProfile ? (
                <p className="text-[11px] text-muted-foreground">No calibration profile yet. Detect moves then run the calibration pipeline to populate.</p>
              ) : !calibProfile && researchProfile ? (
                <>
                  <StatRow label="Status" value={researchProfile.researchStatus ?? "research_complete"} />
                  <StatRow label="Move count" value={researchProfile.moveCount ?? ""} />
                  <StatRow label="Entry model" value={researchProfile.recommendedEntryModel ?? ""} />
                  <StatRow label="Est. trades / month" value={researchProfile.estimatedTradesPerMonth?.toFixed?.(1) ?? ""} />
                  <StatRow label="Scan cadence" value={researchProfile.recommendedScanIntervalSeconds ? formatDurationCompact(researchProfile.recommendedScanIntervalSeconds) : ""} />
                  <StatRow label="Engine recommendation" value={researchProfile.engineTypeRecommendation ?? ""} />
                  {researchProfile.moveFamilyDistribution && Object.keys(researchProfile.moveFamilyDistribution).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border/20">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Move family distribution</p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(researchProfile.moveFamilyDistribution).map(([family, count]) => (
                          <span key={family} className="text-[10px] px-1.5 py-0.5 rounded border border-sky-500/20 bg-sky-500/10 text-sky-200">
                            {family}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : ((calibProfile: CalibrationProfile) => (
                <>
                  <StatRow label="Fit score" value={`${(calibProfile.fitScore * 100).toFixed(1)}%`} />
                  <StatRow label="Target / captured" value={`${calibProfile.capturedMoves} / ${calibProfile.targetMoves}`} />
                  <StatRow label="Avg move %" value={`${calibProfile.avgMovePct.toFixed(1)}%`} />
                  <StatRow label="Avg hold (hrs)" value={calibProfile.avgHoldingHours.toFixed(1)} />
                  <StatRow label="Avg capturable %" value={`${(calibProfile.avgCaptureablePct * 100).toFixed(1)}%`} />
                  <StatRow label="Holdability score" value={calibProfile.avgHoldabilityScore.toFixed(2)} />
                  {calibProfile.feeddownSchema && (() => {
                    const fd = calibProfile.feeddownSchema as Record<string, unknown>;
                    const families = Array.isArray(fd["familiesDiscovered"]) ? fd["familiesDiscovered"] as unknown[] : [];
                    const bucketModels = Array.isArray(fd["bucketModels"]) ? fd["bucketModels"] as Array<Record<string, unknown>> : [];
                    if (families.length === 0 && bucketModels.length === 0) return null;
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-cyan-400/80 uppercase tracking-wide cursor-pointer hover:text-cyan-300">
                          Deterministic Family And Bucket Models
                        </summary>
                        {families.length > 0 && (
                          <div className="mt-1">
                            <p className="text-[10px] text-muted-foreground mb-0.5">Families discovered from data</p>
                            <div className="flex flex-wrap gap-1">
                              {families.map((family, i) => (
                                <span key={`${String(family)}-${i}`} className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
                                  {String(family)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {bucketModels.length > 0 && (
                          <div className="mt-1 space-y-1">
                            <p className="text-[10px] text-muted-foreground mb-0.5">Bucket models</p>
                            {bucketModels.slice(0, 8).map((bucket, i) => (
                              <div key={`${String(bucket["strategyFamily"] ?? "bucket")}-${String(bucket["movePctBucket"] ?? i)}`} className="bg-muted/20 rounded p-1.5 space-y-0.5">
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-foreground font-medium">{String(bucket["strategyFamily"] ?? "unknown")}</span>
                                  <span className="font-mono text-cyan-300">{String(bucket["movePctBucket"] ?? "all")}</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-muted-foreground">Move count</span>
                                  <span className="font-mono text-foreground">{String(bucket["moveCount"] ?? "-")}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </details>
                    );
                  })()}
                  {/* Pass 1: Precursor Card */}
                  {calibProfile.precursorSummary && (() => {
                    const ps = calibProfile.precursorSummary as Record<string, unknown>;
                    const topConditions: unknown[] = (ps["topConditions"] ?? ps["conditions"] ?? ps["leadInPatterns"] ?? []) as unknown[];
                    const avgBars = ps["avgLeadInBars"] ?? ps["avgBars"] ?? ps["lookbackBars"];
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-amber-400/80 uppercase tracking-wide cursor-pointer hover:text-amber-300">
                          Pass 1  Precursor Conditions
                        </summary>
                        <div className="mt-1 space-y-0.5">
                          {avgBars != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Avg lead-in bars</span>
                              <span className="font-mono text-foreground">{String(avgBars)}</span>
                            </div>
                          )}
                          {Array.isArray(topConditions) && topConditions.length > 0 && (
                            <div className="mt-0.5">
                              <p className="text-[10px] text-muted-foreground mb-0.5">Top conditions</p>
                              {topConditions.slice(0, 5).map((c, i) => (
                                <p key={i} className="text-[11px] text-foreground bg-muted/20 rounded px-1 py-0.5 mb-0.5">
                                  {typeof c === "string" ? c : JSON.stringify(c)}
                                </p>
                              ))}
                            </div>
                          )}
                          {avgBars == null && (!Array.isArray(topConditions) || topConditions.length === 0) && (
                            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 overflow-x-auto max-h-20 whitespace-pre-wrap break-all">
                              {JSON.stringify(calibProfile.precursorSummary, null, 2)}
                            </pre>
                          )}
                        </div>
                      </details>
                    );
                  })()}
                  {/* Pass 2: Trigger Zone Card */}
                  {calibProfile.triggerSummary && (() => {
                    const ts2 = calibProfile.triggerSummary as Record<string, unknown>;
                    const triggerType = ts2["triggerType"] ?? ts2["type"] ?? ts2["entrySignalType"];
                    const confirmBars = ts2["confirmationBars"] ?? ts2["confirmBars"];
                    const invalidation = ts2["invalidationConditions"] ?? ts2["invalidation"];
                    const entryConditions: unknown[] = (ts2["entryConditions"] ?? ts2["conditions"] ?? []) as unknown[];
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-sky-400/80 uppercase tracking-wide cursor-pointer hover:text-sky-300">
                          Pass 2  Trigger Zone (In-Move Behavior)
                        </summary>
                        <div className="mt-1 space-y-0.5">
                          {triggerType != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Trigger type</span>
                              <span className="font-mono text-foreground">{String(triggerType)}</span>
                            </div>
                          )}
                          {confirmBars != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Confirm bars</span>
                              <span className="font-mono text-foreground">{String(confirmBars)}</span>
                            </div>
                          )}
                          {Array.isArray(entryConditions) && entryConditions.length > 0 && (
                            <div className="mt-0.5">
                              <p className="text-[10px] text-muted-foreground mb-0.5">Entry conditions</p>
                              {entryConditions.slice(0, 4).map((c, i) => (
                                <p key={i} className="text-[11px] text-foreground bg-muted/20 rounded px-1 py-0.5 mb-0.5">
                                  {typeof c === "string" ? c : JSON.stringify(c)}
                                </p>
                              ))}
                            </div>
                          )}
                          {invalidation != null && (
                            <div className="mt-0.5">
                              <span className="text-[10px] text-muted-foreground">Invalidation: </span>
                              <span className="text-[11px] text-red-400">{typeof invalidation === "string" ? invalidation : JSON.stringify(invalidation)}</span>
                            </div>
                          )}
                          {triggerType == null && (!Array.isArray(entryConditions) || entryConditions.length === 0) && (
                            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 overflow-x-auto max-h-20 whitespace-pre-wrap break-all">
                              {JSON.stringify(calibProfile.triggerSummary, null, 2)}
                            </pre>
                          )}
                        </div>
                      </details>
                    );
                  })()}
                  {/* Pass 3: In-Move Behavior Card  behavior pass structural metrics */}
                  <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                    <summary className="text-[10px] text-violet-400/80 uppercase tracking-wide cursor-pointer hover:text-violet-300">
                      Pass 3  In-Move Behavior
                    </summary>
                    <div className="mt-1 space-y-0.5">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Avg capturable %</span>
                        <span className="font-mono text-foreground">{(calibProfile.avgCaptureablePct * 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Avg holdability</span>
                        <span className="font-mono text-foreground">{calibProfile.avgHoldabilityScore.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Avg hold (hrs)</span>
                        <span className="font-mono text-foreground">{calibProfile.avgHoldingHours.toFixed(1)}</span>
                      </div>
                      {aggregate?.overall?.avgMfe != null && (
                        <div className="flex justify-between text-[11px]">
                          <span className="text-muted-foreground">Avg MFE</span>
                          <span className="font-mono text-emerald-400">{aggregate.overall.avgMfe.toFixed(2)}%</span>
                        </div>
                      )}
                      {aggregate?.overall?.behaviorPatterns && Object.keys(aggregate.overall.behaviorPatterns).length > 0 && (
                        <div className="mt-0.5">
                          <p className="text-[10px] text-muted-foreground mb-0.5">Move behavior patterns</p>
                          {Object.entries(aggregate.overall.behaviorPatterns)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 5)
                            .map(([pattern, cnt]) => (
                              <div key={pattern} className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground capitalize">{pattern}</span>
                                <span className="font-mono text-foreground">{cnt}</span>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </details>
                  {calibProfile.feeddownSchema && (() => {
                    const fd = calibProfile.feeddownSchema as Record<string, unknown>;
                    const scanCadence = fd["scanCadenceMins"] ?? fd["scanCadenceRecommendation"] ?? fd["scanCadence"];
                    const memWindow = fd["memoryWindowDays"] ?? fd["lookbackDays"] ?? fd["memoryWindow"];
                    const entryModel = fd["entryModel"] ?? fd["entryModelSummary"] ?? fd["entryModelDescription"];
                    const tradeMgmt = fd["tradeManagement"] ?? fd["tradeManagementModel"] ?? fd["tradeManagementDescription"];
                    const knownKeys = new Set(["scanCadenceMins","scanCadenceRecommendation","scanCadence","memoryWindowDays","lookbackDays","memoryWindow","entryModel","entryModelSummary","entryModelDescription","tradeManagement","tradeManagementModel","tradeManagementDescription"]);
                    const remainderKeys = Object.keys(fd).filter(k => !knownKeys.has(k));
                    return (
                      <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-1">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Recommended Settings</p>
                        {scanCadence != null && (
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Scan cadence</span>
                            <span className="font-mono text-foreground">{String(scanCadence)}</span>
                          </div>
                        )}
                        {memWindow != null && (
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Memory window</span>
                            <span className="font-mono text-foreground">{String(memWindow)}</span>
                          </div>
                        )}
                        {entryModel != null && (
                          <div className="mt-1">
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Entry model</span>
                            <p className="text-[11px] text-foreground mt-0.5 bg-muted/20 rounded p-1">
                              {typeof entryModel === "string" ? entryModel : JSON.stringify(entryModel)}
                            </p>
                          </div>
                        )}
                        {tradeMgmt != null && (
                          <div className="mt-1">
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Trade management</span>
                            <p className="text-[11px] text-foreground mt-0.5 bg-muted/20 rounded p-1">
                              {typeof tradeMgmt === "string" ? tradeMgmt : JSON.stringify(tradeMgmt)}
                            </p>
                          </div>
                        )}
                        {remainderKeys.length > 0 && (
                          <details className="mt-1">
                            <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                              More fields ({remainderKeys.length})
                            </summary>
                            <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 mt-1 overflow-x-auto max-h-28 whitespace-pre-wrap break-all">
                              {JSON.stringify(Object.fromEntries(remainderKeys.map(k => [k, fd[k]])), null, 2)}
                            </pre>
                          </details>
                        )}
                        {!scanCadence && !memWindow && !entryModel && !tradeMgmt && (
                          <pre className="text-[10px] font-mono text-muted-foreground bg-muted/20 rounded p-1.5 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
                            {JSON.stringify(calibProfile.feeddownSchema, null, 2)}
                          </pre>
                        )}
                      </div>
                    );
                  })()}
                  {/* Pass 4: Best Extraction Path Card */}
                  {(() => {
                    const ps = calibProfile.profitabilitySummary;
                    if (!ps || !ps.paths || ps.paths.length === 0) return null;
                    return (
                      <details className="mt-1.5 pt-1.5 border-t border-border/20" open>
                        <summary className="text-[10px] text-emerald-400/80 uppercase tracking-wide cursor-pointer hover:text-emerald-300">
                          Pass 4  Best Extraction Path
                        </summary>
                        <div className="mt-1 space-y-1.5">
                          {ps.topPath && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Top path</span>
                              <span className="font-mono text-emerald-400">{ps.topPath}</span>
                            </div>
                          )}
                          {ps.estimatedFitAdjustedReturn != null && (
                            <div className="flex justify-between text-[11px]">
                              <span className="text-muted-foreground">Est. fit-adj. return</span>
                              <span className="font-mono text-foreground">
                                {(ps.estimatedFitAdjustedReturn * 100).toFixed(1)}%
                              </span>
                            </div>
                          )}
                          {ps.paths.slice(0, 4).map((path, i) => (
                            <div key={path.name ?? i} className="bg-muted/20 rounded p-1.5 space-y-0.5">
                              <p className="text-[10px] font-semibold text-foreground">{path.name}</p>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">Monthly return</span>
                                <span className={cn("font-mono", path.estimatedMonthlyReturnPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                                  {(path.estimatedMonthlyReturnPct * 100).toFixed(1)}%
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">Capturable  hold</span>
                                <span className="font-mono text-foreground">
                                  {(path.captureablePct * 100).toFixed(0)}%  {path.holdDays}d
                                </span>
                              </div>
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">Confidence</span>
                                <span className="font-mono text-foreground">{path.confidence}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })()}
                  {engines.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-1">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Engine coverage</p>
                      {engines.map((eng) => (
                        <div key={eng.engineName ?? "unknown"} className="space-y-0.5">
                          <p className="text-[10px] font-semibold text-foreground truncate">{eng.engineName ?? ""}</p>
                          <div className="flex justify-between text-[11px]">
                            <span className="text-muted-foreground">Matched / fire rate</span>
                            <span className="font-mono text-foreground">{eng.matchedMoves}  {(eng.fireRate * 100).toFixed(1)}%</span>
                          </div>
                          {(eng.topMissReasons?.length ?? 0) > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              Miss: {(eng.topMissReasons ?? []).slice(0, 2).join("  ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Built {new Date(calibProfile.generatedAt).toLocaleDateString()}  window {calibProfile.windowDays}d
                  </p>
                </>
              ))(calibProfile as CalibrationProfile)}
            </DomainCard>

          </div>
        )}
      </div>

      {/*  Honest Fit & Profitability  */}
      {(calibrationCoverage || calibProfile?.profitabilitySummary) && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Target className="w-3.5 h-3.5 text-primary" />
            Honest Fit &amp; Profitability
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Fit stats */}
            <div className="space-y-0.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Move Coverage</p>
              {calibrationCoverage && (
                <>
                  <StatRow label="Source" value={calibrationCoverage.source} />
                  <StatRow label="Target moves" value={calibrationCoverage.targetMoves} />
                  <StatRow label="Captured moves" value={calibrationCoverage.capturedMoves} />
                  <StatRow label="Missed moves" value={calibrationCoverage.missedMoves} />
                  <StatRow label="Fit score" value={`${(calibrationCoverage.fitScore * 100).toFixed(1)}%`} />
                  <StatRow label="Avg move %" value={`${calibrationCoverage.avgMovePct.toFixed(2)}%`} />
                  <StatRow label="Avg capturable %" value={`${(calibrationCoverage.avgCaptureablePct * 100).toFixed(1)}%`} />
                  <StatRow
                    label="Avg extracted (est.)"
                    value={`${(calibrationCoverage.avgMovePct * calibrationCoverage.avgCaptureablePct).toFixed(2)}%`}
                  />
                  <StatRow label="Holdability score" value={calibrationCoverage.avgHoldabilityScore.toFixed(2)} />
                  {calibProfile && aggregate?.overall && aggregate.overall.capturedMoves !== calibProfile.capturedMoves && (
                    <p className="text-[10px] text-amber-300/90 pt-1">
                      Current service replay is {aggregate.overall.capturedMoves}/{aggregate.overall.targetMoves}; synthesized calibration is shown above.
                    </p>
                  )}
                  {behaviorProfile && (
                    <StatRow label="Engine win rate" value={`${(behaviorProfile.overallWinRate * 100).toFixed(1)}%`} />
                  )}
                </>
              )}
              {(aggregate?.overall?.missReasons?.length ?? 0) > 0 && (
                <div className="mt-2 pt-2 border-t border-border/20">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Miss reasons</p>
                  {(aggregate!.overall.missReasons ?? []).slice(0, 4).map((mr) => (
                    <div key={mr.reason} className="flex justify-between text-[11px]">
                      <span className="text-muted-foreground truncate max-w-[180px]">{mr.reason}</span>
                      <span className="font-mono text-foreground">{mr.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Profitability paths */}
            <div className="space-y-0.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Profitability Paths</p>
              {!calibProfile?.profitabilitySummary ? (
                <p className="text-[11px] text-muted-foreground">Generate stored pass results to populate profitability estimates.</p>
              ) : (
                <>
                  <StatRow label="Top path" value={calibProfile.profitabilitySummary.topPath ?? ""} />
                  <StatRow
                    label="Fit-adjusted return"
                    value={calibProfile.profitabilitySummary.estimatedFitAdjustedReturn != null
                      ? `${(calibProfile.profitabilitySummary.estimatedFitAdjustedReturn * 100).toFixed(1)}%/mo`
                      : ""}
                  />
                  {(calibProfile.profitabilitySummary.paths ?? []).map((path) => (
                    <div key={path.name} className="mt-1.5 pt-1.5 border-t border-border/20">
                      <p className="text-[10px] font-semibold text-foreground mb-0.5">{path.name}</p>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Monthly return</span>
                        <span className={cn("font-mono", path.estimatedMonthlyReturnPct >= 0 ? "text-emerald-400" : "text-red-400")}>
                          {(path.estimatedMonthlyReturnPct * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Annualized</span>
                        <span className="font-mono text-foreground">
                          {(path.estimatedMonthlyReturnPct * 12 * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Capturable %</span>
                        <span className="font-mono text-foreground">{(path.captureablePct * 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Hold (days)</span>
                        <span className="font-mono text-foreground">{path.holdDays.toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">Confidence</span>
                        <span className="font-mono text-foreground">{path.confidence}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {researchProfile && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-primary" />
              Research Profile Output
            </h3>
            <span
              className={cn(
                "text-[11px] px-2 py-0.5 rounded border font-medium",
                domain === "active"
                  ? "text-sky-300 border-sky-500/30 bg-sky-500/10"
                  : researchProfile.researchStatus === "engine_candidate"
                    ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                    : researchProfile.researchStatus === "not_worth_building"
                      ? "text-red-300 border-red-500/30 bg-red-500/10"
                      : "text-amber-300 border-amber-500/30 bg-amber-500/10"
              )}
            >
              {domain === "active"
                ? "Engine Refinement Ready"
                : researchProfile.researchStatus === "engine_candidate"
                  ? "Engine Candidate"
                  : researchProfile.researchStatus === "not_worth_building"
                    ? "Not Worth Building"
                    : "Research Complete"}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-0.5">
              <StatRow label="Move count" value={researchProfile.moveCount ?? ""} />
              <StatRow label="Estimated trades / month" value={researchProfile.estimatedTradesPerMonth?.toFixed?.(1) ?? ""} />
              <StatRow label="Scan cadence" value={researchProfile.recommendedScanIntervalSeconds ? formatDurationCompact(researchProfile.recommendedScanIntervalSeconds) : ""} />
              <StatRow label="Entry model" value={researchProfile.recommendedEntryModel ?? ""} />
              <StatRow
                label="Hold duration bands"
                value={(() => {
                  const h = researchProfile.recommendedHoldProfile ?? {};
                  const p25 = Number(h.p25Hours ?? 0);
                  const p50 = Number(h.p50Hours ?? 0);
                  const p75 = Number(h.p75Hours ?? 0);
                  return `${p25.toFixed(1)}h / ${p50.toFixed(1)}h / ${p75.toFixed(1)}h`;
                })()}
              />
            </div>
            <div className="space-y-0.5">
              <StatRow
                label="TP model"
                value={formatModelDetails(researchProfile.recommendedTpModel, "tp") || "n/a"}
              />
              <StatRow
                label="SL model"
                value={formatModelDetails(researchProfile.recommendedSlModel, "sl") || "n/a"}
              />
              <StatRow
                label="Lifecycle protection model"
                value={formatModelDetails(researchProfile.recommendedLifecycleProtectionModel ?? researchProfile.recommendedTrailingModel, "lifecycle") || "n/a"}
              />
              <StatRow label="Profitability summary" value={researchProfile.estimatedFitAdjustedMonthlyReturnPct != null ? `${researchProfile.estimatedFitAdjustedMonthlyReturnPct.toFixed(2)}%/mo` : ""} />
              <StatRow label="Engine recommendation" value={researchProfile.engineTypeRecommendation ?? ""} />
            </div>
          </div>
          {(researchProfile.moveFamilyDistribution && Object.keys(researchProfile.moveFamilyDistribution).length > 0) && (
            <div className="pt-2 border-t border-border/20">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Move family distribution</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(researchProfile.moveFamilyDistribution).map(([family, count]) => (
                  <span key={family} className="px-1.5 py-0.5 rounded border border-border/40 text-[10px] text-foreground bg-muted/20">
                    {family}: {count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

        {parityErr && showAdvancedDiagnostics && <ErrorBox msg={parityErr} />}
        {showAdvancedDiagnostics && parityReport && (
          <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs font-semibold text-indigo-200">CRASH300 Parity Diagnostics</p>
              <span className={cn(
                "text-[11px] px-2 py-0.5 rounded border",
                parityHasAnyMatches
                  ? "text-emerald-200 border-emerald-500/30 bg-emerald-500/10"
                  : "text-amber-200 border-amber-500/30 bg-amber-500/10",
              )}>
                matched {parityMatchedMoves}/{Number(parityTotals?.totalMoves ?? 0)}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">No candidate</span><p className="font-mono">{Number(parityTotals?.noCandidate ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Family mismatch</span><p className="font-mono">{Number(parityTotals?.familyMismatch ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Direction mismatch</span><p className="font-mono">{Number(parityTotals?.directionMismatch ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Bucket mismatch</span><p className="font-mono">{Number(parityTotals?.bucketMismatch ?? 0)}</p></div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5"><span className="text-muted-foreground">Setup evidence failed</span><p className="font-mono">{Number(parityTotals?.setupEvidenceFailed ?? 0)}</p></div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Top failure reasons</p>
                {parityFailureRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityFailureRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Direction matrix</p>
                {parityDirectionRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityDirectionRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Selected runtime family</p>
                {parityFamilyRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityFamilyRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <p className="text-muted-foreground mb-1">Selected bucket</p>
                {parityBucketRows.length === 0 ? <p className="font-mono text-muted-foreground">n/a</p> : parityBucketRows.slice(0, 6).map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5 md:col-span-2">
                <p className="text-muted-foreground mb-1">Top failing gate components</p>
                <p className="font-mono">no_coordinator_output: {Number(parityDiagnostics?.noCoordinatorOutput ?? 0)} | runtime_calibrated_setup_weak: {Number(parityDiagnostics?.runtimeCalibratedSetupWeak ?? 0)}</p>
                {parityGateRows.length === 0 ? <p className="font-mono text-muted-foreground mt-1">n/a</p> : parityGateRows.map(([k, v]) => <p key={k} className="font-mono">{k}: {v}</p>)}
              </div>
            </div>
          </div>
        )}

        {showAdvancedDiagnostics && (
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-xs font-semibold text-cyan-200">Internal Optimisation Stage</p>
              <p className="text-[11px] text-muted-foreground">
                Runs V3 backtest candidates against calibrated moves. Winners are staged only, never auto-promoted.
              </p>
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded border border-cyan-500/25 text-cyan-200 bg-cyan-500/10">
              {String(optimiserRun?.status ?? optimiserStatus?.status ?? "not run")}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runBacktestOptimiser}
              disabled={optimiserBusy !== null || !runtimeModel?.lifecycle?.hasPromotedModel || optimiserLockedByParity}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/30 text-xs text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/15 disabled:opacity-50"
            >
              {optimiserBusy === "run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BarChart2 className="w-3.5 h-3.5" />}
              Run Internal Optimisation
            </button>
            {optimiserHasExistingRun && (
              <>
                <button
                  type="button"
                  onClick={cancelOptimiser}
                  disabled={optimiserBusy !== null || !optimiserRunId || !optimiserIsRunning}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-xs text-red-300 bg-red-500/10 hover:bg-red-500/15 disabled:opacity-50"
                >
                  {optimiserBusy === "cancel" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                  Cancel Internal Optimisation
                </button>
                <button
                  type="button"
                  onClick={() => void refreshOptimiserStatus()}
                  disabled={optimiserBusy !== null || !optimiserRunId}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/40 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {optimiserBusy === "refresh" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Refresh Internal Optimisation
                </button>
                <button
                  type="button"
                  onClick={stageOptimiserWinner}
                  disabled={optimiserBusy !== null || !optimiserRunId || !optimiserSelected}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-xs text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/15 disabled:opacity-50"
                >
                  {optimiserBusy === "stage" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  Stage Optimised Winner
                </button>
              </>
            )}
          </div>
          {optimiserLockedByParity && (
            <ErrorBox msg="Internal optimisation disabled: CRASH300 runtime does not recognise calibrated moves yet." />
          )}
          {!optimiserHasExistingRun && (
            <p className="text-[11px] text-muted-foreground">
              Internal optimisation controls (refresh/cancel/stage) will appear after a valid run exists.
            </p>
          )}

          {optimiserErr && <ErrorBox msg={optimiserErr} />}
          {optimiserRun && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[11px]">
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Phase</span>
                <p className="font-mono text-foreground">{optimiserPhase}</p>
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Iteration</span>
                <p className="font-mono text-foreground">{String(optimiserRun?.currentIteration ?? "n/a")}</p>
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Candidate</span>
                <p className="font-mono text-foreground">{String(optimiserRun?.currentCandidate ?? "n/a")}</p>
              </div>
              <div className="rounded border border-border/30 bg-background/30 px-2 py-1.5">
                <span className="text-muted-foreground">Heartbeat</span>
                <p className="font-mono text-foreground">{optimiserHeartbeat}</p>
              </div>
            </div>
          )}
          {optimiserFailureReason && (
            <ErrorBox msg={`Optimiser failed: ${optimiserFailureReason}`} />
          )}
          {optimiserFailureStack && (
            <details className="rounded border border-border/30 bg-background/30 p-2">
              <summary className="text-[11px] text-muted-foreground cursor-pointer">Failure stack trace</summary>
              <pre className="mt-2 text-[10px] overflow-x-auto whitespace-pre-wrap text-red-300 font-mono">
                {optimiserFailureStack}
              </pre>
            </details>
          )}

          {(optimiserBaseline || optimiserWinnerMetrics) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-border/30 bg-background/30 p-3 space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Baseline</p>
                <StatRow label="Profit factor" value={Number(optimiserBaseline?.profitFactor ?? 0).toFixed(2)} />
                <StatRow label="Total P&L" value={`${(Number(optimiserBaseline?.totalPnlPct ?? 0) * 100).toFixed(2)}%`} />
                <StatRow label="Win rate" value={`${(Number(optimiserBaseline?.winRate ?? 0) * 100).toFixed(1)}%`} />
                <StatRow label="Drawdown" value={`${(Number(optimiserBaseline?.maxDrawdownPct ?? 0) * 100).toFixed(1)}%`} />
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Selected Winner</p>
                <StatRow label="Candidate" value={String(optimiserWinner?.params ? (optimiserWinner.params as Record<string, unknown>).key ?? "winner" : "winner")} />
                <StatRow label="Profit factor" value={Number(optimiserWinnerMetrics?.profitFactor ?? 0).toFixed(2)} />
                <StatRow label="Total P&L" value={`${(Number(optimiserWinnerMetrics?.totalPnlPct ?? 0) * 100).toFixed(2)}%`} />
                <StatRow label="Win rate" value={`${(Number(optimiserWinnerMetrics?.winRate ?? 0) * 100).toFixed(1)}%`} />
                <StatRow label="Drawdown" value={`${(Number(optimiserWinnerMetrics?.maxDrawdownPct ?? 0) * 100).toFixed(1)}%`} />
              </div>
            </div>
          )}
        </div>
        )}

      {/*  Detected Moves List  */}
      <div className="rounded-xl border border-border/50 bg-card">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">Detected Moves</span>
            <span className="text-[11px] text-muted-foreground">({moveRows.length} shown)</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={moveTypeFilter}
              onChange={e => setMoveTypeFilter(e.target.value)}
              className="text-[11px] bg-background border border-border/50 rounded px-1.5 py-1 text-foreground focus:outline-none"
            >
              {moveTypesFilterForSymbol(symbol).map(t => (
                <option key={t} value={t}>{t === "all" ? "All types" : formatMoveTypeLabel(t)}</option>
              ))}
            </select>
          </div>
        </div>

        {movesLoading && (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />Loading moves
          </div>
        )}

        {!movesLoading && movesMagnitudeSummary && (
          <div className="px-4 py-2.5 border-b border-border/20 bg-muted/10">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
              <span className="text-muted-foreground uppercase tracking-wide text-[10px] font-medium self-center">Magnitude</span>
              <span>Min: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.min * 100).toFixed(2)}%</strong></span>
              <span>P25: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.p25 * 100).toFixed(2)}%</strong></span>
              <span>Median: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.median * 100).toFixed(2)}%</strong></span>
              <span>P75: <strong className="font-mono text-foreground">{(movesMagnitudeSummary.p75 * 100).toFixed(2)}%</strong></span>
              <span>P90: <strong className="font-mono text-primary">{(movesMagnitudeSummary.p90 * 100).toFixed(2)}%</strong></span>
              <span>Max: <strong className="font-mono text-emerald-400">{(movesMagnitudeSummary.max * 100).toFixed(2)}%</strong></span>
            </div>
          </div>
        )}

        {!movesLoading && moves.length === 0 && (
          <div className="px-4 py-6 text-center">
            <Target className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">No moves found. Run "Detect Moves" first or adjust filters.</p>
          </div>
        )}

        {!movesLoading && moves.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/30 text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-3 py-2 font-medium">Tier</th>
                    <th className="text-left px-3 py-2 font-medium">Dir</th>
                    <th className="text-left px-3 py-2 font-medium">Move %</th>
                    <th className="text-left px-3 py-2 font-medium">Hold (h)</th>
                    <th className="text-left px-3 py-2 font-medium">Quality %</th>
                    <th className="text-left px-3 py-2 font-medium">Lead-in</th>
                    <th className="text-left px-3 py-2 font-medium">Start</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedMoves.map((m) => (
                    <tr key={m.id} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-1.5"><TypePill type={m.moveType} /></td>
                      <td className="px-3 py-1.5"><TierPill tier={m.relativeTier} /></td>
                      <td className="px-3 py-1.5">
                        {m.direction === "up"
                          ? <TrendingUp   className="w-3.5 h-3.5 text-emerald-400" />
                          : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.movePct != null ? `${(m.movePct * 100).toFixed(1)}%` : ""}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.holdingMinutes != null ? (m.holdingMinutes / 60).toFixed(1) : ""}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-foreground">
                        {m.qualityPercentile != null
                          ? `${m.qualityPercentile}%`
                          : m.qualityScore != null ? m.qualityScore.toFixed(0) : ""}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{m.leadInShape ?? ""}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {m.startTs ? new Date(m.startTs * 1000).toLocaleDateString() : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {moveRows.length > 10 && (
              <button
                onClick={() => setMovesExpanded(p => !p)}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-muted-foreground hover:text-foreground border-t border-border/30 transition-colors"
              >
                {movesExpanded
                  ? <><ChevronUp className="w-3.5 h-3.5" />Show less</>
                  : <><ChevronDown className="w-3.5 h-3.5" />Show all {moveRows.length} moves</>}
              </button>
            )}
          </>
        )}
      </div>

      {!hideReportsActions ? (
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Export Calibration Data</h3>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => doExport("moves", `calibration/export/${symbol}?type=moves`, `calibration_moves_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["moves"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export all detected structural moves for this symbol"
          >
            {exportBusy["moves"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Detected Moves
          </button>

          <button
            onClick={() => doExport("passes", `calibration/export/${symbol}?type=passes`, `calibration_passes_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["passes"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export all calibration pass run records for this symbol"
          >
            {exportBusy["passes"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Pass Results
          </button>

          <button
            onClick={() => doExport("profile", `calibration/export/${symbol}?type=profile`, `calibration_profile_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["profile"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export stored calibration profiles (all move types) for this symbol"
          >
            {exportBusy["profile"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Calibration Profile
          </button>

          <button
            onClick={() => doExport("comparison", `calibration/export/${symbol}?type=comparison`, `calibration_comparison_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["comparison"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export 3-domain comparison summary (aggregate + engine + scoring + health)"
          >
            {exportBusy["comparison"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Comparison Summary
          </button>

          <button
            onClick={() => doExport("parity", `calibration/runtime-model/${symbol}/parity-report?windowDays=${windowDays}`, `calibration_parity_${symbol}_${new Date().toISOString().slice(0,10)}.json`)}
            disabled={!!exportBusy["parity"]}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            title="Export per-move CRASH300 parity verdicts using the symbol-service runtime flow"
          >
            {exportBusy["parity"] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export Parity Report
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          All exports are read-only research artifacts. None of these outputs are connected to live execution.
        </p>
        <div className="border-t border-border/30 pt-3 space-y-2">
          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Import Calibration Data</h4>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Type</span>
              <select
                value={importType}
                onChange={e => setImportType(e.target.value as typeof importType)}
                className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="auto">Auto detect</option>
                <option value="moves">Detected moves</option>
                <option value="passes">Pass results</option>
                <option value="profile">Calibration profile</option>
                <option value="comparison">Comparison</option>
              </select>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer pb-1">
              <input
                type="checkbox"
                checked={importReplace}
                onChange={e => setImportReplace(e.target.checked)}
                className="accent-primary"
              />
              Replace existing
            </label>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              className="hidden"
              onChange={e => void importCalibrationFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              disabled={importBusy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
            >
              {importBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              {importBusy ? "Importing..." : "Import JSON Files"}
            </button>
          </div>
          {importMessage && <SuccessBox msg={importMessage} />}
          {importError && <ErrorBox msg={importError} />}
        </div>
      </div>
      ) : null}

    </div>
  );
}

function downloadJsonFile(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseBucketLabel(input: string): number {
  const normalized = String(input).replace(/_/g, "-");
  const match = normalized.match(/(\d+(?:\.\d+)?)/g);
  return match && match[0] ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

function sortBucketEntries(entries: Array<[string, unknown]>) {
  return [...entries].sort((a, b) => {
    const diff = parseBucketLabel(a[0]) - parseBucketLabel(b[0]);
    return Number.isFinite(diff) && diff !== 0 ? diff : a[0].localeCompare(b[0]);
  });
}

function asUiRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isCalibratedMoveBucketKey(key: string): boolean {
  return /^\d+_to_\d+_pct$/i.test(key) || /^\d+[-_]\d+$/i.test(key) || /^\d+\|\d+$/i.test(key);
}

function formatCalibratedBucketLabel(key: string): string {
  const lowerUpper = key.match(/(\d+)[^\d]+(\d+)/);
  if (lowerUpper) return `${lowerUpper[1]}–${lowerUpper[2]}`;
  return key.replace(/_/g, " ");
}

function extractCalibratedBucketEntries(model: RuntimeSymbolModelUi | Record<string, unknown> | null | undefined) {
  const record = asUiRecord(model as unknown);
  const tpModel = asUiRecord(record.tpModel);
  const bucketMap = asUiRecord(tpModel.buckets);
  return sortBucketEntries(
    Object.entries(bucketMap).filter(([key]) => isCalibratedMoveBucketKey(key)),
  );
}

function extractRuntimeTpBucketEntries(model: RuntimeSymbolModelUi | Record<string, unknown> | null | undefined) {
  const record = asUiRecord(model as unknown);
  const tpModel = asUiRecord(record.tpModel);
  const bucketMap = asUiRecord(tpModel.buckets);
  return Object.entries(bucketMap)
    .filter(([key]) => key.includes("|"))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function formatRuntimeTpBucketLabel(key: string) {
  return key.split("|").map((part) => part.replace(/_/g, " ")).join(" / ");
}

function ActiveWorkerTasksCard({ service }: { service: string }) {
  const [jobs, setJobs] = useState<WorkerJobUi[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const loadJobs = useCallback(async (silent = false) => {
    if (!silent) setErr(null);
    try {
      const data = await apiFetch(`worker/jobs?serviceId=${encodeURIComponent(service)}&activeOnly=true&limit=5`) as {
        jobs?: WorkerJobUi[];
      };
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (e: unknown) {
      if (!silent) setErr(e instanceof Error ? e.message : "Failed to load active worker jobs");
    }
  }, [service]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await loadJobs(true);
    };
    void tick();
    const handle = window.setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [loadJobs]);

  const primaryJob = jobs[0] ?? null;
  if (!primaryJob && !err) return null;

  const cancelWorkerTask = async () => {
    if (!primaryJob) return;
    try {
      await apiFetch(`worker/jobs/${primaryJob.id}/cancel`, { method: "POST" });
      await loadJobs(true);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to cancel worker task");
    }
  };

  const currentPass = Number(primaryJob?.taskState?.currentPass ?? 0);
  const maxPasses = Number(primaryJob?.taskState?.maxPasses ?? 0);
  const cancellationRequested = Boolean(primaryJob?.taskState?.cancelRequestedAt) || primaryJob?.stage === "cancelling";
  const bestWinRate = Number(primaryJob?.taskState?.bestSummary && (primaryJob.taskState.bestSummary as Record<string, unknown>).bestWinRate);
  const bestSlRate = Number(primaryJob?.taskState?.bestSummary && (primaryJob.taskState.bestSummary as Record<string, unknown>).bestSlRate);
  const bestProfitFactor = Number(primaryJob?.taskState?.bestSummary && (primaryJob.taskState.bestSummary as Record<string, unknown>).bestProfitFactor);
  const bestTradeCount = Number(primaryJob?.taskState?.bestSummary && (primaryJob.taskState.bestSummary as Record<string, unknown>).bestTradeCount);

  return (
    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-cyan-100">Active Worker Task</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Heavy research jobs run in the worker service so the main API app stays focused on UI, ticks, and lightweight reads.
          </p>
        </div>
        {primaryJob && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[10px] text-cyan-100">
              {formatWorkerTaskLabel(primaryJob.taskType)} #{primaryJob.id}
            </span>
            {(primaryJob.status === "running" || primaryJob.status === "queued") && !cancellationRequested && (
              <button
                type="button"
                onClick={() => void cancelWorkerTask()}
                className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/20"
              >
                <Trash2 className="w-3 h-3" />
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      {err && <ErrorBox msg={err} />}

      {primaryJob ? (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="truncate">{primaryJob.message ?? primaryJob.stage.replace(/_/g, " ")}</span>
              <span className="font-mono text-cyan-200">{primaryJob.progressPct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-background/80">
              <div className="h-full bg-cyan-400 transition-all duration-300" style={{ width: `${primaryJob.progressPct}%` }} />
            </div>
            {cancellationRequested && (
              <p className="text-[11px] text-amber-200">
                Cancellation requested. The worker is waiting for a safe checkpoint before marking this task fully cancelled.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-[11px]">
            <div className="rounded-lg border border-border/30 bg-background/40 p-3">
              <p className="text-muted-foreground uppercase tracking-wide">Status / Stage</p>
              <p className="mt-1 font-mono text-foreground">{primaryJob.status} / {primaryJob.stage.replace(/_/g, " ")}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-background/40 p-3">
              <p className="text-muted-foreground uppercase tracking-wide">Pass</p>
              <p className="mt-1 font-mono text-foreground">{maxPasses > 0 ? `${currentPass}/${maxPasses}` : "n/a"}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-background/40 p-3">
              <p className="text-muted-foreground uppercase tracking-wide">Heartbeat</p>
              <p className="mt-1 font-mono text-foreground">{heartbeatAgeLabel(primaryJob.heartbeatAt)}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-background/40 p-3">
              <p className="text-muted-foreground uppercase tracking-wide">Elapsed</p>
              <p className="mt-1 font-mono text-foreground">{elapsedLabel(primaryJob.startedAt)}</p>
            </div>
          </div>

          {primaryJob.taskType === "elite_synthesis" && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-[11px]">
              <div className="rounded-lg border border-border/30 bg-background/40 p-3">
                <p className="text-muted-foreground uppercase tracking-wide">Best WR</p>
                <p className="mt-1 font-mono text-foreground">{Number.isFinite(bestWinRate) ? `${(bestWinRate * 100).toFixed(2)}%` : "n/a"}</p>
              </div>
              <div className="rounded-lg border border-border/30 bg-background/40 p-3">
                <p className="text-muted-foreground uppercase tracking-wide">Best SL</p>
                <p className="mt-1 font-mono text-foreground">{Number.isFinite(bestSlRate) ? `${(bestSlRate * 100).toFixed(2)}%` : "n/a"}</p>
              </div>
              <div className="rounded-lg border border-border/30 bg-background/40 p-3">
                <p className="text-muted-foreground uppercase tracking-wide">PF</p>
                <p className="mt-1 font-mono text-foreground">{Number.isFinite(bestProfitFactor) ? bestProfitFactor.toFixed(2) : "n/a"}</p>
              </div>
              <div className="rounded-lg border border-border/30 bg-background/40 p-3">
                <p className="text-muted-foreground uppercase tracking-wide">Best trades</p>
                <p className="mt-1 font-mono text-foreground">{Number.isFinite(bestTradeCount) ? String(bestTradeCount) : "n/a"}</p>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-border/30 bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
          No active worker tasks for {getSymbolLabel(service)}.
        </div>
      )}
    </div>
  );
}

function lifecycleTone(status: "complete" | "warning" | "blocked" | "not_run") {
  return status === "complete"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
    : status === "warning"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
      : status === "blocked"
        ? "border-red-500/30 bg-red-500/10 text-red-200"
        : "border-border/40 bg-muted/20 text-muted-foreground";
}

function runtimeValidationSummary(status: string | undefined) {
  switch (status) {
    case "passed":
      return "Runtime validation passed";
    case "running":
      return "Runtime validation running";
    case "failed":
      return "Runtime validation failed";
    default:
      return "Runtime validation not run";
  }
}

function ServicePipelinePanel({
  service,
  onJumpToTab,
}: {
  service: string;
  onJumpToTab: (tab: ResearchTabId) => void;
}) {
  const [lifecycle, setLifecycle] = useState<ServiceLifecycleStatusUi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedStage, setExpandedStage] = useState("Data Coverage");

  const load = useCallback(async () => {
    setErr(null);
    try {
      const lifecycleResp = await apiFetch(`research/${service}/service-lifecycle`);
      setLifecycle(((lifecycleResp as { serviceLifecycleStatus?: ServiceLifecycleStatusUi }).serviceLifecycleStatus) ?? null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to load service lifecycle");
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  const fallbackStages = lifecycle ? [
    {
      label: "Data Coverage",
      tab: "data" as ResearchTabId,
      status: lifecycle.dataCoverageStatus === "ready" ? "complete" : lifecycle.dataCoverageStatus === "stale" ? "warning" : "blocked",
      detail: lifecycle.latestCandleTs ? formatRuntimeDate(lifecycle.latestCandleTs) : "No candles yet",
    },
    {
      label: "Full Calibration",
      tab: "calibration" as ResearchTabId,
      status: lifecycle.calibrationStatus === "complete" ? "complete" : "not_run",
      detail: lifecycle.latestCalibrationRunId ? `run ${lifecycle.latestCalibrationRunId}` : "Not run",
    },
    {
      label: "Build Runtime Model",
      tab: "synthesis" as ResearchTabId,
      status: lifecycle.latestSynthesisJobId && lifecycle.synthesisStatus === "completed" ? "complete" : lifecycle.latestSynthesisJobId ? "warning" : "not_run",
      detail: lifecycle.latestSynthesisJobId ? `job #${lifecycle.latestSynthesisJobId}` : "Not run",
    },
    {
      label: "Runtime Staged",
      tab: "synthesis" as ResearchTabId,
      status: lifecycle.stagedCandidateArtifactId ? "complete" : "not_run",
      detail: lifecycle.stagedCandidateArtifactId ?? "Not staged",
    },
    {
      label: "Runtime Validated",
      tab: "runtime" as ResearchTabId,
      status: lifecycle.runtimeValidationStatus === "passed" ? "complete" : lifecycle.runtimeValidationStatus === "failed" ? "blocked" : lifecycle.runtimeValidationStatus === "running" ? "warning" : "not_run",
      detail: runtimeValidationSummary(lifecycle.runtimeValidationStatus),
    },
    {
      label: "Runtime Promoted",
      tab: "runtime" as ResearchTabId,
      status: lifecycle.promotedRuntimeArtifactId ? "complete" : "not_run",
      detail: lifecycle.promotedRuntimeArtifactId ?? "Not promoted",
    },
    {
      label: "Stream Active",
      tab: "data" as ResearchTabId,
      status: lifecycle.streamState === "active" ? "complete" : "blocked",
      detail: lifecycle.streamState === "active" ? "Live stream active" : "Stream inactive",
    },
    {
      label: "Allocator Connected",
      tab: "runtime" as ResearchTabId,
      status: lifecycle.allocatorConnected ? "complete" : "blocked",
      detail: lifecycle.executionAllowedForActiveMode ? "Ready for Paper allocator" : "Waiting on mode or risk gates",
    },
    {
      label: "Monitoring",
      tab: "runtime" as ResearchTabId,
      status: lifecycle.executionAllowedForActiveMode ? "complete" : "warning",
      detail: lifecycle.executionAllowedForActiveMode ? "Execution allowed for active mode" : lifecycle.nextRequiredAction,
    },
  ] : [];

  const stageTab = (label: string): ResearchTabId => {
    switch (label) {
      case "Data Coverage":
      case "Stream Active":
        return "data";
      case "Full Calibration":
        return "calibration";
      case "Build Runtime Model":
      case "Runtime Staged":
        return "synthesis";
      case "Runtime Validated":
      case "Runtime Promoted":
      case "Allocator Connected":
      case "Monitoring":
        return "runtime";
      default:
        return "reports";
    }
  };

  const stages = lifecycle?.workflowStages?.length
    ? lifecycle.workflowStages.map((stage) => ({
        label: stage.label,
        tab: stageTab(stage.label),
        status: stage.status === "incomplete" ? "not_run" : stage.status,
        detail: [
          stage.sourceRunId ? `source ${stage.sourceRunId}` : null,
          stage.timestamp ? formatRuntimeDate(stage.timestamp) : null,
          stage.nextAction ? `next ${stage.nextAction}` : null,
        ].filter(Boolean).join(" | ") || stage.blockers[0] || "No details yet",
      }))
    : fallbackStages;

  const nextStepGuide = lifecycle ? (() => {
    if (lifecycle.dataCoverageStatus !== "ready") {
      return {
        tab: "data" as ResearchTabId,
        action: "Open Data & Coverage",
        detail: "Review candle coverage first, then run Clean Canonical Data or Download Historical Data before calibration.",
      };
    }
    if (lifecycle.calibrationStatus !== "complete") {
      return {
        tab: "calibration" as ResearchTabId,
        action: "Open Calibration",
        detail: "Run or review the latest calibration so the service has detected moves, research profile output, and runtime research artifacts.",
      };
    }
    if (lifecycle.synthesisStatus !== "completed") {
      return {
        tab: "synthesis" as ResearchTabId,
        action: "Build Runtime Model",
        detail: "Run Build Runtime Model from the build tab and use the worker-backed history card below it to monitor progress.",
      };
    }
    if (!lifecycle.stagedCandidateArtifactId) {
      return {
        tab: "synthesis" as ResearchTabId,
        action: "Review Runtime Build Result",
        detail: "Open Build Runtime Model and review the consolidated build result before staging or promotion.",
      };
    }
    if (!lifecycle.promotedRuntimeArtifactId) {
      return {
        tab: "runtime" as ResearchTabId,
        action: "Validate Runtime",
        detail: "Open Runtime Model and run the consolidated validation action over the staged runtime candidate.",
      };
    }
    if (lifecycle.runtimeValidationStatus !== "passed") {
      return {
        tab: "runtime" as ResearchTabId,
        action: "Validate Runtime",
        detail: "Run the single Validate Runtime action before promoting the staged candidate.",
      };
    }
    if (lifecycle.streamState !== "active") {
      return {
        tab: "data" as ResearchTabId,
        action: "Open Data",
        detail: "The promoted runtime is ready, but the symbol stream must be active before it can emit candidates into the allocator.",
      };
    }
    if (!lifecycle.executionAllowedForActiveMode) {
      return {
        tab: "runtime" as ResearchTabId,
        action: "Review Runtime Mode Gates",
        detail: "The service is promoted, but execution is still blocked by the current mode, validation state, or allocator/risk gates.",
      };
    }
    return {
      tab: "backtests" as ResearchTabId,
        action: "Stream / Monitor",
        detail: "The service has completed the core pipeline. Use Stream / Monitor and read-only reports to compare expected and realised behaviour.",
    };
  })() : null;

  const activeStage = stages.find((stage) => stage.label === expandedStage) ?? stages[0] ?? null;
  const stageTone = (status: string) =>
    status === "complete"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
      : status === "warning"
        ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
        : status === "blocked"
          ? "border-red-500/25 bg-red-500/10 text-red-200"
          : "border-border/30 bg-background/30 text-muted-foreground";

  return (
    <div className="rounded-xl border border-border/50 bg-card p-3 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold">Service Pipeline</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Data Coverage {">"} Full Calibration {">"} Build Runtime Model {">"} Runtime Staged {">"} Runtime Validated {">"} Runtime Promoted {">"} Stream Active {">"} Allocator Connected {">"} Monitoring
          </p>
        </div>
        {lifecycle ? (
          <span className={cn("px-2 py-0.5 rounded border text-[11px] font-medium", lifecycle.executionAllowedForActiveMode ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-amber-500/30 bg-amber-500/10 text-amber-200")}>
            Next: {lifecycle.nextRequiredAction}
          </span>
        ) : null}
      </div>
      {err && <ErrorBox msg={err} />}
      {lifecycle ? (
        <>
          <div className="flex flex-wrap gap-2">
            {stages.map((stage) => (
              <button
                key={stage.label}
                type="button"
                onClick={() => setExpandedStage(stage.label)}
                className={cn("rounded-lg border px-3 py-2 text-left text-[11px] min-w-[132px] transition-colors", stageTone(stage.status), activeStage?.label === stage.label && "ring-1 ring-primary/40")}
              >
                <p className="font-medium">{stage.label}</p>
              </button>
            ))}
          </div>
          {activeStage && (
            <div className="rounded-lg border border-border/30 bg-background/35 p-3 text-[11px]">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="space-y-1">
                  <p className="text-muted-foreground uppercase tracking-wide">{activeStage.label}</p>
                  <p className="font-medium text-foreground">{activeStage.detail}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onJumpToTab(activeStage.tab)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/10 text-xs text-primary hover:bg-primary/15"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                  Open {activeStage.tab === "data" ? "Data & Coverage" : activeStage.tab === "calibration" ? "Calibration" : activeStage.tab === "synthesis" ? "Build Runtime Model" : activeStage.tab === "runtime" ? "Runtime Model" : "Reports"}
                </button>
              </div>
            </div>
          )}
          {nextStepGuide && (
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 space-y-2 text-[11px]">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-muted-foreground uppercase tracking-wide">How to do the next task</p>
                  <p className="mt-1 text-foreground font-medium">{nextStepGuide.action}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onJumpToTab(nextStepGuide.tab)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/10 text-xs text-primary hover:bg-primary/15"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                  Go to {nextStepGuide.tab === "data" ? "Data & Coverage" : nextStepGuide.tab === "calibration" ? "Calibration" : nextStepGuide.tab === "synthesis" ? "Build Runtime Model" : nextStepGuide.tab === "runtime" ? "Runtime Model" : "Reports"}
                </button>
              </div>
              <p className="text-muted-foreground">{nextStepGuide.detail}</p>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Loading service pipeline status…</p>
      )}
    </div>
  );
}

function ServiceStatusSummary({ service, windowDays }: { service: string; windowDays: number }) {
  const [runtime, setRuntime] = useState<RuntimeModelStateUi | null>(null);
  const [runs, setRuns] = useState<PassRun[]>([]);
  const [backtests, setBacktests] = useState<PersistedV3BacktestHistoryRun[]>([]);
  const [synthesisJobs, setSynthesisJobs] = useState<EliteSynthesisJobStatusUi[]>([]);
  const [lifecycle, setLifecycle] = useState<ServiceLifecycleStatusUi | null>(null);
  const [promotedRuntime, setPromotedRuntime] = useState<ServicePromotedRuntimeUi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<ServiceStatusDisclosureKey, boolean>>({
    runtime: false,
    blockers: false,
    warnings: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      try {
        const [runtimeResp, runResp, backtestResp, synthesisResp, lifecycleResp, promotedResp] = await Promise.all([
          apiFetch(`calibration/runtime-model/${service}`).catch(() => null),
          apiFetch(`calibration/runs/${service}`).catch(() => ({ runs: [] })),
          apiFetch(`backtest/v3/history?symbol=${encodeURIComponent(service)}&limit=5`).catch(() => ({ runs: [] })),
          apiFetch(`research/${service}/elite-synthesis/jobs?limit=10`).catch(() => ({ jobs: [] })),
          apiFetch(`research/${service}/service-lifecycle`).catch(() => ({ serviceLifecycleStatus: null })),
          apiFetch(`research/${service}/promoted-runtime`).catch(() => ({ promotedRuntime: null })),
        ]);
        if (cancelled) return;
        setRuntime(runtimeResp as RuntimeModelStateUi | null);
        setRuns(Array.isArray((runResp as { runs?: PassRun[] } | null)?.runs) ? (runResp as { runs?: PassRun[] }).runs ?? [] : []);
        setBacktests(Array.isArray((backtestResp as { runs?: PersistedV3BacktestHistoryRun[] } | null)?.runs) ? (backtestResp as { runs?: PersistedV3BacktestHistoryRun[] }).runs ?? [] : []);
        setSynthesisJobs(Array.isArray((synthesisResp as { jobs?: EliteSynthesisJobStatusUi[] } | null)?.jobs) ? (synthesisResp as { jobs?: EliteSynthesisJobStatusUi[] }).jobs ?? [] : []);
        setLifecycle(((lifecycleResp as { serviceLifecycleStatus?: ServiceLifecycleStatusUi | null }).serviceLifecycleStatus) ?? null);
        setPromotedRuntime(((promotedResp as { promotedRuntime?: ServicePromotedRuntimeUi | null }).promotedRuntime) ?? null);
      } catch (e: unknown) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Failed to load service status");
      }
    })();
    return () => { cancelled = true; };
  }, [service, windowDays]);

  const latestRun = runs[0] ?? null;
  const latestBacktest = backtests[0] ?? null;
  const latestRuntimeBuildJob = synthesisJobs.find((job) => job.status === "completed") ?? synthesisJobs[0] ?? null;
  const activeCandidateRunId = lifecycle?.stagedCandidateSourceRunId ?? promotedRuntime?.sourceSynthesisJobId ?? latestRuntimeBuildJob?.id ?? null;
  const latestReportsLabel = service === "CRASH300"
    ? "runtime build exports available"
    : service === "R_75"
      ? "volatility-series prep, runtime, reports"
      : "service reports";
  const toggleSection = (section: ServiceStatusDisclosureKey) => {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  };

  return (
    <div className="rounded-xl border border-border/50 bg-card p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold">{getSymbolLabel(service)} Service Status</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Symbol-service research, runtime promotion, backtests, and reports for the selected service.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className={cn("px-2 py-0.5 rounded border", isEnabledService(service)
            ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
            : isScaffoldedService(service)
              ? "text-amber-300 border-amber-500/30 bg-amber-500/10"
              : "text-slate-300 border-border/40 bg-muted/20")}>
            {isEnabledService(service) ? "Enabled service" : isScaffoldedService(service) ? "Scaffolded service" : "Unavailable"}
          </span>
          <span className="px-2 py-0.5 rounded border border-border/40 bg-muted/20 text-muted-foreground">
            Window {windowLabel(windowDays)}
          </span>
        </div>
      </div>
      {err && <ErrorBox msg={err} />}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 text-[11px]">
        <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">Calibration status</p>
          <p className="font-mono text-foreground">{latestRun?.status ?? "not run"}</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">Latest research run</p>
          <p className="font-mono text-foreground">{lifecycle?.latestSynthesisJobId ?? latestRuntimeBuildJob?.id ?? latestRun?.id ?? "none"}</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">Runtime candidate</p>
          <p className="font-mono text-foreground">{activeCandidateRunId ?? "none"}</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">Promoted runtime</p>
          <p className="font-mono text-foreground">{lifecycle?.promotedRuntimeArtifactId ?? runtime?.lifecycle?.promotedRunId ?? "none"}</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">Latest backtest</p>
          <p className="font-mono text-foreground">{latestBacktest?.id ? `#${latestBacktest.id}` : "none"}</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">Latest reports</p>
          <p className="font-mono text-foreground">{latestReportsLabel}</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">V3.1 baseline</p>
          <p className="font-mono text-foreground">
            {service === "CRASH300"
              ? promotedRuntime
                ? "service runtime promoted"
                : activeCandidateRunId
                  ? "runtime candidate ready"
                  : "ready to build"
              : service === "R_75"
                ? "next optimisation target"
              : "not staged"}
          </p>
        </div>
      </div>
      {lifecycle ? (
        <div className="space-y-3 text-[11px]">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="rounded-lg border border-border/30 bg-background/40 p-2.5 space-y-1">
              <p className="text-muted-foreground uppercase tracking-wide">Active mode</p>
              <p className="font-mono text-foreground">{lifecycle.activeMode}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-background/40 p-2.5 space-y-1">
              <p className="text-muted-foreground uppercase tracking-wide">Stream</p>
              <p className="font-mono text-foreground">{lifecycle.streamState}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-background/40 p-2.5 space-y-1">
              <p className="text-muted-foreground uppercase tracking-wide">Allocator</p>
              <p className="font-mono text-foreground">{lifecycle.allocatorConnected ? "connected" : "disconnected"}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-background/40 p-2.5 space-y-1">
              <p className="text-muted-foreground uppercase tracking-wide">Next action</p>
              <p className="font-mono text-foreground">{lifecycle.nextRequiredAction}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-2.5">
            <CompactDisclosure
              title="Current Promoted Runtime"
              open={openSections.runtime}
              onToggle={() => toggleSection("runtime")}
            >
              <StatRow label="Policy" value={promotedRuntime?.sourcePolicyId ?? lifecycle.promotedRuntimeSourcePolicyId ?? "n/a"} />
              <StatRow label="Family" value={promotedRuntime?.runtimeFamily ?? "n/a"} />
              <StatRow label="Direction" value={promotedRuntime?.direction ?? "n/a"} />
              <StatRow label="Allowed modes" value={[
                promotedRuntime?.allowedModes?.paper ? "paper" : null,
                promotedRuntime?.allowedModes?.demo ? "demo" : null,
                promotedRuntime?.allowedModes?.real ? "real" : null,
              ].filter(Boolean).join(", ") || "none"} />
            </CompactDisclosure>
            <CompactDisclosure
              title={`Blockers${lifecycle.blockers.length > 0 ? ` (${lifecycle.blockers.length})` : ""}`}
              open={openSections.blockers}
              onToggle={() => toggleSection("blockers")}
            >
              <div className="space-y-1 text-[11px]">
                {lifecycle.blockers.length > 0 ? lifecycle.blockers.map((blocker) => (
                  <p key={blocker} className="text-red-300">{blocker}</p>
                )) : <p className="text-emerald-300">No active blockers</p>}
              </div>
            </CompactDisclosure>
            <CompactDisclosure
              title={`Warnings${lifecycle.warnings.length > 0 ? ` (${lifecycle.warnings.length})` : ""}`}
              open={openSections.warnings}
              onToggle={() => toggleSection("warnings")}
            >
              <div className="space-y-1 text-[11px]">
                {lifecycle.warnings.length > 0 ? lifecycle.warnings.map((warning) => (
                  <p key={warning} className="text-amber-200">{warning}</p>
                )) : <p className="text-muted-foreground">No current warnings</p>}
              </div>
            </CompactDisclosure>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RuntimeModelTab({ service }: { service: string }) {
  const [runtime, setRuntime] = useState<RuntimeModelStateUi | null>(null);
  const [lifecycle, setLifecycle] = useState<ServiceLifecycleStatusUi | null>(null);
  const [promotedRuntime, setPromotedRuntime] = useState<ServicePromotedRuntimeUi | null>(null);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [validateBusy, setValidateBusy] = useState(false);
  const [promoteNotice, setPromoteNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      try {
        const [runtimeResp, lifecycleResp, promotedResp] = await Promise.all([
          apiFetch(`calibration/runtime-model/${service}`),
          apiFetch(`research/${service}/service-lifecycle`).catch(() => ({ serviceLifecycleStatus: null })),
          apiFetch(`research/${service}/promoted-runtime`).catch(() => ({ promotedRuntime: null })),
        ]);
        if (!cancelled) {
          setRuntime(runtimeResp as RuntimeModelStateUi);
          setLifecycle(((lifecycleResp as { serviceLifecycleStatus?: ServiceLifecycleStatusUi }).serviceLifecycleStatus) ?? null);
          setPromotedRuntime(((promotedResp as { promotedRuntime?: ServicePromotedRuntimeUi | null }).promotedRuntime) ?? null);
        }
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load runtime model");
      }
    })();
    return () => { cancelled = true; };
  }, [service]);

  const baseFamily = service === "CRASH300"
    ? "crash_family"
    : service === "R_75" || service === "R_100"
      ? "volatility_series"
      : service === "BOOM300"
        ? "boom_family"
        : "service-specific";
  const promotedBuckets = extractCalibratedBucketEntries(runtime?.promotedModel ?? null);
  const stagedBuckets = extractCalibratedBucketEntries(runtime?.stagedModel ?? null);
  const promotedRuntimeTpBuckets = extractRuntimeTpBucketEntries(runtime?.promotedModel ?? null);
  const stagedRuntimeTpBuckets = extractRuntimeTpBucketEntries(runtime?.stagedModel ?? null);
  const promotedTpModel = asUiRecord(runtime?.promotedModel?.tpModel);
  const stagedTpModel = asUiRecord(runtime?.stagedModel?.tpModel);
  const promotedExpectedPerformance = asUiRecord(promotedRuntime?.expectedPerformance);
  const runtimeArchetypes = Array.from(new Set([
    ...Object.keys(asUiRecord(promotedTpModel.buckets)).filter((key) => key.includes("|")).map((bucket) => bucket.split("|")[1] ?? bucket),
    ...Object.keys(asUiRecord(stagedTpModel.buckets)).filter((key) => key.includes("|")).map((bucket) => bucket.split("|")[1] ?? bucket),
  ])).filter(Boolean);
  const validationErrors: string[] = [];
  if (!promotedRuntime && !runtime?.lifecycle?.hasPromotedModel) validationErrors.push("Promoted runtime model missing.");
  if (!promotedRuntime && runtime?.lifecycle?.hasStagedModel && runtime?.lifecycle?.promotedMatchesStaged === false) validationErrors.push("Staged model is newer than promoted runtime.");
  if (!promotedRuntime && !promotedBuckets.length && !promotedRuntimeTpBuckets.length) validationErrors.push("Runtime TP bucket model unavailable.");

  const promoteCandidateToRuntime = async () => {
    if (!lifecycle?.stagedCandidateArtifactId) return;
    setPromoteBusy(true);
    setPromoteNotice(null);
    setErr(null);
    try {
      const data = await apiFetch(`research/${service}/elite-synthesis/candidate-runtime/${lifecycle.stagedCandidateArtifactId}/promote-runtime`, {
        method: "POST",
      }) as { promotedRuntime?: ServicePromotedRuntimeUi };
      setPromotedRuntime(data.promotedRuntime ?? null);
      const lifecycleResp = await apiFetch(`research/${service}/service-lifecycle`).catch(() => ({ serviceLifecycleStatus: null })) as {
        serviceLifecycleStatus?: ServiceLifecycleStatusUi | null;
      };
      setLifecycle(lifecycleResp.serviceLifecycleStatus ?? null);
      setPromoteNotice("Promoted service runtime updated. Mode gates decide where it can execute.");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to promote candidate to runtime");
    } finally {
      setPromoteBusy(false);
    }
  };

  const validateRuntime = async () => {
    setValidateBusy(true);
    setPromoteNotice(null);
    setErr(null);
    try {
      const data = await apiFetch(`research/${service}/runtime-validation/run`, { method: "POST" }) as {
        runtimeValidationResult?: { artifactName?: string; validationStatus?: string; blockers?: string[] };
      };
      const result = data.runtimeValidationResult;
      const blockerCount = Array.isArray(result?.blockers) ? result.blockers.length : 0;
      setPromoteNotice(`Validate Runtime produced ${result?.artifactName ?? "runtime_validation_result"} with status ${result?.validationStatus ?? "unknown"} and ${blockerCount} blocker(s).`);
      const lifecycleResp = await apiFetch(`research/${service}/service-lifecycle`).catch(() => ({ serviceLifecycleStatus: null })) as {
        serviceLifecycleStatus?: ServiceLifecycleStatusUi | null;
      };
      setLifecycle(lifecycleResp.serviceLifecycleStatus ?? null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to validate runtime");
    } finally {
      setValidateBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {err && <ErrorBox msg={err} />}
      {promoteNotice && <SuccessBox msg={promoteNotice} />}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold">Promoted Runtime Summary</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Promoted runtime is universal to the service. Paper, Demo, and Real use the same runtime artifact, with mode permissions controlling execution.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void validateRuntime()}
              disabled={validateBusy || !lifecycle?.stagedCandidateArtifactId}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/30 text-xs text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/15 disabled:opacity-50"
              title="Validate the staged runtime candidate through the consolidated validation contract"
            >
              {validateBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
              Validate Runtime
            </button>
            <button
              type="button"
              onClick={() => void promoteCandidateToRuntime()}
              disabled={promoteBusy || !lifecycle?.stagedCandidateArtifactId}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-xs text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/15 disabled:opacity-50"
              title="Promote the staged runtime candidate into the universal service runtime path"
            >
              {promoteBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Promote Runtime
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-[11px]">
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Promoted artifact</p>
            <p className="font-mono text-foreground">{promotedRuntime?.artifactId ?? lifecycle?.promotedRuntimeArtifactId ?? "none"}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Source policy</p>
            <p className="font-mono text-foreground">{promotedRuntime?.sourcePolicyId ?? lifecycle?.promotedRuntimeSourcePolicyId ?? "n/a"}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Mode permissions</p>
            <p className="font-mono text-foreground">
              {[
                promotedRuntime?.allowedModes?.paper ? "paper" : null,
                promotedRuntime?.allowedModes?.demo ? "demo" : null,
                promotedRuntime?.allowedModes?.real ? "real" : null,
              ].filter(Boolean).join(", ") || "none"}
            </p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Validation</p>
            <p className="font-mono text-foreground">{promotedRuntime?.validationStatus?.runtimeValidationStatus ?? lifecycle?.runtimeValidationStatus ?? "not_run"}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-[11px]">
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Strategy</p>
            <StatRow label="Family" value={promotedRuntime?.runtimeFamily ?? "n/a"} />
            <StatRow label="Transition" value={promotedRuntime?.triggerTransition ?? "n/a"} />
            <StatRow label="Direction" value={promotedRuntime?.direction ?? "n/a"} />
            <StatRow label="Predicted bucket" value={promotedRuntime?.selectedMoveSizeBucket ?? "n/a"} />
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Expected metrics</p>
            <StatRow label="Trades" value={formatOptionalDecimal(promotedExpectedPerformance.trades, 0)} />
            <StatRow label="Win rate" value={formatOptionalPct(promotedExpectedPerformance.winRate)} />
            <StatRow label="SL rate" value={formatOptionalPct(promotedExpectedPerformance.slHitRate)} />
            <StatRow label="PF" value={formatOptionalDecimal(promotedExpectedPerformance.profitFactor)} />
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Mode gates</p>
            <StatRow label="Active mode" value={lifecycle?.activeMode ?? "idle"} />
            <StatRow label="Service runtime allowed" value={promotedRuntime?.allowedModes?.paper ? "baseline mode yes" : "baseline mode no"} />
            <StatRow label="Allocator allowed" value={lifecycle?.allocatorConnected ? "connected" : "blocked"} />
            <StatRow label="Execution allowed" value={lifecycle?.executionAllowedForActiveMode ? "yes" : "no"} />
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Live feed / allocator</p>
            <StatRow label="Stream" value={lifecycle?.streamState ?? "inactive"} />
            <StatRow label="Latest candle" value={lifecycle?.latestCandleTs ? formatRuntimeDate(lifecycle.latestCandleTs) : "n/a"} />
            <StatRow label="Allocator" value={lifecycle?.allocatorConnected ? "connected" : "disconnected"} />
            <StatRow label="Last scanner status" value={lifecycle?.latestScannerStatus ?? "not observed"} />
            <StatRow label="Last scanner reason" value={lifecycle?.latestScannerReason ?? lifecycle?.nextRequiredAction ?? "n/a"} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-2">
          <h3 className="text-sm font-semibold">Runtime Model</h3>
          <StatRow label="Service" value={getSymbolLabel(service)} />
          <StatRow label="Model source" value={promotedRuntime ? "service_promoted_runtime" : runtime?.lifecycle?.runtimeSource ?? "none"} />
          <StatRow label="Runtime candidate" value={lifecycle?.stagedCandidateSourceRunId ?? runtime?.lifecycle?.stagedRunId ?? "none"} />
          <StatRow label="Promoted runtime" value={promotedRuntime?.sourceSynthesisJobId ?? runtime?.lifecycle?.promotedRunId ?? "none"} />
          <StatRow label="Service research template" value={baseFamily} />
          <StatRow label="Runtime entry archetypes" value={runtimeArchetypes.join(", ") || "n/a"} />
          <StatRow label="Promoted model source run" value={promotedRuntime?.sourceSynthesisJobId ?? runtime?.promotedModel?.sourceRunId ?? "none"} />
          {service === "CRASH300" ? (
          <StatRow label="V3.1 baseline" value="Staged runtime candidate workflow" />
          ) : null}
          {service === "R_75" ? (
            <StatRow label="Next optimisation" value="Volatility-series symbol-service workflow ready" />
          ) : null}
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-2">
          <h3 className="text-sm font-semibold">Validation</h3>
          {validationErrors.length === 0 ? (
            <StatusPill ok yes="Model validated" no="Validation failed" />
          ) : (
            <div className="space-y-2">
              {validationErrors.map((message) => <ErrorBox key={message} msg={message} />)}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Runtime Model owns staged/promoted state, mode permissions, calibrated bucket visibility, and validation status.
          </p>
          {service === "CRASH300" ? (
            <p className="text-xs text-amber-300">
              CRASH300 is validated for Paper. Demo and Real remain separate manual mode permissions.
            </p>
          ) : null}
          {service === "R_75" ? (
            <p className="text-xs text-muted-foreground">
              R_75 uses the Volatility Series template with continuation, breakout, pullback-continuation, and gated mean reversion research priorities.
            </p>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">Runtime TP Buckets</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Promoted bucket model</p>
            {promotedBuckets.length > 0 ? promotedBuckets.map(([bucket, value]) => (
              <div key={bucket} className="flex items-center justify-between gap-2 border-b border-border/20 last:border-0 py-1">
                <span className="font-mono text-foreground">{formatCalibratedBucketLabel(bucket)}</span>
                <span className="text-muted-foreground">{Number(asUiRecord(value).targetPct ?? 0).toFixed(2)}%</span>
              </div>
            )) : promotedRuntimeTpBuckets.length > 0 ? (
              <>
                <p className="text-muted-foreground">
                  The promoted runtime model is present, but it stores TP buckets as runtime keys such as direction / archetype / quality rather than standalone calibrated move-size labels.
                </p>
                {promotedRuntimeTpBuckets.map(([bucket, value]) => (
                  <div key={bucket} className="flex items-center justify-between gap-2 border-b border-border/20 last:border-0 py-1">
                    <span className="font-mono text-foreground">{formatRuntimeTpBucketLabel(bucket)}</span>
                    <span className="text-muted-foreground">{Number(asUiRecord(value).targetPct ?? 0).toFixed(2)}%</span>
                  </div>
                ))}
              </>
            ) : <ErrorBox msg="Runtime TP bucket model unavailable" />}
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Staged bucket model</p>
            {stagedBuckets.length > 0 ? stagedBuckets.map(([bucket, value]) => (
              <div key={bucket} className="flex items-center justify-between gap-2 border-b border-border/20 last:border-0 py-1">
                <span className="font-mono text-foreground">{formatCalibratedBucketLabel(bucket)}</span>
                <span className="text-muted-foreground">{Number(asUiRecord(value).targetPct ?? 0).toFixed(2)}%</span>
              </div>
            )) : stagedRuntimeTpBuckets.length > 0 ? (
              <>
                <p className="text-muted-foreground">
                  The staged runtime model uses runtime TP bucket keys rather than standalone calibrated move-size labels.
                </p>
                {stagedRuntimeTpBuckets.map(([bucket, value]) => (
                  <div key={bucket} className="flex items-center justify-between gap-2 border-b border-border/20 last:border-0 py-1">
                    <span className="font-mono text-foreground">{formatRuntimeTpBucketLabel(bucket)}</span>
                    <span className="text-muted-foreground">{Number(asUiRecord(value).targetPct ?? 0).toFixed(2)}%</span>
                  </div>
                ))}
              </>
            ) : <p className="text-muted-foreground">No staged buckets.</p>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-2 text-xs">
          <h3 className="text-sm font-semibold">Runtime Target Model</h3>
          <StatRow label="Fallback target pct" value={Number(promotedTpModel.fallbackTargetPct ?? 0).toFixed(2)} />
          <StatRow label="Bucket source" value={String(promotedTpModel.bucketSource ?? "n/a")} />
          <StatRow label="Bucket selection" value={String(promotedTpModel.bucketSelection ?? "n/a")} />
          <StatRow label="Dynamic target selection" value={String(promotedTpModel.dynamicByQualityLeadIn ?? false)} />
          <StatRow label="Rationale" value={String(promotedTpModel.rationale ?? "n/a")} />
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-2 text-xs">
          <h3 className="text-sm font-semibold">Runtime Entry Archetypes</h3>
          {runtimeArchetypes.length === 0 ? (
            <p className="text-muted-foreground">No runtime archetypes inferred from the current promoted/staged bucket models.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {runtimeArchetypes.map((archetype) => (
                <span key={archetype} className="rounded border border-border/40 bg-muted/10 px-2 py-1 font-mono text-foreground">
                  {archetype}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type ReportOption = {
  value: string;
  label: string;
  task: "calibration" | "runtime-build" | "validation" | "execution";
  runType: "none" | "backtest" | "comparison" | "synthesis";
};

type ReportTaskOption = {
  value: ReportOption["task"];
  label: string;
};

const ELITE_SYNTHESIS_PROFILE_DESCRIPTIONS: Record<EliteSynthesisSearchProfileUi, string> = {
  fast: "Fast smoke profile: quickest sanity run. Uses 6 passes with 2 patience passes to confirm the dataset, job flow, and first candidate search.",
  balanced: "Balanced profile: default wider search. Uses 12 passes with 4 patience passes for a stronger candidate policy review without the longest runtime.",
  deep: "Deep profile: broadest search. Uses 24 passes with 6 patience passes for the heaviest refinement and bottleneck discovery.",
};

const REPORT_TASK_OPTIONS: ReportTaskOption[] = [
  { value: "calibration", label: "Calibration Reports" },
  { value: "runtime-build", label: "Runtime Build Reports" },
  { value: "validation", label: "Validation Reports" },
  { value: "execution", label: "Execution Reports" },
];

const REPORT_OPTIONS: ReportOption[] = [
  { value: "detected-moves", label: "Detected Moves", task: "calibration", runType: "none" },
  { value: "calibration-profile", label: "Calibration Profile", task: "calibration", runType: "none" },
  { value: "pass-results", label: "Pass Results", task: "calibration", runType: "none" },
  { value: "comparison-summary", label: "Comparison Summary", task: "calibration", runType: "none" },
  { value: "runtime-build-result", label: "Runtime Build Summary", task: "runtime-build", runType: "synthesis" },
  { value: "elite-synthesis-result", label: "Selected Candidate", task: "runtime-build", runType: "synthesis" },
  { value: "elite-return-amplification", label: "Return / Profit Analysis", task: "runtime-build", runType: "synthesis" },
  { value: "trade-lifecycle-replay", label: "Lifecycle Replay", task: "runtime-build", runType: "synthesis" },
  { value: "calibration-reconciliation", label: "Missed Move / Coverage Analysis", task: "runtime-build", runType: "backtest" },
  { value: "elite-policy-comparison", label: "Policy Comparison / Candidate Leaderboard", task: "runtime-build", runType: "synthesis" },
  { value: "backtest-summary", label: "Backtest Result", task: "validation", runType: "backtest" },
  { value: "parity-report", label: "Parity Result", task: "validation", runType: "none" },
  { value: "runtime-trigger-validation", label: "Trigger Validation", task: "validation", runType: "none" },
  { value: "backtest-attribution", label: "Phantom / Noise Analysis", task: "validation", runType: "backtest" },
  { value: "phase-summary", label: "Runtime Mimic Validation Summary", task: "validation", runType: "none" },
  { value: "phase-sample", label: "Runtime Mimic Validation Sample", task: "validation", runType: "none" },
  { value: "backtest-signals", label: "Service Candidates", task: "execution", runType: "none" },
  { value: "policy-comparison", label: "Allocator Decisions", task: "execution", runType: "comparison" },
  { value: "backtest-trades", label: "Trades", task: "execution", runType: "backtest" },
  { value: "phase-full", label: "Lifecycle Monitor Logs", task: "execution", runType: "none" },
];

function AddServiceModal({
  selectedService,
  onClose,
  onCreateService,
}: {
  selectedService: string;
  onClose: () => void;
  onCreateService: (service: string) => void;
}) {
  const [selectedSymbol, setSelectedSymbol] = useState<string>(selectedService);
  const groupedSymbols = useMemo(() => getGroupedSymbols(SYMBOL_CATALOG.map((entry) => entry.symbol)), []);
  const selectedEntry = SYMBOL_CATALOG.find((entry) => entry.symbol === selectedSymbol) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-2xl rounded-2xl border border-border/60 bg-card p-5 space-y-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Add New Service</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Choose a symbol from the full system list. Once created, Research will open that symbol as its own service workflow so data download, calibration, synthesis, runtime, backtests, and reports all start blank from that service.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-lg border border-border/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_240px] gap-4">
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wide">Symbol</label>
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              className="w-full text-xs bg-background border border-border/50 rounded px-3 py-2 text-foreground focus:outline-none focus:border-primary/50"
            >
              {groupedSymbols.map((section) => (
                <optgroup key={section.group} label={section.group}>
                  {section.entries.map((entry) => (
                    <option key={entry.symbol} value={entry.symbol}>
                      {entry.symbol} — {entry.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 text-[11px] space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Selected service</p>
            <p className="font-mono text-foreground">{selectedSymbol}</p>
            <p className="text-muted-foreground">{selectedEntry?.label ?? selectedSymbol}</p>
            <p className="text-muted-foreground">{selectedEntry?.group ?? "Unclassified"}</p>
            <p className="text-amber-200 pt-2">
              New services open blank. Unsupported templates still fail loudly until their backend workflow exists.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-[11px] text-muted-foreground">
            After creation, the service selector will switch to this symbol and default to Data & Coverage.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border/40 text-xs text-muted-foreground hover:text-foreground hover:border-border"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onCreateService(selectedSymbol)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-primary/40 bg-primary/10 text-xs text-primary hover:bg-primary/15"
            >
              <Plus className="w-3.5 h-3.5" />
              Create Service
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DataCoverageTab({ service }: { service: string }) {
  const { data: dataStatus, isLoading: dataLoading } = useResearchDataStatus();
  const [lifecycle, setLifecycle] = useState<ServiceLifecycleStatusUi | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lifecycleResp = await apiFetch(`research/${service}/service-lifecycle`);
        if (cancelled) return;
        setLifecycle(((lifecycleResp as { serviceLifecycleStatus?: ServiceLifecycleStatusUi }).serviceLifecycleStatus) ?? null);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load data coverage");
      }
    })();
    return () => { cancelled = true; };
  }, [service]);

  const serviceRow = dataStatus?.symbols.find((row) => row.symbol === service) ?? null;
  const staleLabel = useMemo(() => {
    if (!serviceRow?.newestDate) return "n/a";
    const ageMs = Date.now() - new Date(serviceRow.newestDate).getTime();
    const hours = Math.max(0, Math.floor(ageMs / 3_600_000));
    return hours < 24 ? `${hours}h old` : `${Math.floor(hours / 24)}d old`;
  }, [serviceRow?.newestDate]);

  return (
    <div className="space-y-4">
      {err && <ErrorBox msg={err} />}
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold">Data &amp; Coverage</h3>
            <p className="text-xs text-muted-foreground mt-1">
              See what candles exist, what enriched candles exist, and run the symbol data operations from inside Research. Use the Data page only for stream start/stop and live feed visibility.
            </p>
          </div>
          <span className="px-2 py-0.5 rounded border border-primary/30 bg-primary/10 text-[11px] text-primary">
            {getSymbolLabel(service)}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-[11px]">
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Coverage status</p>
            <p className="font-mono text-foreground">{lifecycle?.dataCoverageStatus ?? serviceRow?.status ?? (dataLoading ? "loading" : "unknown")}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Latest candle</p>
            <p className="font-mono text-foreground">{lifecycle?.latestCandleTs ? formatRuntimeDate(lifecycle.latestCandleTs) : "n/a"}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">1m candles</p>
            <p className="font-mono text-foreground">{serviceRow?.count1m?.toLocaleString() ?? "0"}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">5m candles</p>
            <p className="font-mono text-foreground">{serviceRow?.count5m?.toLocaleString() ?? "0"}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Freshness</p>
            <p className="font-mono text-foreground">{staleLabel}</p>
          </div>
        </div>
        <div className="rounded-lg border border-border/30 bg-muted/10 p-3 text-[11px] text-muted-foreground">
          Next required action from this stage: <span className="text-foreground font-medium">{lifecycle?.nextRequiredAction ?? "Review service lifecycle"}</span>
        </div>
      </div>

      <HistoricalDownloadCard statusData={dataStatus} lockedSymbol={service} />
      <CleanCanonicalTab lockedSymbol={service} showCoverageInline />
    </div>
  );
}

function ReportsTab({
  service,
  windowDays,
  forcedTask,
  title = "Reports",
  description = "Consolidated read-only exports for the selected symbol service. Backtest-heavy artifacts stay here instead of being scattered through calibration and runtime cards.",
}: {
  service: string;
  windowDays: number;
  forcedTask?: ReportOption["task"];
  title?: string;
  description?: string;
}) {
  const [reportTask, setReportTask] = useState<ReportOption["task"]>(forcedTask ?? "calibration");
  const [reportType, setReportType] = useState<string>("detected-moves");
  const [calibrationRuns, setCalibrationRuns] = useState<PassRun[]>([]);
  const [backtestRuns, setBacktestRuns] = useState<PersistedV3BacktestHistoryRun[]>([]);
  const [synthesisJobs, setSynthesisJobs] = useState<EliteSynthesisJobStatusUi[]>([]);
  const [selectedSynthesisJobId, setSelectedSynthesisJobId] = useState<number | null>(null);
  const [selectedBacktestRunId, setSelectedBacktestRunId] = useState<number | null>(null);
  const [baselineRunId, setBaselineRunId] = useState<number | null>(null);
  const [policyRunId, setPolicyRunId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [synthesisReportResult, setSynthesisReportResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (forcedTask) {
      setReportTask(forcedTask);
    }
  }, [forcedTask]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [runsResp, backtestsResp, synthesisResp] = await Promise.all([
          apiFetch(`calibration/runs/${service}`).catch(() => ({ runs: [] })),
          apiFetch(`backtest/v3/history?symbol=${encodeURIComponent(service)}&limit=30`).catch(() => ({ runs: [] })),
          apiFetch(`research/${service}/elite-synthesis/jobs?limit=20`).catch((e: unknown) => ({
            jobs: [],
            error: e instanceof Error ? e.message : "Failed to load elite synthesis jobs",
          })),
        ]);
        if (cancelled) return;
        const synthesisLoadError = (synthesisResp as { error?: string }).error;
        if (synthesisLoadError) {
          setErr(`Build Runtime Model history failed to load: ${synthesisLoadError}`);
        } else {
          setErr(null);
        }
        const nextCalibrationRuns = Array.isArray((runsResp as { runs?: PassRun[] }).runs) ? (runsResp as { runs?: PassRun[] }).runs ?? [] : [];
        const nextBacktestRuns = Array.isArray((backtestsResp as { runs?: PersistedV3BacktestHistoryRun[] }).runs) ? (backtestsResp as { runs?: PersistedV3BacktestHistoryRun[] }).runs ?? [] : [];
        const nextSynthesisJobs = Array.isArray((synthesisResp as { jobs?: EliteSynthesisJobStatusUi[] }).jobs)
          ? (synthesisResp as { jobs?: EliteSynthesisJobStatusUi[] }).jobs ?? []
          : [];
        setCalibrationRuns(nextCalibrationRuns);
        setBacktestRuns(nextBacktestRuns);
        setSynthesisJobs(nextSynthesisJobs);
        setSelectedBacktestRunId((prev) => prev ?? nextBacktestRuns[0]?.id ?? null);
        setBaselineRunId((prev) => prev ?? nextBacktestRuns[1]?.id ?? nextBacktestRuns[0]?.id ?? null);
        setPolicyRunId((prev) => prev ?? nextBacktestRuns[0]?.id ?? null);
        setSelectedSynthesisJobId((prev) => prev ?? nextSynthesisJobs[0]?.id ?? null);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load report history");
      }
    })();
    return () => { cancelled = true; };
  }, [service]);

  const filteredReportOptions = REPORT_OPTIONS.filter((option) => option.task === reportTask);
  const selectedOption = filteredReportOptions.find((option) => option.value === reportType) ?? filteredReportOptions[0] ?? REPORT_OPTIONS[0];

  useEffect(() => {
    if (!filteredReportOptions.some((option) => option.value === reportType)) {
      setReportType(filteredReportOptions[0]?.value ?? REPORT_OPTIONS[0].value);
    }
  }, [filteredReportOptions, reportType]);

  useEffect(() => {
    let cancelled = false;
    if (selectedOption.runType !== "synthesis" || !selectedSynthesisJobId) {
      setSynthesisReportResult(null);
      return;
    }
    (async () => {
      try {
        if (selectedOption.value === "runtime-build-result") {
          const data = await apiFetch(`research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/export/runtime-build-result`) as Record<string, unknown>;
          if (!cancelled) setSynthesisReportResult(data);
          return;
        }
        const data = await apiFetch(`research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/result`) as {
          result?: Record<string, unknown> | null;
        };
        if (!cancelled) setSynthesisReportResult(data.result ?? null);
      } catch {
        if (!cancelled) setSynthesisReportResult(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedOption.runType, selectedOption.value, selectedSynthesisJobId, service]);

  const exportReport = async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let endpoint = "";
      let filename = `${service}-${reportType}-${stamp}.json`;
      switch (reportType) {
        case "detected-moves":
          endpoint = `calibration/export/${service}?type=moves`;
          break;
        case "calibration-profile":
          endpoint = `calibration/export/${service}?type=profile`;
          break;
        case "pass-results":
          endpoint = `calibration/export/${service}?type=passes`;
          break;
        case "comparison-summary":
          endpoint = `calibration/export/${service}?type=comparison`;
          break;
        case "parity-report":
          endpoint = `calibration/runtime-model/${service}/parity-report?windowDays=${windowDays}`;
          break;
        case "runtime-trigger-validation":
          endpoint = `calibration/runtime-model/${service}/runtime-trigger-validation?windowDays=${windowDays}`;
          break;
        case "phase-summary":
          endpoint = `calibration/runtime-model/${service}/phase-identifiers/summary?windowDays=${windowDays}`;
          break;
        case "phase-sample":
          endpoint = `calibration/runtime-model/${service}/phase-identifiers?windowDays=${windowDays}&limit=5`;
          break;
        case "phase-full":
          endpoint = `calibration/runtime-model/${service}/phase-identifiers?windowDays=${windowDays}`;
          break;
        case "backtest-summary": {
          if (!selectedBacktestRunId) throw new Error("Select a backtest run first.");
          const d = await apiFetch(`backtest/v3/history/${selectedBacktestRunId}`) as { run?: PersistedV3BacktestHistoryRun & { result?: V3Result } };
          downloadJsonFile(d.run?.result?.summary ?? d.run ?? d, filename);
          return;
        }
        case "backtest-trades": {
          if (!selectedBacktestRunId) throw new Error("Select a backtest run first.");
          const d = await apiFetch(`backtest/v3/history/${selectedBacktestRunId}`) as { run?: PersistedV3BacktestHistoryRun & { result?: V3Result } };
          downloadJsonFile(d.run?.result?.trades ?? d.run ?? d, filename);
          return;
        }
        case "backtest-attribution":
          if (!selectedBacktestRunId) throw new Error("Select a backtest run first.");
          endpoint = `backtest/v3/history/${selectedBacktestRunId}/attribution`;
          break;
        case "calibration-reconciliation":
          if (!selectedBacktestRunId) throw new Error("Select a backtest run first.");
          endpoint = `backtest/v3/history/${selectedBacktestRunId}/calibration-reconciliation`;
          break;
        case "backtest-signals": {
          const { startTs, endTs } = getWindowRange(windowDays);
          const params = new URLSearchParams({ startTs: String(startTs), endTs: String(endTs) });
          if (service && service !== "all") params.set("symbol", service);
          endpoint = `signals/export?${params.toString()}`;
          break;
        }
        case "policy-comparison":
          if (!baselineRunId || !policyRunId) throw new Error("Select both baseline and policy runs.");
          endpoint = `backtest/v3/history/compare?baselineRunId=${baselineRunId}&policyRunId=${policyRunId}`;
          break;
        case "elite-synthesis-result":
          if (!selectedSynthesisJobId) throw new Error("Select an elite synthesis job first.");
          endpoint = `research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/export/full`;
          break;
        case "runtime-build-result":
          if (!selectedSynthesisJobId) throw new Error("Select a Build Runtime Model job first.");
          endpoint = `research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/export/runtime-build-result`;
          filename = `runtime_build_result_${service}_${selectedSynthesisJobId}_${stamp}.json`;
          break;
        case "elite-synthesis-selected-trades":
          if (!selectedSynthesisJobId) throw new Error("Select an elite synthesis job first.");
          endpoint = `research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/export/selected-trades`;
          break;
        case "elite-return-amplification":
          if (!selectedSynthesisJobId) throw new Error("Select an elite synthesis job first.");
          endpoint = `research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/export/return-amplification`;
          break;
        case "elite-policy-comparison":
          if (!selectedSynthesisJobId) throw new Error("Select an elite synthesis job first.");
          endpoint = `research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/export/policy-comparison`;
          break;
        case "trade-lifecycle-replay":
          if (!selectedSynthesisJobId) throw new Error("Select an elite synthesis job first.");
          endpoint = `research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/export/trade-lifecycle-replay`;
          break;
      }
      const d = await apiFetch(endpoint);
      downloadJsonFile(d, filename);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Report export failed");
    } finally {
      setBusy(false);
    }
  };

  const stageBestSynthesisCandidate = async () => {
    if (!selectedSynthesisJobId) return;
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const data = await apiFetch(`research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/stage-candidate-runtime`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manualStageApproved: service === "CRASH300",
          manualStageReason: "Portfolio baseline handover; CRASH300 candidate is high-quality but not final/live-approved.",
        }),
      }) as { artifact?: { artifactId?: string } };
      setNotice(`Runtime candidate staged${data.artifact?.artifactId ? ` (${data.artifact.artifactId})` : ""}.`);
      const refreshed = await apiFetch(`research/${service}/elite-synthesis/jobs/${selectedSynthesisJobId}/result`) as {
        result?: Record<string, unknown> | null;
      };
      setSynthesisReportResult(refreshed.result ?? null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to stage best synthesis candidate");
    } finally {
      setBusy(false);
    }
  };

  const validateCandidateRuntime = async (artifactId: string) => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const data = await apiFetch(`research/${service}/elite-synthesis/candidate-runtime/${artifactId}/validate-backtest`, {
        method: "POST",
      }) as { candidateRuntimeValidation?: { blockers?: string[] } };
      const blockers = Array.isArray(data.candidateRuntimeValidation?.blockers)
        ? data.candidateRuntimeValidation?.blockers.join(", ")
        : "validation submitted";
      setNotice(`Candidate runtime validation response: ${blockers}`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to validate candidate runtime");
    } finally {
      setBusy(false);
    }
  };

  const selectedSynthesisJobMeta = (synthesisReportResult?.selectedJob as Record<string, unknown> | undefined) ?? null;
  const artifactStatusMeta = (synthesisReportResult?.artifactStatus as Record<string, unknown> | undefined) ?? null;
  const artifactDiagnostics = Array.isArray(synthesisReportResult?.artifactDiagnostics)
    ? synthesisReportResult?.artifactDiagnostics.map((value) => String(value))
    : [];
  const currentStagedCandidate = (synthesisReportResult?.currentStagedCandidate as Record<string, unknown> | undefined) ?? null;
  const runtimeBuildProfile = asUiRecord(synthesisReportResult?.buildProfile);
  const runtimeBuildCandidate = asUiRecord(synthesisReportResult?.recommendedCandidate ?? synthesisReportResult?.bestCapitalExtractionCandidate);
  const runtimeBuildCoverage = asUiRecord(synthesisReportResult?.largeMoveCoverage ?? synthesisReportResult?.targetMoveCoverage);
  const runtimeBuildUniverse = asUiRecord(synthesisReportResult?.targetMoveUniverse);
  const bestPolicySummary = (synthesisReportResult?.bestPolicySummary as Record<string, unknown> | undefined)
    ?? (Object.keys(runtimeBuildCandidate).length > 0 ? runtimeBuildCandidate : null);
  const bestPolicyReadiness = (synthesisReportResult?.policyArtifactReadiness as Record<string, unknown> | undefined) ?? {};
  const returnAmplificationAnalysis = (synthesisReportResult?.returnAmplificationAnalysis as Record<string, unknown> | undefined) ?? {};
  const returnSummary = (returnAmplificationAnalysis.summary as Record<string, unknown> | undefined) ?? {};
  const recommendedScenario = (returnAmplificationAnalysis.recommendedCandidateConfiguration as Record<string, unknown> | undefined)
    ?? (Object.keys(runtimeBuildCandidate).length > 0 ? runtimeBuildCandidate : null);
  const safestHighWinPolicy = (returnAmplificationAnalysis.safestHighWinPolicy as Record<string, unknown> | undefined) ?? null;
  const bestReturnFirstPolicy = (returnAmplificationAnalysis.bestReturnFirstPolicy as Record<string, unknown> | undefined) ?? null;
  const bestRejectedProfitPolicy = (returnAmplificationAnalysis.bestRejectedProfitPolicy as Record<string, unknown> | undefined) ?? null;
  const recommendedPolicyMeta = (returnAmplificationAnalysis.recommendedPolicy as Record<string, unknown> | undefined) ?? null;
  const primaryDeepFamilyAnalysis = (returnAmplificationAnalysis.primaryDeepFamilyAnalysis as Record<string, unknown> | undefined) ?? null;
  const runtimeArtifactEligibility = (returnAmplificationAnalysis.runtimeArtifactEligibility as Record<string, unknown> | undefined)
    ?? (synthesisReportResult?.runtimeArtifactEligibility as Record<string, unknown> | undefined)
    ?? null;
  const aiStrategyReview = (returnAmplificationAnalysis.aiStrategyReview as Record<string, unknown> | undefined)
    ?? (synthesisReportResult?.aiStrategyReview as Record<string, unknown> | undefined)
    ?? null;
  const preLimitFamilyStats = (returnAmplificationAnalysis.preLimitFamilyStats as Record<string, unknown> | undefined) ?? null;
  const postDailyLimitFamilyStats = (returnAmplificationAnalysis.postDailyLimitFamilyStats as Record<string, unknown> | undefined) ?? null;
  const bestLifecycleReturnPct = Number(recommendedScenario?.totalAccountReturnPct ?? recommendedScenario?.accountReturnPct ?? 0);
  const bestLifecycleMonthlyPct = Number(recommendedScenario?.averageMonthlyAccountReturnPct ?? 0);
  const stageButtonAllowed = service === "CRASH300"
    ? Boolean(bestPolicyReadiness.reportConsistencyPassed) && Boolean(bestPolicyReadiness.selectedTradesExportPassed)
    : Boolean(bestPolicyReadiness.canStageForPaper);

  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
        {forcedTask === "runtime-build" ? (
          <p className="text-xs text-amber-200 mt-2">
            Deep 12-month run may take long. It runs on worker and will not block the UI.
          </p>
        ) : null}
      </div>
      {notice && <SuccessBox msg={notice} />}
      {err && <ErrorBox msg={err} />}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {!forcedTask ? (
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Function</label>
            <select value={reportTask} onChange={(e) => setReportTask(e.target.value as ReportOption["task"])} className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground">
              {REPORT_TASK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        ) : (
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Function</label>
            <div className="w-full text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">
              {REPORT_TASK_OPTIONS.find((option) => option.value === forcedTask)?.label ?? forcedTask}
            </div>
          </div>
        )}
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Report</label>
          <select value={selectedOption?.value ?? reportType} onChange={(e) => setReportType(e.target.value)} className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground">
            {filteredReportOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        {selectedOption.runType === "backtest" && (
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Backtest run</label>
            <select value={selectedBacktestRunId ? String(selectedBacktestRunId) : ""} onChange={(e) => setSelectedBacktestRunId(Number(e.target.value) || null)} className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground">
              <option value="">Select a backtest run</option>
              {backtestRuns.map((run) => <option key={run.id} value={String(run.id)}>#{run.id}  {new Date(run.createdAt).toLocaleString()}</option>)}
            </select>
          </div>
        )}
        {selectedOption.runType === "comparison" && (
          <>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Baseline run</label>
              <select value={baselineRunId ? String(baselineRunId) : ""} onChange={(e) => setBaselineRunId(Number(e.target.value) || null)} className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground">
                <option value="">Select baseline run</option>
                {backtestRuns.map((run) => <option key={run.id} value={String(run.id)}>#{run.id}  {new Date(run.createdAt).toLocaleString()}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Policy run</label>
              <select value={policyRunId ? String(policyRunId) : ""} onChange={(e) => setPolicyRunId(Number(e.target.value) || null)} className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground">
                <option value="">Select policy run</option>
                {backtestRuns.map((run) => <option key={run.id} value={String(run.id)}>#{run.id}  {new Date(run.createdAt).toLocaleString()}</option>)}
              </select>
            </div>
          </>
        )}
        {selectedOption.runType === "synthesis" && (
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Runtime build job</label>
            <select value={selectedSynthesisJobId ? String(selectedSynthesisJobId) : ""} onChange={(e) => setSelectedSynthesisJobId(Number(e.target.value) || null)} className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground">
              <option value="">Select a runtime build job</option>
              {synthesisJobs.map((job) => (
                <option key={job.id} value={String(job.id)}>
                  #{job.id}  {searchProfileLabel(job.searchProfile)}  {targetProfileLabel(job.targetProfile)}  {synthesisResultStateLabel(job)}
                </option>
              ))}
            </select>
          </div>
        )}
        {selectedOption.runType === "none" && (
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Calibration runs</label>
            <div className="w-full text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground">
              {calibrationRuns.length ? `${calibrationRuns.length} stored run(s)` : "No stored run history required"}
            </div>
          </div>
        )}
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Window</label>
          <div className="w-full text-xs bg-background border border-primary/30 rounded px-2 py-1.5 text-primary">{windowLabel(windowDays)} (shared)</div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void exportReport()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        Export / Download JSON
      </button>
    </div>
  );
}

function RuntimeBuildRunDetails({ result }: { result: Record<string, unknown> }) {
  const profile = asUiRecord(result.buildProfile);
  const universe = asUiRecord(result.targetMoveUniverse);
  const coverage = asUiRecord(result.largeMoveCoverage ?? result.targetMoveCoverage);
  const candidate = asUiRecord(result.bestCapitalExtractionCandidate ?? result.recommendedCandidate);
  const eligibility = asUiRecord(result.runtimeArtifactEligibility);
  const lifecycle = asUiRecord(result.lifecycleHoldAndExhaustionAnalysis);
  const exitTiming = asUiRecord(lifecycle.selectedCandidateExitTiming ?? candidate.lifecycleExitTiming);
  const dynamicPlan = asUiRecord(candidate.dynamicExitPlanSummary ?? result.dynamicTpProtectionSummary);
  const aiReview = asUiRecord(result.aiStrategyReview);
  const blockers = Array.isArray(eligibility.blockers) ? eligibility.blockers.map(String) : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  const trades = Number(candidate.trades ?? candidate.selectedTradeCount ?? 0);
  const wins = Number(candidate.wins ?? 0);
  const losses = Number(candidate.losses ?? 0);
  const lifecycleTotal = Number(candidate.totalAccountReturnPct ?? candidate.accountReturnPct ?? 0);
  const lifecycleMonthly = Number(candidate.averageMonthlyAccountReturnPct ?? candidate.monthlyAccountReturnPct ?? 0);
  const lifecycleMedian = Number(candidate.lifecycleMedianPnlPct ?? 0);
  const lifecycleAverage = Number(candidate.lifecycleAveragePnlPct ?? 0);

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-3 text-[11px]">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatRow label="Build run" value={`#${String(result.buildRunId ?? "n/a")}`} />
        <StatRow label="Profile / target" value={`${searchProfileLabel(String(profile.searchProfile ?? ""))} / ${targetProfileLabel(String(profile.targetProfile ?? ""))}`} />
        <StatRow label="Target universe" value={`${Number(universe.totalTargetMoves ?? 0)} ${String(universe.family ?? "target")} >= ${Number(universe.minimumMovePct ?? 0)}%`} />
        <StatRow label="Large move coverage" value={`${Number(coverage.capturedTargetMoveCount ?? 0)} / ${Number(coverage.targetUniverseCount ?? universe.totalTargetMoves ?? 0)} (${Number(coverage.coveragePct ?? 0).toFixed(2)}%)`} />
        <StatRow label="Best candidate" value={String(candidate.scenarioId ?? candidate.policyId ?? "n/a")} />
        <StatRow label="Trades / wins / losses" value={`${trades} / ${wins} / ${losses}`} />
        <StatRow label="Win / SL" value={`${(Number(candidate.winRate ?? 0) * 100).toFixed(2)}% / ${(Number(candidate.slHitRate ?? 0) * 100).toFixed(2)}%`} />
        <StatRow label="Lifecycle return" value={`${lifecycleTotal.toFixed(2)}% total / ${lifecycleMonthly.toFixed(2)}% monthly`} />
        <StatRow label="Lifecycle PnL" value={`${lifecycleMedian.toFixed(2)}% median / ${lifecycleAverage.toFixed(2)}% avg`} />
        <StatRow label="Exit timing" value={`early ${Number(exitTiming.early ?? 0)} / correct ${Number(exitTiming.correct_near_detected_exhaustion ?? exitTiming.correct ?? 0)} / late ${Number(exitTiming.late ?? 0)}`} />
        <StatRow label="TP2 / runner" value={`${Number(asUiRecord(dynamicPlan.tp2Pct).p50 ?? 0).toFixed(2)}% / ${Number(asUiRecord(dynamicPlan.runnerTargetPct).p50 ?? 0).toFixed(2)}%`} />
        <StatRow label="Protection" value={`${Number(asUiRecord(dynamicPlan.protectionActivationPct).p50 ?? 0).toFixed(2)}% activation / ${Number(asUiRecord(dynamicPlan.dynamicProtectionDistancePct).p50 ?? 0).toFixed(2)}% room`} />
        <StatRow label="Eligibility" value={String(eligibility.status ?? "not evaluated")} />
        <StatRow label="Review artifact" value={asUiRecord(result.reviewCandidateRuntimeArtifact).artifactId ? "created" : "not created"} />
        <StatRow label="AI review" value={String(aiReview.status ?? "not run")} />
        <StatRow label="Promote mode" value={Boolean(eligibility.canAutoPromote) ? "auto" : "manual only"} />
      </div>
      {blockers.length > 0 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-amber-100">
          <p className="font-medium">Blockers</p>
          <p className="mt-1 text-muted-foreground">{blockers.join(", ")}</p>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-border/30 bg-background/30 px-3 py-2 text-muted-foreground">
          {warnings.join(" ")}
        </div>
      )}
    </div>
  );
}

function IntegratedEliteSynthesisCard({ service, windowDays }: { service: string; windowDays: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState<EliteSynthesisSearchProfileUi>("fast");
  const [targetProfile, setTargetProfile] = useState<EliteSynthesisTargetProfileUi>("default");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyJobs, setHistoryJobs] = useState<EliteSynthesisJobStatusUi[]>([]);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  const [expandedJobResult, setExpandedJobResult] = useState<Record<string, unknown> | null>(null);
  const [expandedJobLoading, setExpandedJobLoading] = useState(false);
  const [expandedJobErr, setExpandedJobErr] = useState<string | null>(null);

  const loadHistory = useCallback(async (silent = false) => {
    if (!silent) setErr(null);
    if (!silent) setHistoryLoading(true);
    try {
      const data = await apiFetch(`research/${service}/elite-synthesis/jobs?limit=20`) as {
        jobs?: EliteSynthesisJobStatusUi[];
      };
      setHistoryErr(null);
      setHistoryJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to load elite synthesis run history";
      setHistoryErr(message);
      if (!silent) setErr(message);
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  }, [service]);

  useEffect(() => {
    setHistoryExpanded(false);
    setHistoryJobs([]);
    setHistoryErr(null);
    setHistoryLoading(false);
    setExpandedJobId(null);
    setExpandedJobResult(null);
    setExpandedJobErr(null);
  }, [service]);

  const toggleJobDetails = async (jobId: number) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      setExpandedJobResult(null);
      setExpandedJobErr(null);
      return;
    }
    setExpandedJobId(jobId);
    setExpandedJobResult(null);
    setExpandedJobErr(null);
    setExpandedJobLoading(true);
    try {
      const data = await apiFetch(`research/${service}/elite-synthesis/jobs/${jobId}/export/runtime-build-result`) as Record<string, unknown>;
      setExpandedJobResult(data);
    } catch (e: unknown) {
      setExpandedJobErr(e instanceof Error ? e.message : "Runtime build result failed to load");
    } finally {
      setExpandedJobLoading(false);
    }
  };

  const startJob = async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const { startTs, endTs } = getWindowRange(windowDays);
      const data = await apiFetch(`research/${service}/elite-synthesis/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowDays,
          startTs,
          endTs,
          searchProfile: profile,
          targetProfile,
        }),
      }) as { jobId?: number; symbol?: string };
      const jobId = Number(data.jobId ?? 0);
      if (!Number.isInteger(jobId) || jobId <= 0) {
        throw new Error("Build Runtime Model did not return a valid job id.");
      }
      setNotice(`Build Runtime Model started for ${getSymbolLabel(service)} (job #${jobId}).`);
      await loadHistory(true);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to start Build Runtime Model");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-cyan-100">Build Runtime Model</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Builds the best live-safe runtime model from the latest calibration data. Internally evaluates target moves, candidate entries, controls, lifecycle exits, profit ranking, AI-assisted reasoning if enabled, and runtime mimic readiness.
            No trading changes happen until you stage and promote.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value as EliteSynthesisSearchProfileUi)}
            className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground"
          >
            <option value="fast">Fast smoke profile</option>
            <option value="balanced">Balanced profile</option>
            <option value="deep">Deep profile</option>
          </select>
          <select
            value={targetProfile}
            onChange={(e) => setTargetProfile(e.target.value as EliteSynthesisTargetProfileUi)}
            className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-foreground"
          >
            <option value="default">Default target profile</option>
            <option value="return_first">Return-first / profit amplification</option>
          </select>
          <button
            type="button"
            onClick={() => void startJob()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/30 text-xs text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/15 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            Build Runtime Model
          </button>
        </div>
      </div>

      {notice && <SuccessBox msg={notice} />}
      {err && <ErrorBox msg={err} />}

      <div className="rounded-lg border border-border/30 bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
        {ELITE_SYNTHESIS_PROFILE_DESCRIPTIONS[profile]}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
        <div className="rounded-lg border border-border/30 bg-background/40 p-3">
          <p className="text-muted-foreground uppercase tracking-wide">Normal workflow role</p>
          <p className="mt-1 text-foreground">Owns the internal search over target moves, controls, candidate entries, lifecycle exits, profit ranking, and runtime rule drafts.</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-background/40 p-3">
          <p className="text-muted-foreground uppercase tracking-wide">Runtime safety</p>
          <p className="mt-1 text-foreground">Live-safe feature rules only. Oracle labels remain evaluation-only and never become final live runtime inputs.</p>
        </div>
        <div className="rounded-lg border border-border/30 bg-background/40 p-3">
          <p className="text-muted-foreground uppercase tracking-wide">Execution model</p>
          <p className="mt-1 font-mono text-foreground">
            Worker service queue
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">Run History</span>
            {historyJobs.length > 0 && (
              <span className="text-[11px] text-muted-foreground">({historyJobs.length} runs)</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              if (!historyExpanded) void loadHistory();
              setHistoryExpanded(v => !v);
            }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {historyExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {historyExpanded ? "Hide history" : "Show history"}
          </button>
        </div>

        {historyExpanded && (
          <div className="space-y-2">
            {historyLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />Loading run history
              </div>
            )}
            {!historyLoading && historyErr && (
              <p className="text-xs text-red-300">Run history failed to load: {historyErr}</p>
            )}
            {!historyLoading && !historyErr && historyJobs.length === 0 && (
              <p className="text-xs text-muted-foreground">No elite synthesis runs recorded yet for {service}.</p>
            )}
            {!historyLoading && historyJobs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-border/30 text-muted-foreground">
                      <th className="text-left py-2 pr-3 font-medium">ID</th>
                      <th className="text-left px-3 py-2 font-medium">Profile</th>
                      <th className="text-left px-3 py-2 font-medium">Status</th>
                      <th className="text-left px-3 py-2 font-medium">Target</th>
                      <th className="text-left px-3 py-2 font-medium">Result</th>
                      <th className="text-left px-3 py-2 font-medium">Passes</th>
                      <th className="text-left px-3 py-2 font-medium">Started</th>
                      <th className="text-left px-3 py-2 font-medium">Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyJobs.map((job) => {
                      const resultLabel = synthesisResultStateLabel(job);
                      return (
                        <Fragment key={job.id}>
                          <tr
                            className="border-b border-border/10 last:border-b-0 cursor-pointer hover:bg-primary/5"
                            onClick={() => void toggleJobDetails(job.id)}
                            title="Show Build Runtime Model run details"
                          >
                            <td className="py-2 pr-3 text-foreground font-medium">#{job.id}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {searchProfileLabel(job.searchProfile) !== "n/a"
                                ? searchProfileLabel(job.searchProfile)
                                : Number(job.maxPasses ?? 0) >= 24 ? "deep" : Number(job.maxPasses ?? 0) >= 12 ? "balanced" : "fast"}
                            </td>
                            <td className="px-3 py-2">
                              <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", synthesisStatusTone(job))}>
                                {synthesisResultStateLabel(job)}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{targetProfileLabel(job.targetProfile)}</td>
                            <td className="px-3 py-2 text-muted-foreground">{resultLabel}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {Number(job.currentPass ?? 0) > 0 || Number(job.maxPasses ?? 0) > 0
                                ? `${Number(job.currentPass ?? 0)}/${Number(job.maxPasses ?? 0)}`
                                : "n/a"}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{job.startedAt ? formatRuntimeDate(job.startedAt) : "n/a"}</td>
                            <td className="px-3 py-2 text-muted-foreground">{job.completedAt ? formatRuntimeDate(job.completedAt) : "n/a"}</td>
                          </tr>
                          {expandedJobId === job.id && (
                            <tr className="border-b border-border/10">
                              <td colSpan={8} className="py-3">
                                {expandedJobLoading && (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="w-4 h-4 animate-spin" />Loading runtime build result
                                  </div>
                                )}
                                {!expandedJobLoading && expandedJobErr && <p className="text-xs text-red-300">{expandedJobErr}</p>}
                                {!expandedJobLoading && expandedJobResult && <RuntimeBuildRunDetails result={expandedJobResult} />}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AdvancedDiagnosticsTab({ service, windowDays }: { service: string; windowDays: number }) {
  const [validation, setValidation] = useState<Record<string, unknown> | null>(null);
  const [parity, setParity] = useState<ParityReportUi | null>(null);
  const [runtimeModel, setRuntimeModel] = useState<RuntimeModelStateUi | null>(null);
  const [busy, setBusy] = useState<"validation" | "parity" | null>(null);
  const [optimiserBusy, setOptimiserBusy] = useState<"run" | "stage" | "refresh" | "cancel" | null>(null);
  const [optimiserRunId, setOptimiserRunId] = useState<number | null>(null);
  const [optimiserStatus, setOptimiserStatus] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [optimiserErr, setOptimiserErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [parityHistoryExpanded, setParityHistoryExpanded] = useState(false);
  const [validationHistoryExpanded, setValidationHistoryExpanded] = useState(false);
  const [optimiserHistoryExpanded, setOptimiserHistoryExpanded] = useState(false);
  const [parityHistory, setParityHistory] = useState<DiagnosticHistoryEntry[]>([]);
  const [validationHistory, setValidationHistory] = useState<DiagnosticHistoryEntry[]>([]);
  const [optimiserHistory, setOptimiserHistory] = useState<DiagnosticHistoryEntry[]>([]);

  const pollWorkerJobUntilTerminal = async (
    workerJobId: number,
    onCompleted: (artifact: unknown) => void,
  ) => {
    for (;;) {
      const data = await apiFetch(`worker/jobs/${workerJobId}`) as {
        job?: WorkerJobUi & { resultArtifact?: unknown; errorSummary?: Record<string, unknown> | null };
      };
      const job = data.job;
      if (!job) {
        throw new Error(`Worker job ${workerJobId} not found.`);
      }
      if (job.status === "completed") {
        onCompleted((job as { resultArtifact?: unknown }).resultArtifact ?? null);
        return;
      }
      if (job.status === "failed" || job.status === "cancelled") {
        const failure = job.errorSummary && typeof job.errorSummary === "object"
          ? (job.errorSummary as Record<string, unknown>)
          : null;
        throw new Error(String(failure?.reason ?? job.message ?? `Worker job ${workerJobId} ${job.status}`));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
    }
  };

  const refreshOptimiserStatus = async (runId = optimiserRunId, silent = false) => {
    if (!runId) return;
    if (!silent) {
      setOptimiserBusy("refresh");
      setOptimiserErr(null);
    }
    try {
      const status = await apiFetch(`calibration/runtime-model/${service}/optimise-backtest/${runId}`) as Record<string, unknown>;
      setOptimiserStatus(status);
    } catch (e: unknown) {
      setOptimiserErr(e instanceof Error ? e.message : "Optimiser status failed");
    } finally {
      if (!silent) setOptimiserBusy(null);
    }
  };

  const recordHistory = (
    action: DiagnosticHistoryEntry["action"],
    status: string,
    detail: string,
  ) => {
    const next = appendDiagnosticHistory({
      id: `${action}-${service}-${Date.now()}`,
      service,
      action,
      status,
      detail,
      at: new Date().toISOString(),
    });
    if (action === "parity") setParityHistory(next.filter((entry) => entry.service === service && entry.action === "parity"));
    if (action === "runtime-trigger-validation") setValidationHistory(next.filter((entry) => entry.service === service && entry.action === "runtime-trigger-validation"));
    if (action === "optimiser") setOptimiserHistory(next.filter((entry) => entry.service === service && entry.action === "optimiser"));
  };

  const loadValidation = async () => {
    setBusy("validation");
    setErr(null);
    setNotice(null);
    try {
      const d = await apiFetch(`calibration/runtime-model/${service}/runtime-trigger-validation/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays }),
      }) as { workerJobId?: number };
      const workerJobId = Number(d.workerJobId ?? 0);
      if (!Number.isInteger(workerJobId) || workerJobId <= 0) {
        throw new Error("Runtime trigger validation did not return a worker job id.");
      }
      const queuedMessage = `Runtime trigger validation queued for ${getSymbolLabel(service)} (worker job #${workerJobId}).`;
      setNotice(queuedMessage);
      recordHistory("runtime-trigger-validation", "queued", queuedMessage);
      await pollWorkerJobUntilTerminal(workerJobId, (artifact) => {
        setValidation(artifact as Record<string, unknown>);
        recordHistory("runtime-trigger-validation", "completed", `Runtime trigger validation completed for ${getSymbolLabel(service)}.`);
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Runtime trigger validation failed";
      setErr(message);
      recordHistory("runtime-trigger-validation", "failed", message);
    } finally {
      setBusy(null);
    }
  };

  const loadParity = async () => {
    setBusy("parity");
    setErr(null);
    setNotice(null);
    try {
      const d = await apiFetch(`calibration/runtime-model/${service}/parity-report/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays }),
      }) as { workerJobId?: number };
      const workerJobId = Number(d.workerJobId ?? 0);
      if (!Number.isInteger(workerJobId) || workerJobId <= 0) {
        throw new Error("Parity report did not return a worker job id.");
      }
      const queuedMessage = `Parity report queued for ${getSymbolLabel(service)} (worker job #${workerJobId}).`;
      setNotice(queuedMessage);
      recordHistory("parity", "queued", queuedMessage);
      await pollWorkerJobUntilTerminal(workerJobId, (artifact) => {
        setParity(artifact as ParityReportUi);
        recordHistory("parity", "completed", `Parity completed for ${getSymbolLabel(service)}.`);
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Parity report failed";
      setErr(message);
      recordHistory("parity", "failed", message);
    } finally {
      setBusy(null);
    }
  };

  const runOptimiser = async () => {
    setOptimiserBusy("run");
    setOptimiserErr(null);
    setNotice(null);
    try {
      const started = await apiFetch(`calibration/runtime-model/${service}/optimise-backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays, maxIterations: 5, enableAiReview: false }),
      }) as { runId?: number };
      const runId = Number(started.runId ?? 0);
      if (!Number.isInteger(runId) || runId <= 0) {
        throw new Error("Optimiser did not return a run id.");
      }
      setOptimiserRunId(runId);
      setOptimiserStatus(started as unknown as Record<string, unknown>);
      const message = `Optimiser started for ${getSymbolLabel(service)} (run ${runId}).`;
      setNotice(message);
      recordHistory("optimiser", "queued", message);
      window.setTimeout(() => { void refreshOptimiserStatus(runId); }, 2500);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Optimiser start failed";
      setOptimiserErr(message);
      recordHistory("optimiser", "failed", message);
    } finally {
      setOptimiserBusy(null);
    }
  };

  const cancelOptimiser = async () => {
    if (!optimiserRunId) return;
    setOptimiserBusy("cancel");
    setOptimiserErr(null);
    try {
      await apiFetch(`calibration/runtime-model/${service}/optimise-backtest/${optimiserRunId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "cancelled_from_research_ui" }),
      });
      await refreshOptimiserStatus(optimiserRunId);
      const message = `Optimiser cancellation requested for ${getSymbolLabel(service)} (run ${optimiserRunId}).`;
      setNotice(message);
      recordHistory("optimiser", "completed", message);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Optimiser cancel failed";
      setOptimiserErr(message);
      recordHistory("optimiser", "failed", message);
    } finally {
      setOptimiserBusy(null);
    }
  };

  const stageOptimiserWinner = async () => {
    if (!optimiserRunId) return;
    setOptimiserBusy("stage");
    setOptimiserErr(null);
    try {
      const staged = await apiFetch(`calibration/runtime-model/${service}/optimise-backtest/${optimiserRunId}/stage-winner`, {
        method: "POST",
      }) as Record<string, unknown>;
      setOptimiserStatus(staged);
      const runtime = await apiFetch(`calibration/runtime-model/${service}`).catch(() => null) as RuntimeModelStateUi | null;
      setRuntimeModel(runtime ?? null);
      const message = "Optimised winner staged. Runtime is not promoted until you click Promote To Runtime.";
      setNotice(message);
      recordHistory("optimiser", "completed", message);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Stage optimiser winner failed";
      setOptimiserErr(message);
      recordHistory("optimiser", "failed", message);
    } finally {
      setOptimiserBusy(null);
    }
  };

  const validationAggregates = (validation?.aggregates ?? null) as Record<string, unknown> | null;
  const optimiserRun = asUiRecord(optimiserStatus?.run);
  const optimiserWinner = asUiRecord(optimiserStatus?.selectedWinner);
  const optimiserPhase = String(optimiserRun.phase ?? optimiserStatus?.phase ?? "not run");
  const optimiserHeartbeat = optimiserRun.heartbeatAt ? formatRuntimeDate(String(optimiserRun.heartbeatAt)) : "n/a";
  const optimiserIsRunning = ["queued", "running"].includes(String(optimiserRun.status ?? optimiserStatus?.status ?? ""));
  const optimiserSelected = optimiserWinner && Object.keys(optimiserWinner).length > 0;
  const optimiserHasExistingRun = Boolean(optimiserRunId || optimiserRun.id || optimiserStatus?.runId);
  const optimiserReady = Boolean(parity) && (service !== "CRASH300" || Boolean(validationAggregates));
  const optimiserEnableReason = optimiserReady
    ? "Parity and runtime trigger validation are ready."
    : service === "CRASH300"
      ? "Run parity and runtime trigger validation first."
      : "Run parity first before using the optimiser.";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [parityResp, validationResp, runtimeResp] = await Promise.all([
          apiFetch(`calibration/runtime-model/${service}/parity-report?windowDays=${windowDays}`).catch(() => null),
          service === "CRASH300"
            ? apiFetch(`calibration/runtime-model/${service}/runtime-trigger-validation?windowDays=${windowDays}`).catch(() => null)
            : Promise.resolve(null),
          apiFetch(`calibration/runtime-model/${service}`).catch(() => null),
        ]);
        if (cancelled) return;
        setParity((parityResp as ParityReportUi | null) ?? null);
        setValidation((validationResp as Record<string, unknown> | null) ?? null);
        setRuntimeModel((runtimeResp as RuntimeModelStateUi | null) ?? null);
      } catch {
        // Keep the tab usable even if no previous diagnostics exist yet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service, windowDays]);

  useEffect(() => {
    setParityHistory(readDiagnosticHistory(service, "parity"));
    setValidationHistory(readDiagnosticHistory(service, "runtime-trigger-validation"));
    setOptimiserHistory(readDiagnosticHistory(service, "optimiser"));
  }, [service]);

  useEffect(() => {
    if (!optimiserRunId || !optimiserIsRunning) return;
    const id = window.setInterval(() => {
      void refreshOptimiserStatus(optimiserRunId, true);
    }, 2000);
    return () => window.clearInterval(id);
  }, [optimiserRunId, optimiserIsRunning]);

  return (
    <div className="space-y-4">
      {err && <ErrorBox msg={err} />}
      {optimiserErr && <ErrorBox msg={optimiserErr} />}
      {notice && <SuccessBox msg={notice} />}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Parity</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Use this card to run parity and compare calibrated moves against runtime candidates for the active service.
            </p>
          </div>
          <button type="button" onClick={() => void loadParity()} disabled={busy !== null} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-500/30 text-xs text-indigo-200 bg-indigo-500/10 hover:bg-indigo-500/15 disabled:opacity-50">
            {busy === "parity" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Validate Runtime
          </button>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1 text-[11px]">
            <p className="text-muted-foreground uppercase tracking-wide">Latest parity output</p>
            <p className="font-mono text-foreground">
              {parity?.generatedAt ? formatRuntimeDate(parity.generatedAt) : "No parity report loaded yet"}
            </p>
            <p className="text-muted-foreground">
              {parity?.totals?.totalMoves ? `${parity.totals.totalMoves} moves reviewed, ${parity.totals.matchedMoves ?? 0} matched.` : "Run parity to compare calibrated moves and runtime candidates."}
            </p>
          </div>
          <DiagnosticHistoryPanel
            entries={parityHistory}
            expanded={parityHistoryExpanded}
            onToggle={() => setParityHistoryExpanded((value) => !value)}
            emptyMessage={`No parity runs recorded yet for ${getSymbolLabel(service)}.`}
          />
        </div>
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Validate Runtime</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Use this card to validate runtime trigger health for the active service and inspect the latest aggregate output.
            </p>
          </div>
          <button type="button" onClick={() => void loadValidation()} disabled={busy !== null || service !== "CRASH300"} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/30 text-xs text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/15 disabled:opacity-50">
            {busy === "validation" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            Validate Runtime
          </button>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1 text-[11px]">
            <p className="text-muted-foreground uppercase tracking-wide">Latest trigger validation output</p>
            <p className="font-mono text-foreground">
              {service === "CRASH300"
                ? validationAggregates ? "Loaded" : "No validation report loaded yet"
                : "CRASH300-only"}
            </p>
            <p className="text-muted-foreground">
              {service === "CRASH300"
                ? validationAggregates ? `${Object.keys(validationAggregates).length} aggregate checks available.` : "Run trigger validation to inspect runtime trigger health."
                : "Runtime trigger validation is currently available for CRASH300 only."}
            </p>
          </div>
          <DiagnosticHistoryPanel
            entries={validationHistory}
            expanded={validationHistoryExpanded}
            onToggle={() => setValidationHistoryExpanded((value) => !value)}
            emptyMessage={`No runtime trigger validation runs recorded yet for ${getSymbolLabel(service)}.`}
          />
        </div>
      </div>
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Internal Optimisation Stage</h3>
          <p className="text-xs text-muted-foreground mt-1">
            This card stays visible throughout the workflow. It remains disabled until parity and runtime-trigger validation are available for the active service.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void runOptimiser()}
            disabled={optimiserBusy !== null || !runtimeModel?.lifecycle?.hasPromotedModel || !optimiserReady}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-500/30 text-xs text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/15 disabled:opacity-50"
          >
            {optimiserBusy === "run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BarChart2 className="w-3.5 h-3.5" />}
            Run Internal Optimisation
          </button>
          <button
            type="button"
            onClick={() => void refreshOptimiserStatus()}
            disabled={optimiserBusy !== null || !optimiserRunId}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/40 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {optimiserBusy === "refresh" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void cancelOptimiser()}
            disabled={optimiserBusy !== null || !optimiserRunId || !optimiserIsRunning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 text-xs text-red-300 bg-red-500/10 hover:bg-red-500/15 disabled:opacity-50"
          >
            {optimiserBusy === "cancel" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void stageOptimiserWinner()}
            disabled={optimiserBusy !== null || !optimiserRunId || !optimiserSelected}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-xs text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/15 disabled:opacity-50"
          >
            {optimiserBusy === "stage" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Stage Optimised Winner
          </button>
        </div>
        <div className="rounded-lg border border-border/30 bg-background/40 p-3 text-[11px] space-y-1">
          <p className="text-muted-foreground uppercase tracking-wide">Internal optimisation readiness</p>
          <p className={cn("font-medium", optimiserReady ? "text-emerald-200" : "text-amber-200")}>{optimiserEnableReason}</p>
          {!runtimeModel?.lifecycle?.hasPromotedModel && (
            <p className="text-muted-foreground">Promote a runtime model before running the optimiser.</p>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[11px]">
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Status</p>
            <p className="font-mono text-foreground">{String(optimiserRun.status ?? optimiserStatus?.status ?? "not run")}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Phase</p>
            <p className="font-mono text-foreground">{optimiserPhase}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Run</p>
            <p className="font-mono text-foreground">{String(optimiserRunId ?? optimiserRun.id ?? optimiserStatus?.runId ?? "n/a")}</p>
          </div>
          <div className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-1">
            <p className="text-muted-foreground uppercase tracking-wide">Heartbeat</p>
            <p className="font-mono text-foreground">{optimiserHeartbeat}</p>
          </div>
        </div>
        <DiagnosticHistoryPanel
          entries={optimiserHistory}
          expanded={optimiserHistoryExpanded}
          onToggle={() => setOptimiserHistoryExpanded((value) => !value)}
          emptyMessage={`No optimiser runs recorded yet for ${getSymbolLabel(service)}.`}
        />
      </div>

      {parity && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3 text-xs">
          <h3 className="text-sm font-semibold">Parity</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <StatRow label="Total moves" value={parity.totals?.totalMoves ?? 0} />
            <StatRow label="Matched moves" value={parity.totals?.matchedMoves ?? 0} />
            <StatRow label="No candidate" value={parity.totals?.noCandidate ?? 0} />
            <StatRow label="Direction mismatch" value={parity.totals?.directionMismatch ?? 0} />
            <StatRow label="Bucket mismatch" value={parity.totals?.bucketMismatch ?? 0} />
          </div>
        </div>
      )}

      {validationAggregates && (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3 text-xs">
          <h3 className="text-sm font-semibold">Trigger Validation Result</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {Object.entries(validationAggregates).slice(0, 10).map(([key, value]) => (
              <div key={key} className="rounded border border-border/30 bg-muted/10 p-2">
                <p className="text-muted-foreground">{key}</p>
                <p className="font-mono text-foreground">{String(value)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

//  Main Page 

export default function Research() {
  const [selectedService, setSelectedService] = useState<string>("CRASH300");
  const [activeTab, setActiveTab] = useState<ResearchTabId>("data");
  const [sharedWindowDays, setSharedWindowDays] = useState<number>(365);
  const [showAddService, setShowAddService] = useState(false);
  const [customServices, setCustomServices] = useState<string[]>([]);

  useEffect(() => {
    setCustomServices(readCustomResearchServices());
  }, []);

  const serviceSelectorOptions = useMemo(() => {
    const base = SERVICE_SELECTOR_OPTIONS.map((option) => ({
      symbol: option.symbol,
      label: option.label,
      group: option.group,
    }));
    const activeSet = new Set<string>(base.map((option) => option.symbol));
    const additions = customServices
      .filter((symbol) => !activeSet.has(symbol))
      .map((symbol) => ({
        symbol,
        label: getSymbolLabel(symbol),
        group: getSymbolGroup(symbol),
      }));
    return [...base, ...additions].sort((a, b) => {
      const groupCompare = a.group.localeCompare(b.group);
      return groupCompare !== 0 ? groupCompare : a.symbol.localeCompare(b.symbol);
    });
  }, [customServices]);

  useEffect(() => {
    if (serviceSelectorOptions.some((option) => option.symbol === selectedService)) return;
    setSelectedService(serviceSelectorOptions[0]?.symbol ?? "CRASH300");
  }, [selectedService, serviceSelectorOptions]);

  const handleSelectService = useCallback((service: string) => {
    setSelectedService(service);
    setActiveTab("data");
    setShowAddService(false);
  }, []);

  const handleAddService = useCallback((service: string) => {
    setCustomServices((prev) => {
      const next = Array.from(new Set([...prev, service]));
      writeCustomResearchServices(next);
      return next;
    });
    handleSelectService(service);
  }, [handleSelectService]);

  const tabs: { id: ResearchTabId; label: string; icon: React.ReactNode }[] = [
    { id: "data", label: "Data & Coverage", icon: <Activity className="w-3.5 h-3.5" /> },
    { id: "calibration", label: "Calibration", icon: <Target className="w-3.5 h-3.5" /> },
    { id: "synthesis", label: "Build Runtime Model", icon: <TrendingUp className="w-3.5 h-3.5" /> },
    { id: "runtime", label: "Runtime Model", icon: <Zap className="w-3.5 h-3.5" /> },
    { id: "reports", label: "Reports", icon: <FileText className="w-3.5 h-3.5" /> },
  ];

  return (
    <CalibrationRunProvider>
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FlaskConical className="w-6 h-6 text-primary" />
          Research
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Selected symbol-service research, runtime lifecycle, validation, and consolidated reports
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_auto] gap-3 items-end">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Service Selector</span>
          <select
            value={selectedService}
            onChange={(e) => setSelectedService(e.target.value)}
            className="w-full text-xs bg-background border border-border/50 rounded px-2 py-2 text-foreground focus:outline-none focus:border-primary/50"
          >
            {serviceSelectorOptions.map((option) => (
              <option key={option.symbol} value={option.symbol}>
                {option.symbol} - {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Research Window</span>
          <select
            value={sharedWindowDays}
            onChange={e => setSharedWindowDays(Number(e.target.value))}
            className="text-xs bg-background border border-primary/30 rounded px-2 py-2 text-primary focus:outline-none focus:border-primary/60"
          >
            {RESEARCH_WINDOWS.map(w => <option key={w.days} value={w.days}>{w.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Service Onboarding</span>
          <button
            type="button"
            onClick={() => setShowAddService(true)}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded border border-border/50 bg-background text-xs text-muted-foreground hover:text-foreground hover:border-border"
          >
            <Plus className="w-3.5 h-3.5" />
            Add New Service
          </button>
        </div>
      </div>

      {showAddService && (
        <AddServiceModal
          selectedService={selectedService}
          onClose={() => setShowAddService(false)}
          onCreateService={handleAddService}
        />
      )}

      <ServicePipelinePanel service={selectedService} onJumpToTab={setActiveTab} />
      <ServiceStatusSummary service={selectedService} windowDays={sharedWindowDays} />
      <ActiveWorkerTasksCard service={selectedService} />

      <div className="flex items-center gap-0.5 border-b border-border/30">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors",
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border/50"
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "data" && (
        <DataCoverageTab service={selectedService} />
      )}
      {activeTab === "calibration" && (
        <MoveCalibrationTab
          domain="active"
          windowDays={sharedWindowDays}
          lockedSymbol={selectedService}
          hideReportsActions
          showAdvancedDiagnostics={false}
          showIntegratedEliteSynthesis={false}
        />
      )}
      {activeTab === "synthesis" && (
        <div className="space-y-4">
          <IntegratedEliteSynthesisCard service={selectedService} windowDays={sharedWindowDays} />
        </div>
      )}
      {activeTab === "runtime" && (
        <RuntimeModelTab service={selectedService} />
      )}
      {activeTab === "reports" && (
        <ReportsTab service={selectedService} windowDays={sharedWindowDays} />
      )}
    </div>
    </CalibrationRunProvider>
  );
}

