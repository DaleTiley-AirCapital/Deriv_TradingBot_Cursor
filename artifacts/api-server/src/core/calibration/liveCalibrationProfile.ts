import type { TradingMode } from "../../infrastructure/deriv.js";
import { ACTIVE_SYMBOLS } from "../engineTypes.js";
import { getLatestSymbolResearchProfile } from "./symbolResearchProfile.js";

export interface LiveCalibrationProfile {
  symbol: string;
  source: "symbol_research_profile";
  sourceRunId: number;
  recommendedScanIntervalSeconds: number;
  recommendedScoreGates: {
    paper: number;
    demo: number;
    real: number;
  };
  expectedTradesPerMonth: number;
  expectedCapitalUtilizationPct: number;
  confidenceMultiplier: number;
  projectedMoveMultiplier: number;
  holdProfile: Record<string, unknown>;
  tpModel: Record<string, unknown>;
  slModel: Record<string, unknown>;
  trailingModel: Record<string, unknown>;
  formulaOverride: Record<string, unknown> | null;
}

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function enabledForMode(mode: TradingMode): boolean {
  // Rollout policy: paper-first only.
  return mode === "paper";
}

export async function getLiveCalibrationProfile(
  symbol: string,
  mode: TradingMode,
  stateMap: Record<string, string>,
): Promise<LiveCalibrationProfile | null> {
  if (!ACTIVE_SYMBOLS.includes(symbol as (typeof ACTIVE_SYMBOLS)[number])) return null;
  if (stateMap["use_calibrated_runtime_profiles"] !== "true") return null;
  if (!enabledForMode(mode)) return null;

  const profile = await getLatestSymbolResearchProfile(symbol);
  if (!profile) return null;

  const gates = profile.recommendedScoreGates ?? {};
  const paperGate = asNumber(gates.paper, 60);
  const demoGate = asNumber(gates.demo, 65);
  const realGate = asNumber(gates.real, 70);

  // Conservative influence factors: never create a second decision path.
  const confidenceMultiplier = Math.max(0.85, Math.min(1.15, paperGate / 60));
  const projectedMoveMultiplier = Math.max(
    0.9,
    Math.min(1.25, asNumber(profile.estimatedFitAdjustedMonthlyReturnPct, 0) / 12 || 1),
  );

  const profileRaw = asRecord(profile);
  const profileOverride = asRecord(
    profileRaw.recommendedFormulaOverride ?? profileRaw.formulaOverride,
  );
  const stateOverride = parseJsonRecord(
    stateMap[`calibration_formula_override_${symbol}`] ?? stateMap[`${symbol}_formula_override`],
  );
  const formulaOverride =
    Object.keys(stateOverride).length > 0
      ? stateOverride
      : Object.keys(profileOverride).length > 0
        ? profileOverride
        : null;

  return {
    symbol,
    source: "symbol_research_profile",
    sourceRunId: profile.lastRunId,
    recommendedScanIntervalSeconds: asNumber(profile.recommendedScanIntervalSeconds, 60),
    recommendedScoreGates: {
      paper: paperGate,
      demo: demoGate,
      real: realGate,
    },
    expectedTradesPerMonth: asNumber(profile.estimatedTradesPerMonth, 0),
    expectedCapitalUtilizationPct: asNumber(profile.estimatedCapitalUtilizationPct, 0),
    confidenceMultiplier,
    projectedMoveMultiplier,
    holdProfile: profile.recommendedHoldProfile ?? {},
    tpModel: profile.recommendedTpModel ?? {},
    slModel: profile.recommendedSlModel ?? {},
    trailingModel: profile.recommendedTrailingModel ?? {},
    formulaOverride,
  };
}
