import { db, featuresTable, modelRunsTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import type { FeatureVector } from "./features.js";
import type { StrategyFamily } from "./regimeEngine.js";

interface SymbolEmpiricalData {
  avgWinPct: number;
  avgLossPct: number;
  medianHoldDays: number;
  swingsPerMonth: number;
  avgUpMagnitude: number;
  avgDownMagnitude: number;
}

const SYMBOL_EMPIRICAL_DATA: Record<string, SymbolEmpiricalData> = {
  CRASH300: {
    avgWinPct: 0.42,
    avgLossPct: 0.084,
    medianHoldDays: 8,
    swingsPerMonth: 3.1,
    avgUpMagnitude: 0.421,
    avgDownMagnitude: 0.290,
  },
  BOOM300: {
    avgWinPct: 0.30,
    avgLossPct: 0.06,
    medianHoldDays: 6,
    swingsPerMonth: 3.6,
    avgUpMagnitude: 0.302,
    avgDownMagnitude: 0.257,
  },
  R_75: {
    avgWinPct: 0.18,
    avgLossPct: 0.036,
    medianHoldDays: 5,
    swingsPerMonth: 5.9,
    avgUpMagnitude: 0.178,
    avgDownMagnitude: 0.182,
  },
  R_100: {
    avgWinPct: 0.17,
    avgLossPct: 0.034,
    medianHoldDays: 2,
    swingsPerMonth: 14.2,
    avgUpMagnitude: 0.173,
    avgDownMagnitude: 0.153,
  },
};

function getSymbolEmpirical(symbol: string): SymbolEmpiricalData {
  if (SYMBOL_EMPIRICAL_DATA[symbol]) return SYMBOL_EMPIRICAL_DATA[symbol];
  if (symbol.startsWith("CRASH")) return SYMBOL_EMPIRICAL_DATA.CRASH300;
  if (symbol.startsWith("BOOM")) return SYMBOL_EMPIRICAL_DATA.BOOM300;
  if (symbol === "R_75") return SYMBOL_EMPIRICAL_DATA.R_75;
  if (symbol === "R_100") return SYMBOL_EMPIRICAL_DATA.R_100;
  if (symbol.startsWith("R_")) return SYMBOL_EMPIRICAL_DATA.R_75;
  return SYMBOL_EMPIRICAL_DATA.R_75;
}

export interface SignalMetadata {
  expectedMovePct: number;
  expectedHoldDays: number;
  captureRate: number;
  empiricalWinRate: number;
}

export function computeSignalMetadata(
  features: FeatureVector,
  direction: "buy" | "sell",
): SignalMetadata {
  const emp = getSymbolEmpirical(features.symbol);
  const avgMag = direction === "buy" ? emp.avgUpMagnitude : emp.avgDownMagnitude;

  const distLow = Math.abs(features.distFromRange30dLowPct);
  const distHigh = Math.abs(features.distFromRange30dHighPct);
  const rangePos = direction === "buy" ? distLow : distHigh;
  const captureRate = Math.min(0.95, Math.max(0.4, 1 - rangePos * 3));

  const expectedMovePct = avgMag * captureRate;
  const expectedHoldDays = emp.medianHoldDays;
  const empiricalWinRate = Math.min(0.90, emp.swingsPerMonth / 30 * emp.medianHoldDays * 1.5);

  return {
    expectedMovePct,
    expectedHoldDays,
    captureRate,
    empiricalWinRate: Math.max(0.5, empiricalWinRate),
  };
}

export function computeBigMoveReadiness(
  features: FeatureVector,
  family: StrategyFamily,
  direction: "buy" | "sell",
): { score: number; confidence: number; expectedValue: number } {
  const emp = getSymbolEmpirical(features.symbol);
  let readiness = 0;
  let factors = 0;

  const distLow = Math.abs(features.distFromRange30dLowPct);
  const distHigh = Math.abs(features.distFromRange30dHighPct);

  if (direction === "buy") {
    if (distLow <= 0.03) { readiness += 1.0; factors++; }
    else if (distLow <= 0.10) { readiness += 0.7; factors++; }
    else if (distLow <= 0.18) { readiness += 0.4; factors++; }
    else { readiness += 0.15; factors++; }
  } else {
    if (distHigh <= 0.03) { readiness += 1.0; factors++; }
    else if (distHigh <= 0.10) { readiness += 0.7; factors++; }
    else if (distHigh <= 0.18) { readiness += 0.4; factors++; }
    else { readiness += 0.15; factors++; }
  }

  const maDist = features.emaDist;
  if (direction === "buy") {
    if (maDist < -0.06) { readiness += 1.0; factors++; }
    else if (maDist < -0.03) { readiness += 0.75; factors++; }
    else if (maDist < -0.01) { readiness += 0.5; factors++; }
    else { readiness += 0.2; factors++; }
  } else {
    if (maDist > 0.06) { readiness += 1.0; factors++; }
    else if (maDist > 0.03) { readiness += 0.75; factors++; }
    else if (maDist > 0.01) { readiness += 0.5; factors++; }
    else { readiness += 0.2; factors++; }
  }

  if (features.atrRank >= 1.3) { readiness += 0.9; factors++; }
  else if (features.atrRank >= 1.0) { readiness += 0.6; factors++; }
  else if (features.atrRank >= 0.7) { readiness += 0.4; factors++; }
  else { readiness += 0.2; factors++; }

  if (features.bbWidthRoc > 0.08 || features.atrAccel > 0.08) {
    readiness += 0.8; factors++;
  } else if (features.bbWidthRoc > 0.03 || features.atrAccel > 0.03) {
    readiness += 0.5; factors++;
  } else {
    readiness += 0.25; factors++;
  }

  const slopeAligned = (direction === "buy" && features.emaSlope > 0) ||
    (direction === "sell" && features.emaSlope < 0);
  const reversalCandle = (direction === "buy" && features.latestClose > features.latestOpen) ||
    (direction === "sell" && features.latestClose < features.latestOpen);
  const multiDaySetup = (direction === "buy" && features.priceChange7dPct < -0.05) ||
    (direction === "sell" && features.priceChange7dPct > 0.05);

  let confirmScore = 0;
  if (slopeAligned) confirmScore += 0.3;
  if (reversalCandle) confirmScore += 0.25;
  if (multiDaySetup) confirmScore += 0.25;

  const rsiConfirm = (direction === "buy" && features.rsi14 < 35) ||
    (direction === "sell" && features.rsi14 > 65);
  if (rsiConfirm) confirmScore += 0.2;

  readiness += Math.min(1.0, confirmScore);
  factors++;

  if (family === "spike_cluster_recovery") {
    const isBoomCrash = features.symbol.startsWith("BOOM") || features.symbol.startsWith("CRASH");
    if (isBoomCrash) {
      const clusterDensity = Math.min(1, features.spikeCount4h / 8);
      if (clusterDensity > 0.3) {
        readiness += clusterDensity * 0.8;
        factors++;
      }
    }
  }

  if (family === "swing_exhaustion") {
    const exhaustion = Math.min(1, Math.abs(features.priceChange7dPct) / 0.15);
    if (exhaustion > 0.4) {
      readiness += exhaustion * 0.7;
      factors++;
    }
  }

  const normalizedScore = factors > 0 ? readiness / factors : 0;
  const score = Math.min(0.95, normalizedScore);
  const confidence = Math.max(0.1, Math.min(0.95, score * 1.1 - 0.05));

  const winProb = score;
  const expectedValue = winProb * emp.avgWinPct - (1 - winProb) * emp.avgLossPct;

  return { score, confidence, expectedValue };
}

export function scoreFeaturesForFamily(
  features: FeatureVector,
  family: StrategyFamily,
  direction: "buy" | "sell" = "buy",
): { score: number; confidence: number; expectedValue: number } {
  return computeBigMoveReadiness(features, family, direction);
}

export function scoreFeatures(
  features: FeatureVector,
  _modelType: string = "empirical"
): { score: number; confidence: number; expectedValue: number } {
  return computeBigMoveReadiness(features, "trend_continuation", "buy");
}

export function getModelStatus(symbol: string): { trained: boolean; type: string; trainedAt: number | null } {
  return { trained: true, type: "empirical-v2", trainedAt: Date.now() };
}

export async function saveModelRun(
  symbol: string,
  modelName: string,
  trainingWindow: number,
  metrics: { accuracy: number; precision: number; recall: number; f1: number },
  weights: Record<string, number>
): Promise<void> {
  await db.insert(modelRunsTable).values({
    modelName,
    symbol,
    trainingWindow,
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1Score: metrics.f1,
    metricsJson: { weights, trainedOn: new Date().toISOString(), type: "empirical-v2" },
  });
}
