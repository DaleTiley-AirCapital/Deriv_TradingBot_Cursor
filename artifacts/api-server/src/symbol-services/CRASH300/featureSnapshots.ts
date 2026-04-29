import type { CandleRow } from "../../core/backtest/featureSlice.js";
import type { PromotedSymbolRuntimeModel } from "../../core/calibration/promotedSymbolModel.js";
import { buildCrash300ContextSnapshot } from "./context.js";
import { buildCrash300TriggerSnapshot } from "./trigger.js";

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct)));
  return sorted[idx] ?? 0;
}

function summarize(values: number[]) {
  if (values.length === 0) {
    return { min: 0, median: 0, mean: 0, p75: 0, p90: 0 };
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    min: Math.min(...values),
    median: percentile(values, 0.5),
    mean: sum / values.length,
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
  };
}

export function buildCrash300PreMoveSnapshots(params: {
  symbol: string;
  runtimeModel: PromotedSymbolRuntimeModel;
  candles: CandleRow[];
  moveStartTs: number;
  moveMetadata: Record<string, unknown>;
  selectedRuntimeFamily?: string | null;
  selectedBucket?: string | null;
}) {
  const contextOffsets = [-240, -120, -60, -30, -15, -5, -1, 0];
  const triggerOffsets = [-5, -3, -2, -1, 0, 1, 3, 5];
  const byCloseTs = new Map<number, number>();
  params.candles.forEach((candle, index) => byCloseTs.set(candle.closeTs, index));
  const moveIndex = params.candles.findIndex((candle) => candle.closeTs >= params.moveStartTs);
  if (moveIndex < 0) {
    throw new Error(`CRASH300 pre-move snapshot missing candles for move ${String(params.moveMetadata["moveId"] ?? "unknown")}`);
  }

  const contextSnapshots = contextOffsets.map((offset) => {
    const index = Math.max(0, Math.min(params.candles.length - 1, moveIndex + offset));
    const slice = params.candles.slice(0, index + 1);
    const built = buildCrash300ContextSnapshot({
      symbol: params.symbol,
      ts: params.candles[index]?.closeTs ?? params.moveStartTs,
      candles: slice,
      runtimeModel: params.runtimeModel,
    });
    return { offsetBars: offset, ...built.snapshot };
  });

  const triggerSnapshots = triggerOffsets.map((offset) => {
    const index = Math.max(0, Math.min(params.candles.length - 1, moveIndex + offset));
    const slice = params.candles.slice(0, index + 1);
    const built = buildCrash300ContextSnapshot({
      symbol: params.symbol,
      ts: params.candles[index]?.closeTs ?? params.moveStartTs,
      candles: slice,
      runtimeModel: params.runtimeModel,
    });
    const trigger = buildCrash300TriggerSnapshot({
      symbol: params.symbol,
      ts: params.candles[index]?.closeTs ?? params.moveStartTs,
      candles: slice,
      context: built.snapshot,
    });
    return { offsetBars: offset, ...trigger };
  });

  return {
    moveId: params.moveMetadata["moveId"] ?? null,
    direction: params.moveMetadata["direction"] ?? null,
    moveType: params.moveMetadata["moveType"] ?? null,
    movePct: params.moveMetadata["movePct"] ?? null,
    qualityTier: params.moveMetadata["qualityTier"] ?? null,
    leadInShape: params.moveMetadata["leadInShape"] ?? null,
    leadInBars: params.moveMetadata["leadInBars"] ?? null,
    rangeExpansion: params.moveMetadata["rangeExpansion"] ?? null,
    directionalPersistence: params.moveMetadata["directionalPersistence"] ?? null,
    startTs: params.moveMetadata["startTs"] ?? params.moveStartTs,
    endTs: params.moveMetadata["endTs"] ?? null,
    holdingMinutes: params.moveMetadata["holdingMinutes"] ?? null,
    selectedRuntimeFamily: params.selectedRuntimeFamily ?? null,
    selectedBucket: params.selectedBucket ?? null,
    contextSnapshots,
    triggerSnapshots,
  };
}

export function summarizeCrash300PreMoveSnapshots(
  rows: Array<Record<string, unknown>>,
) {
  const groups: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of rows) {
    const direction = String(row["direction"] ?? "unknown");
    const family = String(row["selectedRuntimeFamily"] ?? "unknown");
    const bucket = String(row["selectedBucket"] ?? "unknown");
    const tier = String(row["qualityTier"] ?? "unknown");
    const movePct = Number(row["movePct"] ?? 0);
    const sizeBucket = movePct < 6 ? "5-6%" : movePct < 8 ? "6-8%" : movePct < 10 ? "8-10%" : "10%+";
    for (const key of [
      `direction:${direction}`,
      `runtimeFamily:${family}`,
      `selectedBucket:${bucket}`,
      `qualityTier:${tier}`,
      `moveSize:${sizeBucket}`,
    ]) {
      groups[key] ??= [];
      groups[key].push(row);
    }
  }

  const metrics = [
    "trendPersistenceScore",
    "recoveryQualityScore",
    "compressionToExpansionScore",
    "crashRecencyScore",
    "barsSinceLastCrash",
    "priceDistanceFromLastCrashLowPct",
    "recoveryFromLastCrashPct",
    "triggerStrengthScore",
    "oneBarReturnPct",
    "threeBarReturnPct",
    "fiveBarReturnPct",
    "candleBodyPct",
    "closeLocationInRangePct",
  ];

  const out: Record<string, unknown> = {};
  for (const [groupKey, entries] of Object.entries(groups)) {
    const metricSummary: Record<string, unknown> = {};
    for (const metric of metrics) {
      const values = entries
        .map((entry) => Number(entry[metric] ?? NaN))
        .filter((value) => Number.isFinite(value));
      metricSummary[metric] = summarize(values);
    }
    out[groupKey] = {
      count: entries.length,
      metrics: metricSummary,
    };
  }
  return out;
}
