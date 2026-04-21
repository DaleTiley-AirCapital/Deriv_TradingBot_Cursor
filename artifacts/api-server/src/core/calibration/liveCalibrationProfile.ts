import type { TradingMode } from "../../infrastructure/deriv.js";
import { ACTIVE_SYMBOLS } from "../engineTypes.js";
import {
  getPromotedSymbolRuntimeModel,
  type PromotedSymbolRuntimeModel,
} from "./promotedSymbolModel.js";

export type LiveCalibrationProfile = PromotedSymbolRuntimeModel;

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

  return getPromotedSymbolRuntimeModel(symbol);
}
