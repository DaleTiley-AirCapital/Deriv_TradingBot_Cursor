import { db, featuresTable, modelRunsTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import type { FeatureVector } from "./features.js";
import type { StrategyFamily } from "./regimeEngine.js";

interface ModelWeights {
  intercept: number;
  emaSlope: number;
  rsi14: number;
  atr14: number;
  bbWidth: number;
  zScore: number;
  spikeHazard: number;
  consecutive: number;
  bbPctB: number;
}

const modelStore: Record<string, { weights: ModelWeights; type: string; trainedAt: number }> = {};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function dot(features: number[], weights: number[]): number {
  return features.reduce((sum, f, i) => sum + f * (weights[i] || 0), 0);
}

const FAMILY_WEIGHTS: Record<StrategyFamily, ModelWeights> = {
  trend_continuation: {
    intercept: -0.15,
    emaSlope: 3.5,
    rsi14: 1.0,
    atr14: -0.3,
    bbWidth: -0.5,
    zScore: -0.5,
    spikeHazard: 0.3,
    consecutive: 0.5,
    bbPctB: 0.4,
  },
  mean_reversion: {
    intercept: 0.1,
    emaSlope: -1.5,
    rsi14: -2.5,
    atr14: 0.5,
    bbWidth: 0.8,
    zScore: -2.0,
    spikeHazard: 0.2,
    consecutive: -1.0,
    bbPctB: -1.5,
  },
  breakout_expansion: {
    intercept: -0.2,
    emaSlope: 1.0,
    rsi14: 0.5,
    atr14: 2.0,
    bbWidth: -2.5,
    zScore: 0.5,
    spikeHazard: 0.3,
    consecutive: 0.3,
    bbPctB: 1.5,
  },
  spike_event: {
    intercept: -0.1,
    emaSlope: 0.3,
    rsi14: 0.2,
    atr14: 0.5,
    bbWidth: -0.3,
    zScore: 0.3,
    spikeHazard: 4.0,
    consecutive: 0.2,
    bbPctB: 0.1,
  },
  trendline_breakout: {
    intercept: -0.15,
    emaSlope: 1.5,
    rsi14: 0.3,
    atr14: 1.5,
    bbWidth: -1.5,
    zScore: 0.5,
    spikeHazard: 0.2,
    consecutive: 0.4,
    bbPctB: 1.2,
  },
};

const FAMILY_RULE_CONFIGS: Record<StrategyFamily, {
  trendWeight: number;
  rsiWeight: number;
  bbWeight: number;
  spikeWeight: number;
  meanRevWeight: number;
  atrWeight: number;
}> = {
  trend_continuation: {
    trendWeight: 0.30,
    rsiWeight: 0.10,
    bbWeight: 0.05,
    spikeWeight: 0.05,
    meanRevWeight: 0.05,
    atrWeight: 0.10,
  },
  mean_reversion: {
    trendWeight: 0.05,
    rsiWeight: 0.30,
    bbWeight: 0.10,
    spikeWeight: 0.05,
    meanRevWeight: 0.25,
    atrWeight: 0.05,
  },
  breakout_expansion: {
    trendWeight: 0.10,
    rsiWeight: 0.05,
    bbWeight: 0.30,
    spikeWeight: 0.05,
    meanRevWeight: 0.05,
    atrWeight: 0.25,
  },
  spike_event: {
    trendWeight: 0.05,
    rsiWeight: 0.05,
    bbWeight: 0.05,
    spikeWeight: 0.50,
    meanRevWeight: 0.05,
    atrWeight: 0.10,
  },
  trendline_breakout: {
    trendWeight: 0.15,
    rsiWeight: 0.05,
    bbWeight: 0.20,
    spikeWeight: 0.05,
    meanRevWeight: 0.05,
    atrWeight: 0.30,
  },
};

function getFamilyWeights(family: StrategyFamily, symbol: string): ModelWeights {
  const trained = modelStore[`${family}:${symbol}`] ?? modelStore[symbol];
  if (trained) return trained.weights;

  const baseWeights = { ...FAMILY_WEIGHTS[family] };
  const isBoom = symbol.startsWith("BOOM");

  if (family === "trend_continuation") {
    baseWeights.emaSlope = isBoom ? baseWeights.emaSlope : -baseWeights.emaSlope;
    baseWeights.consecutive = isBoom ? 0.5 : -0.5;
  } else if (family === "mean_reversion") {
    baseWeights.zScore = isBoom ? -2.0 : 2.0;
    baseWeights.rsi14 = isBoom ? -2.5 : 2.5;
  }

  return baseWeights;
}

function computeFamilyRuleScore(features: FeatureVector, family: StrategyFamily): number {
  const cfg = FAMILY_RULE_CONFIGS[family];
  let ruleScore = 0.5;
  let ruleWeight = 0;

  if (Math.abs(features.emaSlope) > 0.0005) {
    const aligned = family === "trend_continuation"
      ? (features.emaSlope > 0 ? 0.70 : 0.65)
      : (features.emaSlope > 0 ? 0.55 : 0.50);
    ruleScore += aligned * cfg.trendWeight;
    ruleWeight += cfg.trendWeight;
  }

  if (features.rsi14 < 30) {
    const revScore = family === "mean_reversion" ? 0.80 : 0.55;
    ruleScore += revScore * cfg.rsiWeight;
    ruleWeight += cfg.rsiWeight;
  } else if (features.rsi14 > 70) {
    const revScore = family === "mean_reversion" ? 0.80 : 0.45;
    ruleScore += revScore * cfg.rsiWeight;
    ruleWeight += cfg.rsiWeight;
  } else if (features.rsi14 > 45 && features.rsi14 < 60) {
    ruleScore += 0.55 * cfg.rsiWeight * 0.5;
    ruleWeight += cfg.rsiWeight * 0.5;
  }

  if (features.bbWidth < 0.005) {
    const bbScore = family === "breakout_expansion" ? 0.75 : 0.55;
    ruleScore += bbScore * cfg.bbWeight;
    ruleWeight += cfg.bbWeight;
  }

  ruleScore += features.spikeHazardScore * cfg.spikeWeight;
  ruleWeight += cfg.spikeWeight;

  if (Math.abs(features.zScore) > 2.0) {
    const revScore = features.zScore > 0 ? 0.35 : 0.65;
    const effectiveScore = family === "mean_reversion" ? (1 - revScore) * 0.3 + revScore * 0.7 : revScore;
    ruleScore += effectiveScore * cfg.meanRevWeight;
    ruleWeight += cfg.meanRevWeight;
  }

  if (features.atrAccel > 0.1) {
    const atrScore = family === "breakout_expansion" ? 0.75 : 0.55;
    ruleScore += atrScore * cfg.atrWeight;
    ruleWeight += cfg.atrWeight;
  }

  if (ruleWeight > 0) ruleScore = ruleScore / (1 + ruleWeight);
  return ruleScore;
}

export function scoreFeaturesForFamily(
  features: FeatureVector,
  family: StrategyFamily,
): { score: number; confidence: number; expectedValue: number } {
  const weights = getFamilyWeights(family, features.symbol);

  const featureVec = [
    features.emaSlope * 1000,
    (features.rsi14 - 50) / 50,
    features.atr14 * 100,
    features.bbWidth * 10,
    features.zScore,
    features.spikeHazardScore,
    features.consecutive / 5,
    features.bbPctB,
  ];

  const logitScore = sigmoid(
    weights.intercept +
    weights.emaSlope * featureVec[0] +
    weights.rsi14 * featureVec[1] +
    weights.atr14 * featureVec[2] +
    weights.bbWidth * featureVec[3] +
    weights.zScore * featureVec[4] +
    weights.spikeHazard * featureVec[5] +
    weights.consecutive * featureVec[6] +
    weights.bbPctB * featureVec[7]
  );

  const ruleScore = computeFamilyRuleScore(features, family);
  const ensembleScore = 0.55 * logitScore + 0.45 * ruleScore;
  const confidence = Math.abs(ensembleScore - 0.5) * 2;

  const avgWin = 0.025;
  const avgLoss = 0.015;
  const expectedValue = ensembleScore * avgWin - (1 - ensembleScore) * avgLoss;

  return { score: ensembleScore, confidence, expectedValue };
}

export function scoreFeatures(
  features: FeatureVector,
  modelType: "logistic-regression" | "gradient-boost" | "rule-based" = "gradient-boost"
): { score: number; confidence: number; expectedValue: number } {
  return scoreFeaturesForFamily(features, "trend_continuation");
}

export async function trainLogisticRegression(
  symbol: string,
  trainingWindowDays = 90
): Promise<{ accuracy: number; precision: number; recall: number; f1: number; weights: ModelWeights }> {
  const rows = await db.select().from(featuresTable)
    .where(and(
      eq(featuresTable.symbol, symbol),
      isNotNull(featuresTable.targetLabel)
    ));

  if (rows.length < 20) {
    return {
      accuracy: 0.5, precision: 0.5, recall: 0.5, f1: 0.5,
      weights: FAMILY_WEIGHTS.trend_continuation,
    };
  }

  const dataset = rows.map(row => {
    const f = row.featureJson as Record<string, number>;
    const label = parseInt(row.targetLabel || "0");
    return {
      features: [
        f.emaSlope * 1000,
        (f.rsi14 - 50) / 50,
        f.atr14 * 100,
        f.bbWidth * 10,
        f.zScore,
        0.5,
        0,
        0.5,
      ],
      label,
    };
  });

  const lr = 0.01;
  const epochs = 100;
  let weights = [0, 0, 0, 0, 0, 0, 0, 0];
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = dataset.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dataset[i], dataset[j]] = [dataset[j], dataset[i]];
    }
    for (const { features, label } of dataset) {
      const pred = sigmoid(dot(features, weights) + bias);
      const error = pred - label;
      weights = weights.map((w, i) => w - lr * error * features[i]);
      bias -= lr * error;
    }
  }

  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { features, label } of dataset) {
    const pred = sigmoid(dot(features, weights) + bias) > 0.5 ? 1 : 0;
    if (pred === 1 && label === 1) tp++;
    else if (pred === 1 && label === 0) fp++;
    else if (pred === 0 && label === 0) tn++;
    else fn++;
  }
  const accuracy = (tp + tn) / dataset.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  const modelWeights: ModelWeights = {
    intercept: bias,
    emaSlope: weights[0],
    rsi14: weights[1],
    atr14: weights[2],
    bbWidth: weights[3],
    zScore: weights[4],
    spikeHazard: weights[5],
    consecutive: weights[6],
    bbPctB: weights[7],
  };

  modelStore[symbol] = { weights: modelWeights, type: "logistic-regression", trainedAt: Date.now() };

  return { accuracy, precision, recall, f1, weights: modelWeights };
}

export function getModelStatus(symbol: string): { trained: boolean; type: string; trainedAt: number | null } {
  const m = modelStore[symbol];
  return m
    ? { trained: true, type: m.type, trainedAt: m.trainedAt }
    : { trained: false, type: "none", trainedAt: null };
}

export async function saveModelRun(
  symbol: string,
  modelName: string,
  trainingWindow: number,
  metrics: { accuracy: number; precision: number; recall: number; f1: number },
  weights: ModelWeights
): Promise<void> {
  await db.insert(modelRunsTable).values({
    modelName,
    symbol,
    trainingWindow,
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1Score: metrics.f1,
    metricsJson: { weights, trainedOn: new Date().toISOString() },
  });
}
