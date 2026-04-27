import type { CoordinatorOutput, EngineResult } from "../engineTypes.js";
import type { FeatureVector } from "../features.js";
import type { TradingMode } from "../../infrastructure/deriv.js";
import type { LiveCalibrationProfile } from "../calibration/liveCalibrationProfile.js";
import {
  evaluateRuntimeEntryEvidence,
  selectRuntimeTpBucket,
  type RuntimeQualityBand,
} from "../calibration/runtimeProfileUtils.js";
import { extractNativeScore } from "../allocatorCore.js";
import {
  applyRuntimeCalibrationExitModel,
  calculateSRFibSL,
  calculateSRFibTP,
} from "../tradeEngine.js";
import type { SymbolTradeCandidate } from "./types.js";

const SYNTHETIC_EQUITY = 10_000;
const SYNTHETIC_SIZE = 1_500;

function fallbackAtrPct(symbol: string): number {
  return symbol.startsWith("BOOM") || symbol.startsWith("CRASH") ? 0.008 : 0.005;
}

function pctDistance(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return 0;
  return Math.abs(a - b) / a;
}

export interface BuiltSymbolTradeCandidate {
  candidate: SymbolTradeCandidate;
  nativeScore: number;
  setupSignature: string;
  takeProfitPrice: number;
  stopLossPrice: number;
  trailingDistancePct: number;
}

export function buildSymbolTradeCandidate(params: {
  symbol: string;
  mode: TradingMode;
  coordinatorOutput: CoordinatorOutput;
  winner?: EngineResult | null;
  features: FeatureVector;
  spotPrice?: number | null;
  runtimeCalibration?: LiveCalibrationProfile | null;
  allowedQualityBands?: RuntimeQualityBand[] | null;
  positionSize?: number;
  equity?: number;
}): BuiltSymbolTradeCandidate | null {
  const winner = params.winner ?? params.coordinatorOutput.winner;
  if (!winner) return null;

  const direction = params.coordinatorOutput.resolvedDirection;
  const spotPrice = Number(params.spotPrice ?? params.features.latestClose);
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;

  const nativeScore = extractNativeScore(winner, params.coordinatorOutput.coordinatorConfidence);
  const runtimeSetup = evaluateRuntimeEntryEvidence({
    symbol: params.symbol,
    direction,
    nativeScore,
    winner,
    features: params.features,
    runtimeCalibration: params.runtimeCalibration,
    allowedQualityBands: params.allowedQualityBands,
  });
  const setupSignature = runtimeSetup.matchedBucketKey
    ? runtimeSetup.matchedBucketKey
    : `${runtimeSetup.leadInShape}|${runtimeSetup.qualityBand}`;

  const pivotLevels = [
    params.features.pivotR1, params.features.pivotR2, params.features.pivotR3,
    params.features.pivotS1, params.features.pivotS2, params.features.pivotS3,
  ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  let tp = calculateSRFibTP({
    entryPrice: spotPrice,
    direction,
    swingHigh: params.features.swingHigh,
    swingLow: params.features.swingLow,
    majorSwingHigh: params.features.majorSwingHigh,
    majorSwingLow: params.features.majorSwingLow,
    fibExtensionLevels: params.features.fibExtensionLevels ?? [],
    fibExtensionLevelsDown: params.features.fibExtensionLevelsDown ?? [],
    bbUpper: params.features.bbUpper,
    bbLower: params.features.bbLower,
    atrPct: params.features.atr14 > 0 ? params.features.atr14 / spotPrice : fallbackAtrPct(params.symbol),
    pivotLevels,
    vwap: params.features.vwap,
    psychRound: params.features.psychRound,
    prevSessionHigh: params.features.prevSessionHigh,
    prevSessionLow: params.features.prevSessionLow,
    spikeMagnitude: params.features.spikeMagnitude,
  });

  let sl = calculateSRFibSL({
    entryPrice: spotPrice,
    direction,
    tp,
    positionSize: params.positionSize ?? SYNTHETIC_SIZE,
    equity: params.equity ?? SYNTHETIC_EQUITY,
  });

  let trailingDistancePct = 0.30;
  ({ tp, sl, trailingStopPct: trailingDistancePct } = applyRuntimeCalibrationExitModel({
    spotPrice,
    direction,
    tp,
    sl,
    trailingStopPct: trailingDistancePct,
    mode: params.mode,
    runtimeCalibration: params.runtimeCalibration,
    nativeScore,
    features: params.features,
    leadInShape: runtimeSetup.leadInShape,
  }));

  if (!Number.isFinite(tp) || !Number.isFinite(sl) || tp <= 0 || sl <= 0) return null;

  const bucket = params.runtimeCalibration
    ? selectRuntimeTpBucket({
        runtimeCalibration: params.runtimeCalibration,
        direction,
        nativeScore,
        features: params.features,
      })
    : null;
  const trailingModel = params.runtimeCalibration?.trailingModel ?? {};
  const trailingArmPctRaw = Number(trailingModel["activationProfitPct"] ?? 0);

  const candidate: SymbolTradeCandidate = {
    symbol: params.symbol,
    engineName: winner.engineName,
    direction,
    nativeScore,
    confidenceScore: params.coordinatorOutput.coordinatorConfidence,
    qualityBand: runtimeSetup.qualityBand,
    leadInShape: runtimeSetup.leadInShape,
    setupSignature,
    runtimeSetup,
    exitPolicy: {
      source: params.runtimeCalibration?.source === "promoted_symbol_model"
        ? "promoted_runtime_model"
        : "native_symbol_engine",
      takeProfitPrice: tp,
      stopLossPrice: sl,
      takeProfitPct: pctDistance(spotPrice, tp),
      stopLossPct: pctDistance(spotPrice, sl),
      trailingArmPct: Number.isFinite(trailingArmPctRaw) && trailingArmPctRaw > 0 ? trailingArmPctRaw / 100 : 0.30,
      trailingDistancePct,
      minHoldMinutes: Number(params.runtimeCalibration?.trailingModel?.["minHoldMinutesBeforeTrail"] ?? 0) || undefined,
      bucketKey: bucket?.key ?? null,
    },
    features: params.features,
    runtimeCalibration: params.runtimeCalibration,
    sourceEngineResult: winner,
    reason: winner.reason,
    metadata: {
      scoringSource: winner.metadata?.["crash300ScoringSource"] ?? "native_engine",
      setupSignature,
      runtimeSetupReason: runtimeSetup.reason,
    },
  };

  return {
    candidate,
    nativeScore,
    setupSignature,
    takeProfitPrice: tp,
    stopLossPrice: sl,
    trailingDistancePct,
  };
}
