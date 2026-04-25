import type { TradingMode } from "../../infrastructure/deriv.js";
import { ACTIVE_SYMBOLS } from "../engineTypes.js";
import {
  getPromotedSymbolRuntimeModel,
  type PromotedSymbolRuntimeModel,
} from "./promotedSymbolModel.js";

export type LiveCalibrationProfile = PromotedSymbolRuntimeModel;
export type LiveCalibrationProfileResolutionReason =
  | "applied"
  | "inactive_symbol"
  | "disabled_by_state"
  | "unsupported_mode"
  | "missing_promoted_model";

export interface LiveCalibrationProfileResolution {
  profile: LiveCalibrationProfile | null;
  applied: boolean;
  reason: LiveCalibrationProfileResolutionReason;
  symbol: string;
  mode: TradingMode;
  useCalibratedRuntimeProfiles: boolean;
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
  const resolution = await resolveLiveCalibrationProfile(symbol, mode, stateMap);
  return resolution.profile;
}

export async function resolveLiveCalibrationProfile(
  symbol: string,
  mode: TradingMode,
  stateMap: Record<string, string>,
): Promise<LiveCalibrationProfileResolution> {
  const useCalibratedRuntimeProfiles = stateMap["use_calibrated_runtime_profiles"] === "true";
  const base = {
    symbol,
    mode,
    useCalibratedRuntimeProfiles,
  };

  if (!ACTIVE_SYMBOLS.includes(symbol as (typeof ACTIVE_SYMBOLS)[number])) {
    return { ...base, profile: null, applied: false, reason: "inactive_symbol" };
  }

  if (!useCalibratedRuntimeProfiles) {
    return { ...base, profile: null, applied: false, reason: "disabled_by_state" };
  }

  if (!enabledForMode(mode)) {
    return { ...base, profile: null, applied: false, reason: "unsupported_mode" };
  }

  const profile = await getPromotedSymbolRuntimeModel(symbol);
  if (!profile) {
    return { ...base, profile: null, applied: false, reason: "missing_promoted_model" };
  }

  return { ...base, profile, applied: true, reason: "applied" };
}
