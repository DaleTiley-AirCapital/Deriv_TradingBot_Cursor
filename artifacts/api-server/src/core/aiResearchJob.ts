/**
 * AI Research Job — V3 Backend, Strategy-Aligned
 *
 * Provides structured AI analysis of stored market data per symbol.
 * NOT a live trade gate — research capability only.
 *
 * Governing philosophy (from .agents/skills/deriv-trading-strategy/SKILL.md):
 *   - Large capital, long hold, max profit
 *   - TP targets full spike magnitude: 50–200%+ moves
 *   - NEVER scalp; NEVER reduce TP targets
 *   - Only 4 active trading symbols: CRASH300, BOOM300, R_75, R_100
 *   - Strategy families: Trend Continuation, Mean Reversion,
 *     Spike Cluster Recovery, Swing Exhaustion, Trendline Breakout
 *   - Scoring thresholds: Paper≥60, Demo≥65, Real≥70 (current safe-mode gates)
 *   - Trade frequency: ~8-9 swing trades/month across all 4 symbols
 *   - Average hold: 3–44 days; no time-based forced exits
 *
 * All AI output is framed by the above philosophy.
 * The AI may discover new opportunities but must classify them clearly
 * and never default into scalp-first recommendations unless explicitly
 * classified as a separate short-hold family.
 *
 * Output is raw OHLC analysis. No AI labels are added to candle export.
 */
import { backgroundDb } from "@workspace/db";
import { candlesTable } from "@workspace/db";
import { eq, and, gte, asc, desc, min, max, count } from "drizzle-orm";
import { getOpenAIClient } from "../infrastructure/openai.js";
import { ACTIVE_TRADING_SYMBOLS } from "../infrastructure/deriv.js";
import { extractStrategies } from "./strategyExtractor.js";
import { PRIMARY_MODEL } from "./ai/aiConfig.js";
import { retrieveContext } from "./ai/contextRetriever.js";

const DEFAULT_WINDOW_DAYS = 365;
const MAX_CANDLES_FOR_ANALYSIS = 15_000;

export interface PriceSwing {
  direction: "up" | "down";
  startTs: number;
  endTs: number;
  startPrice: number;
  endPrice: number;
  movePct: number;
  holdingMinutes: number;
}

export interface StrategyOpportunity {
  name: string;
  family: string;
  direction: string;
  holdClass: "long" | "medium" | "short";
  avgMovePct: number;
  medianMovePct: number;
  avgHoldHours: number;
  tradesPerMonth: number;
  roughMonthlyProfitPct: number;
  winLossEstimate: string;
  walkForwardRuleSketch: string;
  precursors: string;
  earliestEntry: string;
  bestExitLogic: string;
  engineFit: "compatible" | "new_opportunity" | "contradicts_system";
  confidence: "high" | "medium" | "low";
  recentDrift: string;
}

export interface AiResearchReport {
  symbol: string;
  analysisWindowDays: number;
  dataFrom: string;
  dataTo: string;
  totalCandles1m: number;
  isActiveTradingSymbol: boolean;
  instrumentFamily: "BoomCrash" | "Volatility" | "Other";
  swingStats: {
    count: number;
    avgMovePct: number;
    medianMovePct: number;
    avgHoldingHours: number;
    upMoves: number;
    downMoves: number;
    swingsPerMonth: number;
    largeMoves: number;
    largeMoveThresholdPct: number;
  };
  longHoldOpportunities: StrategyOpportunity[];
  mediumHoldOpportunities: StrategyOpportunity[];
  shortHoldOpportunities: StrategyOpportunity[];
  engineAlignedOpportunities: StrategyOpportunity[];
  aiSummary: string;
  aiSystemAlignment: string;
  aiLongHoldAnalysis: string;
  aiMediumHoldAnalysis: string;
  aiSpikeClusterAnalysis: string;
  aiMoveFrequency: string;
  aiMoveSize: string;
  aiHoldDuration: string;
  aiUsefulTimeframes: string;
  aiRepeatableSetups: string;
  aiFiringFrequency: string;
  aiBehaviorDrift: string;
  aiPromisingAreas: string;
  aiDegradingAreas: string;
  aiNewOpportunities: string;
  aiRiskWarnings: string;
  aiRawText: string;
  generatedAt: string;
  windowDays: number;
}

export interface ResearchJobStatus {
  running: boolean;
  lastRun: Record<string, string>;
  lastResult: Record<string, AiResearchReport | null>;
}

const jobStatus: ResearchJobStatus = {
  running: false,
  lastRun: {},
  lastResult: {},
};

export function getResearchJobStatus(): ResearchJobStatus {
  return jobStatus;
}

/**
 * Extracts price swings from 1m candle data.
 * A swing is a sustained directional move above the minimum threshold.
 */
function extractSwings(
  candles: { openTs: number; open: number; close: number }[],
  minSwingPct = 0.02,
  minSwingCandles = 5,
): PriceSwing[] {
  if (candles.length < 10) return [];

  const swings: PriceSwing[] = [];

  let swingStart = 0;
  let swingDirection: "up" | "down" | null = null;
  let peakPrice = candles[0].close;

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;

    const dir: "up" | "down" = curr > prev ? "up" : "down";

    if (!swingDirection) {
      swingDirection = dir;
      peakPrice = curr;
      continue;
    }

    if (dir === swingDirection) {
      if (swingDirection === "up") peakPrice = Math.max(peakPrice, curr);
      else peakPrice = Math.min(peakPrice, curr);
      continue;
    }

    const swingPct = Math.abs((peakPrice - candles[swingStart].close) / candles[swingStart].close);
    const swingLen = i - swingStart;

    if (swingPct >= minSwingPct && swingLen >= minSwingCandles) {
      swings.push({
        direction: swingDirection,
        startTs:    candles[swingStart].openTs,
        endTs:      candles[i - 1].openTs,
        startPrice: candles[swingStart].close,
        endPrice:   peakPrice,
        movePct:    swingPct,
        holdingMinutes: (candles[i - 1].openTs - candles[swingStart].openTs) / 60,
      });
    }

    swingStart = i - 1;
    swingDirection = dir;
    peakPrice = curr;
  }

  return swings;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Classify hold duration.
 *   long   = > 24 hours average
 *   medium = 4–24 hours
 *   short  = < 4 hours
 */
function classifyHold(avgHoldHours: number): "long" | "medium" | "short" {
  if (avgHoldHours > 24) return "long";
  if (avgHoldHours >= 4) return "medium";
  return "short";
}

/**
 * Runs AI research analysis on stored candle data for a symbol.
 *
 * @param symbol     Trading symbol (e.g. "CRASH300")
 * @param windowDays Analysis window in days (default: 365)
 * @returns          Structured research report aligned to strategy philosophy
 */
export async function analyzeSymbol(
  symbol: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<AiResearchReport> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowDays * 86400;

  // Exclude interpolated (carry-forward) candles from all research analysis.
  // Interpolated rows are synthetic fills — not real market truth.
  const baseWhere = and(
    eq(candlesTable.symbol, symbol),
    eq(candlesTable.timeframe, "1m"),
    gte(candlesTable.openTs, cutoff),
    eq(candlesTable.isInterpolated, false),
  );

  const [summary] = await backgroundDb
    .select({ cnt: count(), first: min(candlesTable.openTs), last: max(candlesTable.openTs) })
    .from(candlesTable)
    .where(baseWhere);

  const totalCandles = Number(summary?.cnt ?? 0);
  const firstTs = summary?.first ?? cutoff;
  const lastTs  = summary?.last  ?? now;

  if (totalCandles < 100) {
    throw new Error(`[AIResearch] Insufficient data for ${symbol}: only ${totalCandles} real (non-interpolated) 1m candles in window`);
  }

  const actualWindowDays = Math.ceil((lastTs - firstTs) / 86400);

  // Sample candles for swing analysis
  let candles: { openTs: number; open: number; close: number }[];

  if (totalCandles <= MAX_CANDLES_FOR_ANALYSIS) {
    candles = await backgroundDb
      .select({ openTs: candlesTable.openTs, open: candlesTable.open, close: candlesTable.close })
      .from(candlesTable)
      .where(baseWhere)
      .orderBy(asc(candlesTable.openTs));
  } else {
    const step = Math.ceil(totalCandles / MAX_CANDLES_FOR_ANALYSIS);
    const all = await backgroundDb
      .select({ openTs: candlesTable.openTs, open: candlesTable.open, close: candlesTable.close })
      .from(candlesTable)
      .where(baseWhere)
      .orderBy(asc(candlesTable.openTs));
    candles = all.filter((_, i) => i % step === 0);
  }

  // Extract swings at different thresholds for multi-scale analysis
  const allSwings    = extractSwings(candles, 0.02, 5);   // 2%+ swings
  const medSwings    = extractSwings(candles, 0.10, 30);  // 10%+ medium swings
  const largeSwings  = extractSwings(candles, 0.30, 100); // 30%+ large swings (system targets)

  const upSwings    = allSwings.filter(s => s.direction === "up");
  const downSwings  = allSwings.filter(s => s.direction === "down");

  const allMovePcts  = allSwings.map(s => s.movePct * 100);
  const allHoldHours = allSwings.map(s => s.holdingMinutes / 60);
  const monthsInWindow = actualWindowDays / 30;
  const swingsPerMonth = monthsInWindow > 0 ? allSwings.length / monthsInWindow : 0;

  const swingStats = {
    count:               allSwings.length,
    avgMovePct:          allMovePcts.length ? allMovePcts.reduce((a, b) => a + b, 0) / allMovePcts.length : 0,
    medianMovePct:       median(allMovePcts),
    avgHoldingHours:     allHoldHours.length ? allHoldHours.reduce((a, b) => a + b, 0) / allHoldHours.length : 0,
    upMoves:             upSwings.length,
    downMoves:           downSwings.length,
    swingsPerMonth:      Math.round(swingsPerMonth * 10) / 10,
    largeMoves:          largeSwings.length,
    largeMoveThresholdPct: 30,
  };

  // Drift analysis: compare older vs recent
  const midpoint = firstTs + (lastTs - firstTs) / 2;
  const recentSwings = allSwings.filter(s => s.startTs >= midpoint);
  const olderSwings  = allSwings.filter(s => s.startTs < midpoint);
  const recentAvgMove = recentSwings.length ? recentSwings.reduce((s, x) => s + x.movePct, 0) / recentSwings.length : 0;
  const olderAvgMove  = olderSwings.length  ? olderSwings.reduce( (s, x) => s + x.movePct, 0) / olderSwings.length  : 0;
  const recentAvgHold = recentSwings.length ? recentSwings.reduce((s, x) => s + x.holdingMinutes / 60, 0) / recentSwings.length : 0;
  const olderAvgHold  = olderSwings.length  ? olderSwings.reduce( (s, x) => s + x.holdingMinutes / 60, 0) / olderSwings.length  : 0;

  // Large-swing (≥30%) analysis for system compatibility
  const largePcts  = largeSwings.map(s => s.movePct * 100);
  const largeHours = largeSwings.map(s => s.holdingMinutes / 60);
  const largeAvgPct  = largePcts.length  ? largePcts.reduce((a, b) => a + b, 0) / largePcts.length : 0;
  const largeAvgHours = largeHours.length ? largeHours.reduce((a, b) => a + b, 0) / largeHours.length : 0;
  const largeMedPct  = median(largePcts);
  const largePerMonth = monthsInWindow > 0 ? largeSwings.length / monthsInWindow : 0;

  // Medium swing (10–30%) analysis
  const medPcts  = medSwings.map(s => s.movePct * 100);
  const medHours = medSwings.map(s => s.holdingMinutes / 60);
  const medAvgPct   = medPcts.length  ? medPcts.reduce((a, b) => a + b, 0) / medPcts.length : 0;
  const medAvgHours = medHours.length ? medHours.reduce((a, b) => a + b, 0) / medHours.length : 0;

  // Run deterministic strategy extractor — quantitative truth BEFORE AI interpretation.
  // The AI will explain and validate this ranking, not invent its own from scratch.
  let deterministicRanking: Awaited<ReturnType<typeof extractStrategies>> | null = null;
  try {
    deterministicRanking = await extractStrategies(symbol, windowDays);
  } catch {
    // Non-fatal: AI proceeds without deterministic context if extractor fails
  }

  const topCandidates = deterministicRanking?.candidates.slice(0, 5) ?? [];
  const rankingContext = topCandidates.length > 0
    ? `
=== DETERMINISTIC STRATEGY RANKING (from real data — EXCLUDES interpolated candles) ===
Data: ${deterministicRanking!.dataFrom} → ${deterministicRanking!.dataTo} (${deterministicRanking!.monthsOfData} months)
Real candles used: ${deterministicRanking!.totalRealCandles.toLocaleString()} (interpolated excluded: ${deterministicRanking!.interpolatedCount})

Top-ranked strategies by expected monthly return (data-derived, not assumed):
${topCandidates.map((c, i) => `
Rank ${i + 1}: ${c.id} (${c.direction} | ≥${c.thresholdPct.toFixed(0)}% threshold | ${c.holdClass}-hold)
  Trades detected: ${c.tradeCount} | Trades/month: ${c.tradesPerMonth}
  Avg move: ${c.avgMovePct}% | Median: ${c.medianMovePct}% | P25: ${c.p25MovePct}% | P75: ${c.p75MovePct}%
  Avg hold: ${c.avgHoldHours}h | Win rate: ${(c.winRate * 100).toFixed(0)}%
  Expected monthly return: ${c.expectedMonthlyReturnPct}% | Consistency: ${(c.consistency * 100).toFixed(0)}%
  Description: ${c.description}
`).join("")}

CRITICAL TASK: Compare this data-derived ranking against your narrative analysis.
- If the top-ranked strategy is a SMALLER move than the 50-200% system mandate, explain WHY the data shows that.
- Do not dismiss smaller-but-repeatable opportunities — compute their monthly return vs large-but-rare ones.
- Identify whether the 30%+ long-hold strategy is optimal from a monthly return standpoint, or if medium holds are more capital efficient.
- Be explicit about any divergence between system philosophy and what the data shows.
`
    : "=== DETERMINISTIC RANKING: insufficient data for ranking ===\n";

  const isBoomCrash = symbol.startsWith("BOOM") || symbol.startsWith("CRASH");
  const isVolatility = symbol.startsWith("R_");
  const isActiveTradingSymbol = ACTIVE_TRADING_SYMBOLS.includes(symbol);

  const instrumentType = isBoomCrash
    ? "Boom/Crash synthetic index (spike-driven, mean-reverting between spikes)"
    : isVolatility
    ? "Volatility synthetic index (continuous random walk, mean-reverting over multi-day periods)"
    : "Research-only synthetic index";

  const instrumentFamily: "BoomCrash" | "Volatility" | "Other" = isBoomCrash ? "BoomCrash" : isVolatility ? "Volatility" : "Other";

  const spikeDirection = symbol.startsWith("CRASH") ? "DOWN" : symbol.startsWith("BOOM") ? "UP" : "N/A";
  const driftDirection = symbol.startsWith("CRASH") ? "UP (price drifts up between crash spikes)" : symbol.startsWith("BOOM") ? "DOWN (price drifts down between boom spikes)" : "random walk";
  const primaryTrade   = symbol.startsWith("CRASH") ? "BUY after spike cluster exhaustion at swing lows" : symbol.startsWith("BOOM") ? "SELL after spike cluster exhaustion at swing highs" : "BUY or SELL at range extremes with reversal confirmation";

  const strategicContext = isBoomCrash
    ? `
INSTRUMENT-SPECIFIC BEHAVIOR (Boom/Crash):
- Spike direction: ${spikeDirection} (1-in-300 chance per tick)
- Drift direction: ${driftDirection}
- Primary trade: ${primaryTrade}
- Key setup — Spike Cluster Recovery (HIGHEST CONVICTION):
    * CRASH: 3+ crash spikes in 4h OR 5+ in 24h → price exhausted downward → reversal candle (green) → BUY for 25–176% move lasting 4–44 days
    * BOOM: 3+ boom spikes in 4h OR 5+ in 24h → price exhausted upward → reversal candle (red) → SELL for 23–62% move lasting 2–24 days
    * This pattern appears at EVERY major swing low/high in 6 months of CRASH300/BOOM300 data
- Secondary setup — Swing Exhaustion:
    * CRASH SELL signal: 14+ crash spikes in 7d + price up 8%+ in 7d + near 30d high + momentum fade → price exhausted upward → cascade DOWN
    * BOOM BUY signal: 14+ boom spikes in 7d + price down 8%+ in 7d + near 30d low + momentum fade → price exhausted downward → rally UP
`
    : `
INSTRUMENT-SPECIFIC BEHAVIOR (Volatility):
- Behavior: Continuous random walk, mean-reverting over multi-day periods
- No spike-specific behavior — pure price action and technicals
- Primary trade: BUY or SELL based on trend/reversal signals at range extremes
- Key setup — Mean Reversion at Extremes:
    * Price at 30d range extreme (< 3% from low or > -3% from high) + directional reversal confirmation
    * R_75 average swing: ~22% over 8 days (~3 swings/month)
    * R_100 bigger moves but less frequent: 18–92% over 3–27 days (~2 swings/month)
- Secondary setup — Trend Continuation:
    * Confirmed reversal with EMA slope alignment (>0.0003 or <-0.0003)
    * Pullback to EMA (|emaDist| < 0.01), RSI 35–65
`;

  const prompt = `You are a quantitative trading analyst for a long-hold, large-capital trading system focused on Deriv synthetic indices.

=== GOVERNING STRATEGY PHILOSOPHY (NON-NEGOTIABLE) ===
- MANDATE: Large capital, long hold, max profit — swing trades on highest-probability signals ONLY
- TP targets: 50–200%+ full spike magnitude moves. NEVER scalp. NEVER suggest 1–10% micro-trades.
- Exit hierarchy: TP (primary) → SL (1:5 R:R from TP) → ATR trailing stop (activates at 30% of TP target)
- Active trading symbols: CRASH300, BOOM300, R_75, R_100 ONLY
- Expected trade frequency: ~8–9 swing trades/month across all 4 active symbols
- Average hold duration: 3–44 days. NO time-based forced exits.
- Scoring thresholds: Paper≥60, Demo≥65, Real≥70 (current safe-mode operating gates)

STRATEGY FAMILIES IN USE:
1. Trend Continuation — ride the new trend after confirmed swing reversal
2. Mean Reversion — trade at multi-day/week extremes showing exhaustion
3. Spike Cluster Recovery — highest-conviction Boom/Crash setup: reversal after spike cluster exhausts the move
4. Swing Exhaustion — fade a sustained multi-day move where momentum is fading
5. Trendline Breakout — breaking multi-touch S/R with momentum

AI RESEARCH MUST:
- Frame all analysis in long-hold context first
- Classify any short-hold opportunities explicitly as separate, lower-priority discoveries
- Never recommend reducing TP targets or shortening the hold philosophy
- Acknowledge when the data confirms or contradicts the system's established findings

=== INSTRUMENT DATA ===
SYMBOL: ${symbol} — ${instrumentType}
IS ACTIVE TRADING SYMBOL: ${isActiveTradingSymbol ? "YES (currently traded live)" : "NO (research/data collection only)"}
ANALYSIS WINDOW: ${actualWindowDays} days (${new Date(firstTs * 1000).toISOString().slice(0, 10)} → ${new Date(lastTs * 1000).toISOString().slice(0, 10)})
TOTAL 1-MINUTE CANDLES: ${totalCandles.toLocaleString()}

=== MULTI-SCALE SWING ANALYSIS ===
All swings (≥2% / ≥5 candles):
  Total: ${allSwings.length} swings | Up: ${upSwings.length} | Down: ${downSwings.length}
  Avg move: ${swingStats.avgMovePct.toFixed(1)}% | Median: ${swingStats.medianMovePct.toFixed(1)}%
  Avg hold: ${swingStats.avgHoldingHours.toFixed(1)} hours | Frequency: ${swingStats.swingsPerMonth}/month

Medium swings (≥10%):
  Count: ${medSwings.length} | Avg move: ${medAvgPct.toFixed(1)}% | Avg hold: ${medAvgHours.toFixed(1)} hours

Large swings (≥30% — SYSTEM TARGET RANGE):
  Count: ${largeSwings.length} | Avg move: ${largeAvgPct.toFixed(1)}% | Median: ${largeMedPct.toFixed(1)}%
  Avg hold: ${largeAvgHours.toFixed(1)} hours | Frequency: ${largePerMonth.toFixed(1)}/month
  
=== BEHAVIORAL DRIFT ===
Older half (${new Date(firstTs * 1000).toISOString().slice(0, 10)} → ${new Date(midpoint * 1000).toISOString().slice(0, 10)}):
  Swings: ${olderSwings.length} | Avg move: ${(olderAvgMove * 100).toFixed(1)}% | Avg hold: ${olderAvgHold.toFixed(1)}h

Recent half (${new Date(midpoint * 1000).toISOString().slice(0, 10)} → ${new Date(lastTs * 1000).toISOString().slice(0, 10)}):
  Swings: ${recentSwings.length} | Avg move: ${(recentAvgMove * 100).toFixed(1)}% | Avg hold: ${recentAvgHold.toFixed(1)}h

Move drift: ${((recentAvgMove - olderAvgMove) * 100).toFixed(1)}% change in avg move size
Frequency drift: ${(recentSwings.length - olderSwings.length > 0 ? "+" : "")}${recentSwings.length - olderSwings.length} swings in recent period
${strategicContext}
${rankingContext}
=== REQUIRED OUTPUT FORMAT ===
Respond ONLY with valid JSON (no markdown, no preamble). All string values must be non-empty.

{
  "summary": "<2-3 sentence overall assessment — start with whether this instrument is suitable for the long-hold system>",
  "systemAlignment": "<how well this instrument aligns with the long-hold 50-200%+ philosophy and current active engine set>",
  "longHoldAnalysis": "<analysis of 30%+ moves: frequency, average size, hold duration, predictability, entry patterns — are they exploitable with the system?>",
  "mediumHoldAnalysis": "<analysis of 10-30% moves: are they useful as medium-hold opportunities or should they be filtered out as too small?>",
  "spikeClusterAnalysis": "${isBoomCrash ? "analysis of spike cluster exhaustion patterns: how many detected in the window, typical cluster size before reversal, expected move after cluster, match to CRASH/BOOM primary setup" : "not applicable — volatility index; note mean reversion at range extremes instead"}",
  "opportunities": [
    {
      "name": "<descriptive strategy name>",
      "family": "<trend_continuation | mean_reversion | spike_cluster_recovery | swing_exhaustion | trendline_breakout | new_discovery>",
      "direction": "<BUY | SELL | BOTH>",
      "holdClass": "<long | medium | short>",
      "avgMovePct": <number>,
      "medianMovePct": <number>,
      "avgHoldHours": <number>,
      "tradesPerMonth": <number>,
      "roughMonthlyProfitPct": <number — estimated % gain on capital per month if strategy fires>,
      "winLossEstimate": "<estimated win rate and context>",
      "walkForwardRuleSketch": "<if-then entry rule sketch based on observed patterns>",
      "precursors": "<what conditions must exist before entry>",
      "earliestEntry": "<earliest safe entry signal>",
      "bestExitLogic": "<TP target range and trailing stop approach for this opportunity>",
      "engineFit": "<compatible | new_opportunity | contradicts_system>",
      "confidence": "<high | medium | low>",
      "recentDrift": "<has this pattern improved, degraded, or stayed stable recently?>"
    }
  ],
  "moveFrequency": "<how often significant tradeable moves occur>",
  "moveSize": "<typical move size vs the system TP targets of 50-200%+>",
  "holdDuration": "<how long moves last vs the 3-44 day system hold philosophy>",
  "usefulTimeframes": "<which timeframes appear most meaningful for this instrument>",
  "repeatableSetups": "<what appears repeatable or structural based on the data>",
  "firingFrequency": "<expected signal frequency — how often the system should fire on this instrument>",
  "behaviorDrift": "<whether recent behavior differs significantly from older — improving, degrading, or stable>",
  "promisingAreas": "<what looks promising or improving>",
  "degradingAreas": "<what looks degrading, less reliable, or risky>",
  "newOpportunities": "<any patterns discovered outside the current 5 strategy families — classify clearly and note whether they require system changes>",
  "riskWarnings": "<data quality issues, thinning move frequency, regime changes, or other risks the system operator should know>"
}`;

  let rawText = "";

  type ParsedOpportunity = {
    name: string;
    family: string;
    direction: string;
    holdClass: "long" | "medium" | "short";
    avgMovePct: number;
    medianMovePct: number;
    avgHoldHours: number;
    tradesPerMonth: number;
    roughMonthlyProfitPct: number;
    winLossEstimate: string;
    walkForwardRuleSketch: string;
    precursors: string;
    earliestEntry: string;
    bestExitLogic: string;
    engineFit: "compatible" | "new_opportunity" | "contradicts_system";
    confidence: "high" | "medium" | "low";
    recentDrift: string;
  };

  type ParsedResult = {
    summary: string;
    systemAlignment: string;
    longHoldAnalysis: string;
    mediumHoldAnalysis: string;
    spikeClusterAnalysis: string;
    opportunities: ParsedOpportunity[];
    moveFrequency: string;
    moveSize: string;
    holdDuration: string;
    usefulTimeframes: string;
    repeatableSetups: string;
    firingFrequency: string;
    behaviorDrift: string;
    promisingAreas: string;
    degradingAreas: string;
    newOpportunities: string;
    riskWarnings: string;
  };

  let parsed: ParsedResult;

  const retrievedCtx = await retrieveContext(
    `${symbol} ${isBoomCrash ? "boom crash spike cluster" : "volatility mean reversion"} strategy analysis swing moves`,
    5,
  ).catch(() => "");

  const enhancedPrompt = retrievedCtx
    ? `=== RETRIEVED SYSTEM CONTEXT ===\n${retrievedCtx}\n\n${prompt}`
    : prompt;

  try {
    const client = await getOpenAIClient();
    const response = await client.chat.completions.create({
      model: PRIMARY_MODEL,
      messages: [{ role: "user", content: enhancedPrompt }],
      max_tokens: 3000,
      temperature: 0.25,
    });

    rawText = response.choices[0]?.message?.content?.trim() ?? "";
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in OpenAI response");

    const p = JSON.parse(match[0]) as Partial<ParsedResult>;

    parsed = {
      summary:              String(p.summary             ?? ""),
      systemAlignment:      String(p.systemAlignment     ?? ""),
      longHoldAnalysis:     String(p.longHoldAnalysis    ?? ""),
      mediumHoldAnalysis:   String(p.mediumHoldAnalysis  ?? ""),
      spikeClusterAnalysis: String(p.spikeClusterAnalysis ?? ""),
      opportunities:        Array.isArray(p.opportunities) ? p.opportunities : [],
      moveFrequency:        String(p.moveFrequency       ?? ""),
      moveSize:             String(p.moveSize            ?? ""),
      holdDuration:         String(p.holdDuration        ?? ""),
      usefulTimeframes:     String(p.usefulTimeframes    ?? ""),
      repeatableSetups:     String(p.repeatableSetups    ?? ""),
      firingFrequency:      String(p.firingFrequency     ?? ""),
      behaviorDrift:        String(p.behaviorDrift       ?? ""),
      promisingAreas:       String(p.promisingAreas      ?? ""),
      degradingAreas:       String(p.degradingAreas      ?? ""),
      newOpportunities:     String(p.newOpportunities    ?? ""),
      riskWarnings:         String(p.riskWarnings        ?? ""),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[AIResearch] OpenAI analysis failed for ${symbol}: ${msg}`);
  }

  // Classify opportunities by hold class
  const toStratOpp = (o: ParsedOpportunity): StrategyOpportunity => ({
    name:                 String(o.name ?? ""),
    family:               String(o.family ?? ""),
    direction:            String(o.direction ?? ""),
    holdClass:            (["long","medium","short"].includes(o.holdClass) ? o.holdClass : classifyHold(Number(o.avgHoldHours ?? 0))) as "long" | "medium" | "short",
    avgMovePct:           Number(o.avgMovePct ?? 0),
    medianMovePct:        Number(o.medianMovePct ?? 0),
    avgHoldHours:         Number(o.avgHoldHours ?? 0),
    tradesPerMonth:       Number(o.tradesPerMonth ?? 0),
    roughMonthlyProfitPct: Number(o.roughMonthlyProfitPct ?? 0),
    winLossEstimate:      String(o.winLossEstimate ?? ""),
    walkForwardRuleSketch: String(o.walkForwardRuleSketch ?? ""),
    precursors:           String(o.precursors ?? ""),
    earliestEntry:        String(o.earliestEntry ?? ""),
    bestExitLogic:        String(o.bestExitLogic ?? ""),
    engineFit:            (["compatible","new_opportunity","contradicts_system"].includes(o.engineFit) ? o.engineFit : "new_opportunity") as "compatible" | "new_opportunity" | "contradicts_system",
    confidence:           (["high","medium","low"].includes(o.confidence) ? o.confidence : "medium") as "high" | "medium" | "low",
    recentDrift:          String(o.recentDrift ?? ""),
  });

  const opps = parsed.opportunities.map(toStratOpp);
  const longHoldOpps   = opps.filter(o => o.holdClass === "long");
  const mediumHoldOpps = opps.filter(o => o.holdClass === "medium");
  const shortHoldOpps  = opps.filter(o => o.holdClass === "short");
  const engineAligned  = opps.filter(o => o.engineFit === "compatible");

  return {
    symbol,
    analysisWindowDays:   actualWindowDays,
    dataFrom:             new Date(firstTs * 1000).toISOString(),
    dataTo:               new Date(lastTs  * 1000).toISOString(),
    totalCandles1m:       totalCandles,
    isActiveTradingSymbol,
    instrumentFamily,
    swingStats,
    longHoldOpportunities:   longHoldOpps,
    mediumHoldOpportunities: mediumHoldOpps,
    shortHoldOpportunities:  shortHoldOpps,
    engineAlignedOpportunities: engineAligned,
    aiSummary:            parsed.summary,
    aiSystemAlignment:    parsed.systemAlignment,
    aiLongHoldAnalysis:   parsed.longHoldAnalysis,
    aiMediumHoldAnalysis: parsed.mediumHoldAnalysis,
    aiSpikeClusterAnalysis: parsed.spikeClusterAnalysis,
    aiMoveFrequency:      parsed.moveFrequency,
    aiMoveSize:           parsed.moveSize,
    aiHoldDuration:       parsed.holdDuration,
    aiUsefulTimeframes:   parsed.usefulTimeframes,
    aiRepeatableSetups:   parsed.repeatableSetups,
    aiFiringFrequency:    parsed.firingFrequency,
    aiBehaviorDrift:      parsed.behaviorDrift,
    aiPromisingAreas:     parsed.promisingAreas,
    aiDegradingAreas:     parsed.degradingAreas,
    aiNewOpportunities:   parsed.newOpportunities,
    aiRiskWarnings:       parsed.riskWarnings,
    aiRawText:            rawText,
    generatedAt:          new Date().toISOString(),
    windowDays,
  };
}

/**
 * Background-compatible wrapper for analyzeSymbol.
 * Updates jobStatus so callers can poll for completion.
 * Non-blocking — fires and forgets.
 */
export function runResearchJobBackground(symbol: string, windowDays = DEFAULT_WINDOW_DAYS): void {
  if (jobStatus.running) {
    console.warn(`[AIResearch] Job already running — skipping ${symbol}`);
    return;
  }

  jobStatus.running = true;
  jobStatus.lastRun[symbol] = new Date().toISOString();

  analyzeSymbol(symbol, windowDays)
    .then(report => {
      jobStatus.lastResult[symbol] = report;
      console.log(`[AIResearch] ${symbol}: research job complete`);
    })
    .catch(err => {
      console.error(`[AIResearch] ${symbol}: research job failed —`, err instanceof Error ? err.message : err);
      jobStatus.lastResult[symbol] = null;
    })
    .finally(() => {
      jobStatus.running = false;
    });
}
