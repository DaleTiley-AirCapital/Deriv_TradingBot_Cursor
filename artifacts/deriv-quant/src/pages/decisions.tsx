import React, { useState, useMemo } from "react";
import { useGetLatestSignals, useGetPendingSignals } from "@workspace/api-client-react";
import type { GetLatestSignalsParams, SignalLog } from "@workspace/api-client-react";
import { formatNumber, cn } from "@/lib/utils";
import { downloadCSV, downloadJSON } from "@/lib/export";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, ArrowUpRight, ArrowDownRight, Brain, Filter, X, ChevronDown, ChevronUp,
  Download, ShieldAlert, Target, BarChart3, Clock, Layers, CheckCircle, XCircle,
  AlertTriangle, Activity, ChevronLeft, ChevronRight, Info,
} from "lucide-react";

// ── Constants ─────────────────────────────────────────────────────────────────

const ENGINES = [
  "boom_expansion_engine",
  "boom_expansion_long_engine",
  "crash_expansion_engine",
  "r75_continuation_engine",
  "r75_reversal_engine",
  "r75_breakout_engine",
  "r100_continuation_engine",
  "r100_reversal_engine",
  "r100_breakout_engine",
  "v3_engine",
] as const;

const ENGINE_LABELS: Record<string, string> = {
  boom_expansion_engine:    "Boom Expansion",
  boom_expansion_long_engine: "Boom Expansion Long",
  crash_expansion_engine:   "Crash Expansion",
  r75_continuation_engine:  "R75 Continuation",
  r75_reversal_engine:      "R75 Reversal",
  r75_breakout_engine:      "R75 Breakout",
  r100_continuation_engine: "R100 Continuation",
  r100_reversal_engine:     "R100 Reversal",
  r100_breakout_engine:     "R100 Breakout",
  v3_engine:                "V3 Engine",
};

const ENGINE_COLORS: Record<string, string> = {
  boom_expansion_engine:    "bg-emerald-500/12 text-emerald-400 border-emerald-500/25",
  boom_expansion_long_engine: "bg-lime-500/12 text-lime-400 border-lime-500/25",
  crash_expansion_engine:   "bg-red-500/12 text-red-400 border-red-500/25",
  r75_continuation_engine:  "bg-blue-500/12 text-blue-400 border-blue-500/25",
  r75_reversal_engine:      "bg-purple-500/12 text-purple-400 border-purple-500/25",
  r75_breakout_engine:      "bg-cyan-500/12 text-cyan-400 border-cyan-500/25",
  r100_continuation_engine: "bg-indigo-500/12 text-indigo-400 border-indigo-500/25",
  r100_reversal_engine:     "bg-violet-500/12 text-violet-400 border-violet-500/25",
  r100_breakout_engine:     "bg-sky-500/12 text-sky-400 border-sky-500/25",
  v3_engine:                "bg-amber-500/12 text-amber-400 border-amber-500/25",
};

const PAGE_SIZE = 50;

// ── State Classification ──────────────────────────────────────────────────────

type DecisionState = "traded" | "pending" | "approved" | "rejected" | "blocked" | "suppressed";

function classifyDecision(sig: SignalLog): DecisionState {
  if (sig.executionStatus === "open") return "traded";
  if (sig.executionStatus === "pending") return "pending";
  if (!sig.allowedFlag) {
    const r = sig.rejectionReason?.toLowerCase() ?? "";
    // Distinguish score-based rejection vs gate/mode blocking
    if (r.includes("composite") && r.includes("<")) return "rejected";
    if (r.includes("score") && r.includes("below")) return "rejected";
    if (r.startsWith("boom300_score_below")) return "rejected";
    if (r.startsWith("crash300_score_below")) return "rejected";
    if (r.startsWith("r75_reversal_score_below")) return "rejected";
    if (r.startsWith("r75_continuation_score_below")) return "rejected";
    if (r.startsWith("r75_breakout_score_below")) return "rejected";
    if (r.startsWith("r100_reversal_score_below")) return "rejected";
    if (r.startsWith("r100_breakout_score_below")) return "rejected";
    if (r.startsWith("r100_continuation_score_below")) return "rejected";
    if (r.includes("intelligence only") || r.includes("mode not active")) return "suppressed";
    return "blocked";
  }
  return "approved";
}

interface StateStyle {
  label: string;
  chip: string;
  icon: React.ElementType;
  row: string;
}

const STATE_STYLES: Record<DecisionState, StateStyle> = {
  traded:    { label: "Traded",    chip: "bg-green-500/12 text-green-400 border-green-500/25",   icon: CheckCircle,    row: "border-l-2 border-l-green-500/40" },
  pending:   { label: "Pending",   chip: "bg-amber-500/12 text-amber-400 border-amber-500/25",   icon: Clock,          row: "border-l-2 border-l-amber-500/40" },
  approved:  { label: "Approved",  chip: "bg-primary/12 text-primary border-primary/25",          icon: Activity,       row: "border-l-2 border-l-primary/30" },
  rejected:  { label: "Rejected",  chip: "bg-orange-500/12 text-orange-400 border-orange-500/25",icon: AlertTriangle,  row: "border-l-2 border-l-orange-500/40" },
  blocked:   { label: "Blocked",   chip: "bg-red-500/12 text-red-400 border-red-500/25",          icon: XCircle,        row: "border-l-2 border-l-red-500/40" },
  suppressed:{ label: "Suppressed",chip: "bg-slate-500/12 text-slate-400 border-slate-500/25",   icon: Info,           row: "border-l-2 border-l-slate-500/30" },
};

// ── Blocking Gate Parser ──────────────────────────────────────────────────────

interface GateInfo { gate: string; detail: string; raw: string }

function parseBlockingGate(reason: string | null | undefined): GateInfo | null {
  if (!reason) return null;
  const r = reason;

  // BOOM300-specific patterns (check first — more specific)
  if (r.startsWith("boom300_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "BOOM300 Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  // CRASH300-specific patterns
  if (r.startsWith("crash300_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "CRASH300 Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  // R_75 Reversal-specific patterns
  if (r.startsWith("r75_reversal_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "R75 Reversal Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  // R_75 Continuation-specific patterns
  if (r.startsWith("r75_continuation_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "R75 Continuation Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  // R_75 Breakout-specific patterns
  if (r.startsWith("r75_breakout_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "R75 Breakout Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  // R_100 Reversal-specific patterns
  if (r.startsWith("r100_reversal_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "R100 Reversal Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  // R_100 Breakout-specific patterns
  if (r.startsWith("r100_breakout_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "R100 Breakout Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  // R_100 Continuation-specific patterns
  if (r.startsWith("r100_continuation_score_below_mode_threshold")) {
    const nativeMatch = r.match(/native=(\d+)/);
    const modeMinMatch = r.match(/mode_min=(\d+)/);
    const native = nativeMatch ? nativeMatch[1] : "?";
    const modeMin = modeMinMatch ? modeMinMatch[1] : "?";
    return {
      gate: "R100 Continuation Score Gate",
      detail: `Native score ${native}/100 < mode threshold ${modeMin}`,
      raw: r,
    };
  }

  const patterns: { test: RegExp; gate: string; detail: (m: RegExpMatchArray) => string }[] = [
    { test: /composite.*?(\d+).*?[<below].*?(\d+)/i,     gate: "Score Below Threshold", detail: m => `Score ${m[1]} < required ${m[2]}` },
    { test: /composite.*?(\d+\.?\d*).*?<.*?(\d+\.?\d*)/i,gate: "Score Below Threshold", detail: m => `Score ${m[1]} < required ${m[2]}` },
    { test: /confidence.*?(\d+\.?\d*).*?<.*?(\d+\.?\d*)/i,gate:"Score Below Threshold", detail: m => `Confidence ${m[1]} < required ${m[2]}` },
    { test: /RR.*?(\d+\.?\d*).*?below.*?(\d+\.?\d*)/i,   gate: "R:R Ratio",             detail: m => `RR ${m[1]} < minimum ${m[2]}` },
    { test: /EV.*?(-?\d+\.?\d*).*?below.*?(-?\d+\.?\d*)/i,gate:"Expected Value",         detail: m => `EV ${m[1]} < minimum ${m[2]}` },
    { test: /kill.?switch/i,          gate: "Kill Switch",       detail: () => "Trading halted by kill switch" },
    { test: /daily.*loss/i,           gate: "Daily Loss Limit",  detail: () => "Daily loss limit reached" },
    { test: /weekly.*loss/i,          gate: "Weekly Loss Limit", detail: () => "Weekly loss limit reached" },
    { test: /max.*drawdown/i,         gate: "Max Drawdown",      detail: () => "Maximum drawdown exceeded" },
    { test: /open.*risk/i,            gate: "Open Risk",         detail: () => "Open risk limit exceeded" },
    { test: /max.*open.*trades/i,     gate: "Max Open Trades",   detail: () => "Concurrent trade limit reached" },
    { test: /AI disagree/i,           gate: "AI Verification",   detail: () => "AI disagreed with signal direction" },
    { test: /intelligence only/i,     gate: "Mode",              detail: () => "System in intelligence-only mode — no execution" },
    { test: /mode.*not.*active/i,     gate: "Mode",              detail: () => "No active trading mode configured" },
    { test: /interpolat/i,            gate: "Data Quality",      detail: () => "Interpolated candles detected — signal discarded" },
    { test: /insufficient.*data/i,    gate: "Data Quality",      detail: () => "Insufficient candle data for signal generation" },
    { test: /allocat/i,               gate: "Allocator",         detail: () => "Portfolio allocator rejected trade sizing" },
    { test: /coordinator/i,           gate: "Coordinator",       detail: () => "Signal coordinator blocked execution" },
  ];
  for (const p of patterns) {
    const m = r.match(p.test);
    if (m) return { gate: p.gate, detail: p.detail(m), raw: r };
  }
  return { gate: "Gate", detail: r.slice(0, 160), raw: r };
}

// ── Micro Components ──────────────────────────────────────────────────────────

function DirectionChip({ direction }: { direction: string | null | undefined }) {
  if (!direction) return <span className="text-muted-foreground/50 text-xs">—</span>;
  const buy = direction === "buy";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-bold uppercase", buy ? "text-emerald-400" : "text-red-400")}>
      {buy ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      {direction}
    </span>
  );
}

function ScorePill({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-xs text-muted-foreground/40">—</span>;
  const cls = score >= 70 ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/25"
    : score >= 55 ? "text-amber-400 bg-amber-500/10 border-amber-500/25"
    : "text-red-400 bg-red-500/10 border-red-500/25";
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-sm font-bold border tabular-nums", cls)}>
      {Math.round(score)}
    </span>
  );
}

function StateChip({ state }: { state: DecisionState }) {
  const s = STATE_STYLES[state];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border whitespace-nowrap", s.chip)}>
      <Icon className="w-3 h-3 shrink-0" /> {s.label}
    </span>
  );
}

function EngineChip({ family }: { family: string | null | undefined }) {
  if (!family) return <span className="text-muted-foreground/50 text-xs">—</span>;
  const cls = ENGINE_COLORS[family] ?? "bg-gray-500/12 text-gray-400 border-gray-500/25";
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border", cls)}>
      {ENGINE_LABELS[family] ?? family}
    </span>
  );
}

function AiVerdictChip({ verdict }: { verdict: string | null | undefined }) {
  if (!verdict || verdict === "skipped") return <span className="text-[11px] text-muted-foreground/40">—</span>;
  const cls = verdict === "agree" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/25"
    : verdict === "disagree" ? "text-red-400 bg-red-500/10 border-red-500/25"
    : "text-amber-400 bg-amber-500/10 border-amber-500/25";
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border", cls)}>
      <Brain className="w-3 h-3" />
      {verdict.charAt(0).toUpperCase() + verdict.slice(1)}
    </span>
  );
}

function FilterSelect({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void;
  options: readonly string[] | string[]; placeholder: string;
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="bg-card border border-border/50 rounded-md px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none">
      <option value="">{placeholder}</option>
      {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
  );
}

// ── Dimension Bars ────────────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<string, string> = {
  rangePosition: "Range Position",
  maDeviation: "MA Deviation",
  volatilityProfile: "Volatility Profile",
  rangeExpansion: "Range Expansion",
  directionalConfirmation: "Directional Confirm",
};

// BOOM300-native 6-component dimension labels
const BOOM300_DIMENSION_LABELS: Record<string, string> = {
  spikeClusterPressure:    "Spike Cluster Pressure",
  upsideDisplacement:      "Upside Displacement",
  exhaustionEvidence:      "Exhaustion Evidence",
  driftResumption:         "Drift Resumption",
  entryEfficiency:         "Entry Efficiency",
  expectedMoveSufficiency: "Expected Move Runway",
};

// Ordered for display (highest weight first)
const BOOM300_DIMENSION_ORDER = [
  "spikeClusterPressure",
  "upsideDisplacement",
  "exhaustionEvidence",
  "driftResumption",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isBoom300Breakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "spikeClusterPressure" in d || "upsideDisplacement" in d || "driftResumption" in d;
}

// CRASH300-native 6-component dimension labels
const CRASH300_DIMENSION_LABELS: Record<string, string> = {
  crashSpikeClusterPressure:  "Crash Spike Cluster Pressure",
  downsideDisplacement:       "Downside Displacement",
  exhaustionReversalEvidence: "Exhaustion / Reversal Evidence",
  recoveryQuality:            "Recovery / Cascade Quality",
  entryEfficiency:            "Entry Efficiency",
  expectedMoveSufficiency:    "Expected Move Runway",
};

// Ordered for display (highest weight first)
const CRASH300_DIMENSION_ORDER = [
  "crashSpikeClusterPressure",
  "downsideDisplacement",
  "exhaustionReversalEvidence",
  "recoveryQuality",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isCrash300Breakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "crashSpikeClusterPressure" in d || "downsideDisplacement" in d || "exhaustionReversalEvidence" in d;
}

// ── R_75 Reversal native 6-component dimension labels ────────────────────────
const R75_REVERSAL_DIMENSION_LABELS: Record<string, string> = {
  rangeExtremity:          "Range Extremity",
  reversalConfirmation:    "Reversal Confirmation",
  stretchDeviationQuality: "Stretch / Deviation",
  structureQuality:        "Structure Quality",
  entryEfficiency:         "Entry Efficiency",
  expectedMoveSufficiency: "Expected Move Runway",
};

const R75_REVERSAL_DIMENSION_ORDER = [
  "rangeExtremity",
  "reversalConfirmation",
  "stretchDeviationQuality",
  "structureQuality",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isR75ReversalBreakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "rangeExtremity" in d && "reversalConfirmation" in d && "stretchDeviationQuality" in d;
}

// ── R_75 Continuation native 6-component dimension labels ────────────────────
const R75_CONTINUATION_DIMENSION_LABELS: Record<string, string> = {
  trendQuality:            "Trend Quality",
  pullbackQuality:         "Pullback Quality",
  slopeAlignment:          "Slope Alignment",
  structureContinuity:     "Structure Continuity",
  entryEfficiency:         "Entry Efficiency",
  expectedMoveSufficiency: "Expected Move Runway",
};

const R75_CONTINUATION_DIMENSION_ORDER = [
  "trendQuality",
  "pullbackQuality",
  "slopeAlignment",
  "structureContinuity",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isR75ContinuationBreakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "trendQuality" in d && "pullbackQuality" in d && "slopeAlignment" in d;
}

// ── R_75 Breakout native 6-component dimension labels ────────────────────────
const R75_BREAKOUT_DIMENSION_LABELS: Record<string, string> = {
  boundaryPressure:        "Boundary Pressure",
  breakStrength:           "Break Strength",
  expansionQuality:        "Expansion Quality",
  retestAcceptanceQuality: "Retest / Acceptance",
  entryEfficiency:         "Entry Efficiency",
  expectedMoveSufficiency: "Expected Move Runway",
};

const R75_BREAKOUT_DIMENSION_ORDER = [
  "breakStrength",
  "boundaryPressure",
  "expansionQuality",
  "retestAcceptanceQuality",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isR75BreakoutBreakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "boundaryPressure" in d && "breakStrength" in d && "expansionQuality" in d && !("acceptanceQuality" in d);
}

// ── R_100 Reversal native 6-component dimension labels ────────────────────────
// Key "stretchDeviation" (not "stretchDeviationQuality") distinguishes from R_75
const R100_REVERSAL_DIMENSION_LABELS: Record<string, string> = {
  rangeExtremity:          "Range Extremity",
  reversalConfirmation:    "Reversal Confirmation",
  stretchDeviation:        "Stretch / Deviation",
  structureQuality:        "Structure Quality",
  entryEfficiency:         "Entry Efficiency",
  expectedMoveSufficiency: "Expected Move Runway",
};

const R100_REVERSAL_DIMENSION_ORDER = [
  "rangeExtremity",
  "reversalConfirmation",
  "stretchDeviation",
  "structureQuality",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isR100ReversalBreakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "rangeExtremity" in d && "reversalConfirmation" in d && "stretchDeviation" in d;
}

// ── R_100 Breakout native 6-component dimension labels ────────────────────────
// Key "acceptanceQuality" (not "retestAcceptanceQuality") distinguishes from R_75
const R100_BREAKOUT_DIMENSION_LABELS: Record<string, string> = {
  breakStrength:           "Break Strength",
  boundaryPressure:        "Boundary Pressure",
  expansionQuality:        "Expansion Quality",
  acceptanceQuality:       "Acceptance Quality",
  entryEfficiency:         "Entry Efficiency",
  expectedMoveSufficiency: "Expected Move Runway",
};

const R100_BREAKOUT_DIMENSION_ORDER = [
  "breakStrength",
  "expansionQuality",
  "boundaryPressure",
  "acceptanceQuality",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isR100BreakoutBreakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "boundaryPressure" in d && "breakStrength" in d && "acceptanceQuality" in d;
}

// ── R_100 Continuation native 6-component dimension labels ────────────────────
// Key "trendStrength" (not "trendQuality") distinguishes from R_75
const R100_CONTINUATION_DIMENSION_LABELS: Record<string, string> = {
  trendStrength:           "Trend Strength",
  pullbackQuality:         "Pullback Quality",
  slopeAlignment:          "Slope Alignment",
  structureContinuity:     "Structure Continuity",
  entryEfficiency:         "Entry Efficiency",
  expectedMoveSufficiency: "Expected Move Runway",
};

const R100_CONTINUATION_DIMENSION_ORDER = [
  "trendStrength",
  "pullbackQuality",
  "slopeAlignment",
  "structureContinuity",
  "entryEfficiency",
  "expectedMoveSufficiency",
] as const;

function isR100ContinuationBreakdown(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== "object") return false;
  const d = dims as Record<string, unknown>;
  return "trendStrength" in d && "pullbackQuality" in d && "slopeAlignment" in d;
}

function DimBar({ label, value }: { label: string; value: number }) {
  const cls = value >= 75 ? "bg-emerald-500" : value >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-32 shrink-0 text-right">{label}</span>
      <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-300", cls)} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-foreground w-6 text-right">{value}</span>
    </div>
  );
}

// ── Detail Panel ─────────────────────────────────────────────────────────────

function DR({ label, value, highlight }: { label: string; value: string; highlight?: "green" | "red" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={cn("text-[11px] tabular-nums font-medium",
        highlight === "green" ? "text-emerald-400" : highlight === "red" ? "text-red-400" : "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

function DecisionDetailPanel({ sig, state }: { sig: SignalLog; state: DecisionState }) {
  const tp = sig.suggestedTp != null ? Math.abs(sig.suggestedTp) : null;
  const sl = sig.suggestedSl != null ? Math.abs(sig.suggestedSl) : null;
  const rr = sl && sl > 0 && tp ? (tp / sl) : null;
  const gate = parseBlockingGate(sig.rejectionReason);

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className="grid grid-cols-1 md:grid-cols-3 gap-4 px-4 py-4 bg-muted/5 border-t border-border/20">

      {/* Column 1: Scoring */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-primary" />
          {isCrash300Breakdown(sig.scoringDimensions) ? "CRASH300 Native Score"
            : isBoom300Breakdown(sig.scoringDimensions) ? "BOOM300 Native Score"
            : isR75ReversalBreakdown(sig.scoringDimensions) ? "R75 Reversal Score"
            : isR75ContinuationBreakdown(sig.scoringDimensions) ? "R75 Continuation Score"
            : isR75BreakoutBreakdown(sig.scoringDimensions) ? "R75 Breakout Score"
            : isR100ReversalBreakdown(sig.scoringDimensions) ? "R100 Reversal Score"
            : isR100BreakoutBreakdown(sig.scoringDimensions) ? "R100 Breakout Score"
            : isR100ContinuationBreakdown(sig.scoringDimensions) ? "R100 Continuation Score"
            : "Score Breakdown"}
        </h4>
        {sig.scoringDimensions ? (
          isCrash300Breakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score</p>
              {CRASH300_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={CRASH300_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: cluster×0.25 · disp×0.20 · exhaust×0.20 · recovery×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : isBoom300Breakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score</p>
              {BOOM300_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={BOOM300_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: spike×0.25 · disp×0.20 · exhaust×0.20 · drift×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : isR75ReversalBreakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score · Reversal</p>
              {R75_REVERSAL_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={R75_REVERSAL_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: extreme×0.25 · reversal×0.20 · stretch×0.20 · structure×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : isR75ContinuationBreakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score · Continuation</p>
              {R75_CONTINUATION_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={R75_CONTINUATION_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: trend×0.25 · pullback×0.20 · slope×0.20 · structure×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : isR75BreakoutBreakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score · Breakout</p>
              {R75_BREAKOUT_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={R75_BREAKOUT_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: break×0.25 · boundary×0.20 · expand×0.20 · retest×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : isR100ReversalBreakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score · R100 Reversal</p>
              {R100_REVERSAL_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={R100_REVERSAL_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: extreme×0.25 · reversal×0.22 · stretch×0.18 · structure×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : isR100BreakoutBreakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score · R100 Breakout</p>
              {R100_BREAKOUT_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={R100_BREAKOUT_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: break×0.25 · expand×0.22 · boundary×0.18 · accept×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : isR100ContinuationBreakdown(sig.scoringDimensions) ? (
            <div className="space-y-1.5">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">6-Component Engine Score · R100 Continuation</p>
              {R100_CONTINUATION_DIMENSION_ORDER.map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={R100_CONTINUATION_DIMENSION_LABELS[key]} value={val} />;
              })}
              <div className="mt-1 pt-1.5 border-t border-border/20">
                <p className="text-[9px] text-muted-foreground/50 mt-1">
                  Weights: trend×0.25 · pullback×0.20 · slope×0.20 · structure×0.15 · entry×0.10 · move×0.10
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {Object.keys(DIMENSION_LABELS).map(key => {
                const val = (sig.scoringDimensions as unknown as Record<string, number>)[key];
                if (val == null) return null;
                return <DimBar key={key} label={DIMENSION_LABELS[key]} value={val} />;
              })}
            </div>
          )
        ) : (
          <p className="text-[10px] text-muted-foreground">No dimension data available</p>
        )}
        <div className="pt-2 border-t border-border/20 space-y-1">
          <DR label={
            isCrash300Breakdown(sig.scoringDimensions) || isBoom300Breakdown(sig.scoringDimensions) ||
            isR75ReversalBreakdown(sig.scoringDimensions) || isR75ContinuationBreakdown(sig.scoringDimensions) || isR75BreakoutBreakdown(sig.scoringDimensions) ||
            isR100ReversalBreakdown(sig.scoringDimensions) || isR100BreakoutBreakdown(sig.scoringDimensions) || isR100ContinuationBreakdown(sig.scoringDimensions)
              ? "Native Score" : "Composite Score"
          } value={sig.compositeScore != null ? Math.round(sig.compositeScore).toString() : "—"} />
          <DR label="Raw Score" value={formatNumber(sig.score, 3)} />
          <DR label="Expected Value" value={formatNumber(sig.expectedValue, 4)} highlight={sig.expectedValue > 0 ? "green" : "red"} />
        </div>
      </div>

      {/* Column 2: Engine & Trade Details */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <Target className="w-3.5 h-3.5 text-primary" /> Engine Outcome
        </h4>
        <div className="space-y-1">
          <DR label="Direction" value={sig.direction?.toUpperCase() ?? "—"} />
          <DR label="Engine" value={ENGINE_LABELS[sig.strategyFamily ?? ""] ?? sig.strategyFamily ?? "—"} />
          <DR label="Strategy" value={sig.strategyName ?? "—"} />
          <DR label="Regime" value={sig.regime ?? "—"} />
          <DR label="Regime Certainty" value={sig.regimeConfidence != null ? `${(sig.regimeConfidence * 100).toFixed(0)}%` : "—"} />
          <DR label="Mode" value={sig.mode ?? "—"} />
          <DR label="Allocation" value={sig.allocationPct != null ? `${sig.allocationPct.toFixed(1)}%` : "—"} />
        </div>
        <div className="pt-2 border-t border-border/20 space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Trade Plan</p>
          <DR label="Take Profit (offset)" value={tp != null ? formatNumber(tp, 4) : "—"} highlight="green" />
          <DR label="Stop Loss (offset)" value={sl != null ? formatNumber(sl, 4) : "—"} highlight="red" />
          <DR label="R:R Ratio" value={rr != null ? `${rr.toFixed(2)}:1` : "—"} />
        </div>
        {(sig.expectedMovePct != null || sig.expectedHoldDays != null || sig.captureRate != null || sig.empiricalWinRate != null) && (
          <div className="pt-2 border-t border-border/20 space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Signal Intelligence</p>
            {sig.expectedMovePct != null && <DR label="Expected Move %" value={`${(sig.expectedMovePct * 100).toFixed(1)}%`} highlight="green" />}
            {sig.expectedHoldDays != null && <DR label="Expected Hold" value={`${sig.expectedHoldDays.toFixed(0)} days`} />}
            {sig.captureRate != null && <DR label="Capture Rate" value={`${(sig.captureRate * 100).toFixed(0)}%`} />}
            {sig.empiricalWinRate != null && <DR label="Empirical Win Rate" value={`${(sig.empiricalWinRate * 100).toFixed(0)}%`} />}
          </div>
        )}
      </div>

      {/* Column 3: Decision Reasoning & AI */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-primary" /> Decision & AI Verdict
        </h4>

        {/* Gate result */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Decision State</span>
            <StateChip state={state} />
          </div>

          {/* Coordinator / Allocator rows */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Coordinator</span>
            <span className="text-[11px] font-medium text-foreground">
              {sig.allowedFlag ? "Passed" : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Allocator</span>
            <span className="text-[11px] font-medium text-foreground">
              {sig.executionStatus === "open" ? "Executed" : sig.allowedFlag ? "Pending" : "—"}
            </span>
          </div>
        </div>

        {/* Rejection reason block */}
        {!sig.allowedFlag && gate && (
          <div className="rounded-md bg-red-500/6 border border-red-500/20 p-2.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-red-400/80">Blocking Gate</span>
              <span className="text-[11px] font-bold text-red-400">{gate.gate}</span>
            </div>
            <p className="text-[11px] text-red-400/80">{gate.detail}</p>
            {gate.raw !== gate.detail && (
              <p className="text-[10px] text-red-400/50 leading-relaxed font-mono">{gate.raw.slice(0, 200)}</p>
            )}
          </div>
        )}

        {/* Why it passed */}
        {sig.allowedFlag && (
          <div className="rounded-md bg-green-500/6 border border-green-500/20 p-2.5">
            <p className="text-[10px] font-semibold text-green-400/80 mb-1">Why It Passed</p>
            <div className="space-y-0.5 text-[10px] text-green-400/70">
              {sig.compositeScore != null && <p>Score {Math.round(sig.compositeScore)} ≥ mode threshold</p>}
              {sig.expectedValue != null && sig.expectedValue > 0 && <p>Positive expected value: {sig.expectedValue.toFixed(4)}</p>}
              {rr != null && rr >= 1.5 && <p>R:R ratio {rr.toFixed(2)}:1 ≥ minimum</p>}
            </div>
          </div>
        )}

        {/* AI verdict */}
        <div className="pt-2 border-t border-border/20 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">AI Verdict</span>
            <AiVerdictChip verdict={!sig.allowedFlag ? "skipped" : sig.aiVerdict} />
          </div>
          {sig.aiReasoning && sig.aiVerdict !== "skipped" && (
            <div className="rounded-md bg-muted/20 border border-border/30 p-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">{sig.aiReasoning}</p>
            </div>
          )}
          {!sig.aiReasoning && !sig.allowedFlag && (
            <p className="text-[10px] text-slate-400/70 italic">Signal blocked before reaching AI verification step.</p>
          )}
          {sig.aiConfidenceAdj != null && sig.aiConfidenceAdj !== 0 && (
            <DR label="AI Score Adjustment" value={`${sig.aiConfidenceAdj > 0 ? "+" : ""}${sig.aiConfidenceAdj}`} />
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── Pending Confirmations Block ───────────────────────────────────────────────

function PendingBlock({ data }: { data: ReturnType<typeof useGetPendingSignals>["data"] }) {
  if (!data || data.count === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/3">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-500/15">
        <Clock className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-amber-400">Awaiting Confirmation ({data.count})</span>
      </div>
      <div className="p-3 space-y-2">
        {data.signals.map(ps => (
          <div key={`${ps.symbol}-${ps.strategyName}-${ps.direction}`}
            className="rounded-lg border border-border/50 bg-card p-3 flex items-center gap-4">
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <DirectionChip direction={ps.direction} />
              <span className="font-semibold text-sm">{ps.symbol}</span>
              <EngineChip family={ps.strategyFamily} />
              {ps.pyramidLevel > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/50 text-[10px] text-muted-foreground">
                  <Layers className="w-3 h-3" />L{ps.pyramidLevel + 1}
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
            <ScorePill score={ps.lastCompositeScore} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Decisions() {
  const [symbolFilter, setSymbolFilter] = useState("");
  const [engineFilter, setEngineFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [aiFilter, setAiFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const params: GetLatestSignalsParams = useMemo(() => {
    const p: GetLatestSignalsParams = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (symbolFilter) p.symbol = symbolFilter;
    if (engineFilter) p.family = engineFilter;
    if (statusFilter === "approved" || statusFilter === "blocked") p.status = statusFilter;
    if (aiFilter) p.ai = aiFilter;
    (p as any)._dateFrom = dateFrom || undefined;
    (p as any)._dateTo   = dateTo   || undefined;
    return p;
  }, [symbolFilter, engineFilter, statusFilter, aiFilter, page, dateFrom, dateTo]);

  const { data, isLoading } = useGetLatestSignals(params, { query: { refetchInterval: 5000 } });
  const { data: pendingData } = useGetPendingSignals({ query: { refetchInterval: 5000 } });

  const signals = data?.signals ?? [];
  const total = data?.total ?? 0;
  const visThreshold = data?.visibilityThreshold ?? 70;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasFilters = !!(symbolFilter || engineFilter || statusFilter || aiFilter || dateFrom || dateTo);

  const dateFiltered = useMemo(() => {
    if (!dateFrom && !dateTo) return signals;
    return signals.filter(sig => {
      const d = new Date(sig.ts);
      if (dateFrom && d < new Date(dateFrom)) return false;
      if (dateTo) { const end = new Date(dateTo); end.setDate(end.getDate() + 1); if (d >= end) return false; }
      return true;
    });
  }, [signals, dateFrom, dateTo]);

  const symbolOptions = useMemo(() => {
    const s = new Set<string>();
    signals.forEach(sig => s.add(sig.symbol));
    return Array.from(s).sort();
  }, [signals]);

  // Summary stats
  const counts = useMemo(() => {
    const result: Record<DecisionState, number> = { traded: 0, pending: 0, approved: 0, rejected: 0, blocked: 0, suppressed: 0 };
    for (const sig of dateFiltered) result[classifyDecision(sig)]++;
    return result;
  }, [dateFiltered]);

  function clearFilters() {
    setSymbolFilter(""); setEngineFilter(""); setStatusFilter(""); setAiFilter("");
    setDateFrom(""); setDateTo(""); setPage(0);
  }

  function toggleRow(id: number) {
    setExpandedId(prev => prev === id ? null : id);
  }

  return (
    <div className="space-y-4 max-w-[1400px] mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="w-6 h-6 text-primary" /> Engine Decisions
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Every signal decision — why it passed, why it failed, what the AI said
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => downloadCSV(dateFiltered.map(s => ({
            time: new Date(s.ts).toISOString(), symbol: s.symbol,
            engine: ENGINE_LABELS[s.strategyFamily ?? ""] ?? s.strategyFamily,
            direction: s.direction, compositeScore: s.compositeScore, score: s.score,
            expectedValue: s.expectedValue, regime: s.regime, state: classifyDecision(s),
            rejectionReason: s.rejectionReason, aiVerdict: s.aiVerdict, mode: s.mode,
          })), "decisions_log")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors">
            <Download className="w-3 h-3" /> CSV
          </button>
          <button onClick={() => downloadJSON(dateFiltered as unknown as Record<string, unknown>[], "decisions_log")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors">
            <Download className="w-3 h-3" /> JSON
          </button>
        </div>
      </div>

      {/* State summary bar */}
      {total > 0 && (
        <div className="flex flex-wrap gap-3">
          {(["traded", "approved", "pending", "rejected", "blocked", "suppressed"] as DecisionState[]).map(state => {
            const n = counts[state];
            if (n === 0 && state !== "approved") return null;
            const s = STATE_STYLES[state];
            return (
              <button
                key={state}
                onClick={() => setStatusFilter(
                  statusFilter === state ? "" :
                  state === "blocked" || state === "rejected" || state === "suppressed" ? "blocked" :
                  state === "approved" || state === "traded" ? "approved" : ""
                )}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors",
                  s.chip, "hover:opacity-80"
                )}>
                {n} {s.label}
              </button>
            );
          })}
          <span className="text-xs text-muted-foreground self-center tabular-nums ml-auto">{total} total</span>
        </div>
      )}

      {/* Pending confirmations */}
      <PendingBlock data={pendingData} />

      {/* Filter bar */}
      <div className="rounded-xl border border-border/50 bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <FilterSelect value={symbolFilter} onChange={v => { setSymbolFilter(v); setPage(0); }}
            options={symbolOptions.length > 0 ? symbolOptions : ["BOOM300", "CRASH300", "R_75", "R_100"]}
            placeholder="All Symbols" />
          <FilterSelect value={engineFilter} onChange={v => { setEngineFilter(v); setPage(0); }}
            options={ENGINES} placeholder="All Engines" />
          <FilterSelect value={statusFilter} onChange={v => { setStatusFilter(v); setPage(0); }}
            options={["approved", "blocked"]} placeholder="All States" />
          <FilterSelect value={aiFilter} onChange={v => { setAiFilter(v); setPage(0); }}
            options={["agree", "disagree", "uncertain"]} placeholder="AI Verdict" />
          <span className="text-[10px] text-muted-foreground">From:</span>
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(0); }}
            className="bg-card border border-border/50 rounded-md px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none" />
          <span className="text-[10px] text-muted-foreground">To:</span>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(0); }}
            className="bg-card border border-border/50 rounded-md px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none" />
          {hasFilters && (
            <button onClick={clearFilters}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-3 h-3" /> Clear
            </button>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            Score visibility threshold: ≥{visThreshold}
          </span>
        </div>
      </div>

      {/* Decision table */}
      <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Activity className="w-6 h-6 text-muted-foreground/30 animate-pulse" />
            <span className="ml-2 text-sm text-muted-foreground">Loading decisions…</span>
          </div>
        ) : dateFiltered.length === 0 ? (
          <div className="text-center py-16">
            <Zap className="w-10 h-10 text-muted-foreground/15 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {hasFilters ? "No decisions match the current filters" : "No decisions recorded yet"}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {!hasFilters && "Signal scanner runs every ~60 seconds — decisions appear here as they come in"}
            </p>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto] gap-x-4 px-4 py-2.5 border-b border-border/40 bg-muted/10
              text-[11px] text-muted-foreground uppercase tracking-wide font-medium">
              <span>Symbol / Engine</span>
              <span className="w-16 text-center">Dir</span>
              <span className="w-16 text-right">Score</span>
              <span className="w-24 text-center">State</span>
              <span className="w-20 text-center">AI</span>
              <span className="w-36 text-right">Time</span>
              <span className="w-5" />
            </div>

            {/* Rows */}
            <div className="divide-y divide-border/20">
              {dateFiltered.map(sig => {
                const state = classifyDecision(sig);
                const style = STATE_STYLES[state];
                const isExpanded = expandedId === sig.id;
                const ts = new Date(sig.ts).toLocaleString(undefined, {
                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                });

                return (
                  <React.Fragment key={sig.id}>
                    <div
                      className={cn(
                        "grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto] gap-x-4 px-4 py-2.5",
                        "cursor-pointer hover:bg-muted/10 transition-colors items-center",
                        style.row,
                        isExpanded && "bg-muted/5"
                      )}
                      onClick={() => toggleRow(sig.id)}>

                      {/* Symbol + Engine */}
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-bold text-sm font-mono text-foreground shrink-0">{sig.symbol}</span>
                        <EngineChip family={sig.strategyFamily} />
                      </div>

                      {/* Direction */}
                      <div className="w-16 flex justify-center">
                        <DirectionChip direction={sig.direction} />
                      </div>

                      {/* Score */}
                      <div className="w-16 flex justify-end">
                        <ScorePill score={sig.compositeScore} />
                      </div>

                      {/* State */}
                      <div className="w-24 flex justify-center">
                        <StateChip state={state} />
                      </div>

                      {/* AI Verdict */}
                      <div className="w-20 flex justify-center">
                        <AiVerdictChip verdict={!sig.allowedFlag ? null : sig.aiVerdict} />
                      </div>

                      {/* Time */}
                      <div className="w-36 text-right text-[11px] text-muted-foreground tabular-nums">
                        {ts}
                      </div>

                      {/* Expand toggle */}
                      <div className="w-5 flex justify-end">
                        {isExpanded
                          ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                          : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                      </div>
                    </div>

                    <AnimatePresence>
                      {isExpanded && (
                        <DecisionDetailPanel sig={sig} state={state} />
                      )}
                    </AnimatePresence>
                  </React.Fragment>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {page + 1} of {totalPages} · {total} total decisions</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="p-1.5 rounded-md border border-border/50 hover:bg-muted/20 disabled:opacity-30 transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="p-1.5 rounded-md border border-border/50 hover:bg-muted/20 disabled:opacity-30 transition-colors">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
