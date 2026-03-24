import { db, platformStateTable, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { TradingMode } from "./deriv.js";
import { getModeCapitalKey, getModeCapitalDefault } from "./deriv.js";

export interface ExtractionCycle {
  mode: TradingMode;
  startCapital: number;
  currentCapital: number;
  targetCapital: number;
  extractionTarget: number;
  extractionReady: boolean;
  cycleNumber: number;
  profitSinceReset: number;
  profitPct: number;
}

export interface PeakTracker {
  tradeId: number;
  peakPnlPct: number;
  currentPnlPct: number;
  drawdownFromPeak: number;
  shouldHarvest: boolean;
  harvestReason: string | null;
}

const DEFAULT_EXTRACTION_TARGET_PCT = 50;
const DEFAULT_PEAK_DRAWDOWN_EXIT_PCT = 40;
const DEFAULT_PARTIAL_CLOSE_PCT = 50;

export async function getExtractionCycle(mode: TradingMode): Promise<ExtractionCycle> {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const prefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
  const capitalKey = getModeCapitalKey(mode);
  const capitalDefault = getModeCapitalDefault(mode);

  const startCapital = parseFloat(stateMap[`${prefix}_extraction_start_capital`] || stateMap[capitalKey] || capitalDefault);
  const currentCapital = parseFloat(stateMap[capitalKey] || capitalDefault);
  const extractionTargetPct = parseFloat(stateMap[`${prefix}_extraction_target_pct`] || stateMap["extraction_target_pct"] || String(DEFAULT_EXTRACTION_TARGET_PCT));
  const cycleNumber = parseInt(stateMap[`${prefix}_extraction_cycle`] || "1");

  const targetCapital = startCapital * (1 + extractionTargetPct / 100);
  const extractionTarget = targetCapital - startCapital;
  const profitSinceReset = currentCapital - startCapital;
  const profitPct = startCapital > 0 ? (profitSinceReset / startCapital) * 100 : 0;
  const extractionReady = currentCapital >= targetCapital;

  return {
    mode,
    startCapital,
    currentCapital,
    targetCapital,
    extractionTarget,
    extractionReady,
    cycleNumber,
    profitSinceReset,
    profitPct,
  };
}

export async function executeExtraction(mode: TradingMode): Promise<{
  extracted: number;
  newCapital: number;
  cycleNumber: number;
} | null> {
  const cycle = await getExtractionCycle(mode);
  if (!cycle.extractionReady) return null;

  const extractAmount = cycle.currentCapital - cycle.startCapital;
  const newCapital = cycle.startCapital;
  const newCycle = cycle.cycleNumber + 1;

  const prefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
  const capitalKey = getModeCapitalKey(mode);

  const updates: Record<string, string> = {
    [capitalKey]: String(newCapital),
    [`${prefix}_extraction_start_capital`]: String(newCapital),
    [`${prefix}_extraction_cycle`]: String(newCycle),
    [`${prefix}_last_extraction_at`]: new Date().toISOString(),
    [`${prefix}_last_extraction_amount`]: String(extractAmount),
    [`${prefix}_total_extracted`]: String(
      parseFloat((await getStateValue(`${prefix}_total_extracted`)) || "0") + extractAmount
    ),
  };

  for (const [key, value] of Object.entries(updates)) {
    await db.insert(platformStateTable).values({ key, value })
      .onConflictDoUpdate({ target: platformStateTable.key, set: { value, updatedAt: new Date() } });
  }

  console.log(`[ExtractionEngine] Extracted $${extractAmount.toFixed(2)} from ${mode.toUpperCase()} | Reset to $${newCapital.toFixed(2)} | Cycle #${newCycle}`);

  return { extracted: extractAmount, newCapital, cycleNumber: newCycle };
}

export function evaluateProfitHarvest(params: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  direction: "buy" | "sell";
  tradeId: number;
  peakDrawdownExitPct?: number;
  minPeakProfitPct?: number;
  largePeakThresholdPct?: number;
}): PeakTracker {
  const {
    entryPrice, currentPrice, peakPrice, direction, tradeId,
    peakDrawdownExitPct = DEFAULT_PEAK_DRAWDOWN_EXIT_PCT,
    minPeakProfitPct = 8.0,
    largePeakThresholdPct = 15.0,
  } = params;

  const currentPnlPct = direction === "buy"
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;

  const peakPnlPct = direction === "buy"
    ? ((peakPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - peakPrice) / entryPrice) * 100;

  const drawdownFromPeak = peakPnlPct > 0
    ? ((peakPnlPct - currentPnlPct) / peakPnlPct) * 100
    : 0;

  let shouldHarvest = false;
  let harvestReason: string | null = null;

  if (peakPnlPct >= minPeakProfitPct && drawdownFromPeak >= peakDrawdownExitPct) {
    shouldHarvest = true;
    harvestReason = `Peak profit ${peakPnlPct.toFixed(1)}% → drawdown ${drawdownFromPeak.toFixed(1)}% exceeds ${peakDrawdownExitPct}% threshold`;
  }

  if (peakPnlPct >= largePeakThresholdPct && drawdownFromPeak >= peakDrawdownExitPct * 0.6) {
    shouldHarvest = true;
    harvestReason = `Large peak ${peakPnlPct.toFixed(1)}% with ${drawdownFromPeak.toFixed(1)}% drawdown — harvesting`;
  }

  return {
    tradeId,
    peakPnlPct,
    currentPnlPct,
    drawdownFromPeak,
    shouldHarvest,
    harvestReason,
  };
}

export async function getHarvestSettings(mode: TradingMode): Promise<{
  peakDrawdownExitPct: number;
  minPeakProfitPct: number;
  largePeakThresholdPct: number;
}> {
  const prefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  return {
    peakDrawdownExitPct: parseFloat(stateMap[`${prefix}_peak_drawdown_exit_pct`] || stateMap["peak_drawdown_exit_pct"] || String(DEFAULT_PEAK_DRAWDOWN_EXIT_PCT)),
    minPeakProfitPct: parseFloat(stateMap[`${prefix}_min_peak_profit_pct`] || stateMap["min_peak_profit_pct"] || "8"),
    largePeakThresholdPct: parseFloat(stateMap[`${prefix}_large_peak_threshold_pct`] || stateMap["large_peak_threshold_pct"] || "15"),
  };
}

export function determineEntryStage(
  openTradesOnSymbol: number,
  compositeScore: number,
  thresholds?: { probe: number; confirmation: number; momentum: number },
): "probe" | "confirmation" | "momentum" | null {
  const t = thresholds || { probe: 88, confirmation: 91, momentum: 94 };
  if (openTradesOnSymbol === 0) {
    return compositeScore >= t.probe ? "probe" : null;
  }
  if (openTradesOnSymbol === 1) {
    return compositeScore >= t.confirmation ? "confirmation" : null;
  }
  if (openTradesOnSymbol === 2) {
    return compositeScore >= t.momentum ? "momentum" : null;
  }
  return null;
}

export function getEntrySizeMultiplier(
  stage: "probe" | "confirmation" | "momentum",
  multipliers?: { probe: number; confirmation: number; momentum: number },
): number {
  const m = multipliers || { probe: 0.70, confirmation: 0.60, momentum: 0.50 };
  return m[stage];
}

async function getStateValue(key: string): Promise<string | null> {
  const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, key));
  return rows[0]?.value ?? null;
}

export async function checkAndAutoExtract(mode: TradingMode): Promise<void> {
  const states = await db.select().from(platformStateTable);
  const stateMap: Record<string, string> = {};
  for (const s of states) stateMap[s.key] = s.value;

  const prefix = mode === "paper" ? "paper" : mode === "demo" ? "demo" : "real";
  const autoExtract = stateMap[`${prefix}_auto_extraction`] || stateMap["auto_extraction"];
  if (autoExtract !== "true") return;

  const cycle = await getExtractionCycle(mode);
  if (cycle.extractionReady) {
    console.log(`[ExtractionEngine] Auto-extraction triggered for ${mode.toUpperCase()}`);
    await executeExtraction(mode);
  }
}
