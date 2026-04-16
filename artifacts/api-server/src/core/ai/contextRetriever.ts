/**
 * contextRetriever.ts — Embedding-based Context Retrieval Layer
 *
 * Provides vector-similarity context retrieval for all AI research calls.
 * Uses text-embedding-3-large to embed chunks and cosine similarity to find
 * the top-k most relevant chunks for a given query.
 *
 * RESEARCH ONLY — must never be called from the live trading loop.
 *
 * Exports:
 *   embedText()              — generate embedding for a text string
 *   upsertChunk()            — embed + store/update a chunk (idempotent by sourceId)
 *   retrieveContext()        — embed query → cosine similarity → formatted string
 *   indexRepoContext()       — index key repo modules (engine logic, calibration)
 *   indexSchemaContext()     — index DB schema definitions
 *   indexStrategyContext()   — index strategy definitions & philosophy
 *   indexCalibrationContext()— index latest calibration profile outputs
 */

import { db, aiContextEmbeddingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOpenAIClient } from "../../infrastructure/openai.js";
import { EMBEDDING_MODEL, MAX_RETRIEVAL_CHARS } from "./aiConfig.js";

// ── Embedding ─────────────────────────────────────────────────────────────────

export async function embedText(text: string): Promise<number[]> {
  const client = await getOpenAIClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8_000),
  });
  return response.data[0]?.embedding ?? [];
}

// ── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Token budget guard ────────────────────────────────────────────────────────

export function truncateToTokenBudget(text: string, maxChars = MAX_RETRIEVAL_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[...context truncated to stay within token budget]";
}

// ── Upsert chunk ──────────────────────────────────────────────────────────────

export async function upsertChunk(opts: {
  sourceType: "code" | "schema" | "strategy" | "calibration" | "data_summary";
  sourceId: string;
  contentText: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { sourceType, sourceId, contentText, metadata } = opts;
  const embedding = await embedText(contentText);

  await db
    .insert(aiContextEmbeddingsTable)
    .values({
      sourceType,
      sourceId,
      contentText,
      embeddingVector: embedding,
      metadataJson: metadata ?? {},
    })
    .onConflictDoUpdate({
      target: aiContextEmbeddingsTable.sourceId,
      set: {
        contentText,
        embeddingVector: embedding,
        metadataJson: metadata ?? {},
        createdAt: new Date(),
      },
    });
}

// ── Retrieve context ──────────────────────────────────────────────────────────

export async function retrieveContext(
  query: string,
  topK = 6,
): Promise<string> {
  const allRows = await db.select({
    sourceId:    aiContextEmbeddingsTable.sourceId,
    sourceType:  aiContextEmbeddingsTable.sourceType,
    contentText: aiContextEmbeddingsTable.contentText,
    embedding:   aiContextEmbeddingsTable.embeddingVector,
  }).from(aiContextEmbeddingsTable);

  if (allRows.length === 0) return "";

  const queryEmbedding = await embedText(query);

  const scored = allRows.map(row => ({
    sourceId:    row.sourceId,
    sourceType:  row.sourceType,
    contentText: row.contentText,
    score:       cosineSimilarity(queryEmbedding, row.embedding as number[]),
  })).sort((a, b) => b.score - a.score).slice(0, topK);

  const sourceTypes = [...new Set(scored.map(r => r.sourceType))].join(", ");
  console.log(
    `[Retrieval] Query: "${query.slice(0, 80)}..." → ${scored.length} chunks (${sourceTypes}) top-score=${scored[0]?.score.toFixed(3) ?? "N/A"}`,
    `\nPreview: ${scored[0]?.contentText.slice(0, 200) ?? ""}`,
  );

  const chunks = scored.map((r, i) =>
    `### Context ${i + 1} [${r.sourceType}/${r.sourceId}]\n${r.contentText}`,
  ).join("\n\n");

  return truncateToTokenBudget(chunks);
}

// ── Ingestion: Repo Code ──────────────────────────────────────────────────────

export async function indexRepoContext(): Promise<number> {
  const chunks: Array<{ id: string; text: string; meta: Record<string, unknown> }> = [];

  chunks.push({
    id: "repo:platform-overview",
    text: `# Deriv Trading — Long Hold V3 Platform Overview

Active trading symbols: CRASH300, BOOM300, R_75, R_100.
Data-only symbols (no live trades): CRASH500, CRASH600, BOOM500, BOOM600, BOOM900, BOOM1000, CRASH900, CRASH1000.

Instrument families:
- Boom indices: price spikes upward (1-in-300 tick) → SELL after swing high/spike cluster exhaustion
- Crash indices: price drops periodically → BUY after swing low/spike cluster exhaustion
- Volatility indices (R_75, R_100): continuous random walk → BUY or SELL with trend/reversal signals

Trading philosophy: LARGE CAPITAL, LONG HOLD, MAX PROFIT.
TP targets 50-200%+ full spike magnitude moves. NEVER scalp.
Scoring gates: Paper≥60, Demo≥65, Real≥70.
Expected ~8-9 swing trades/month across 4 active symbols.
Average hold: 3-44 days. No time-based forced exits.`,
    meta: { type: "overview" },
  });

  chunks.push({
    id: "repo:engine-registry",
    text: `# Engine Registry — Active Engines per Symbol

BOOM300 engines:
- boom_expansion_engine: SELL direction, lead-in: trending/expanding
- boom_reversal_engine: BUY direction after multi-spike exhaustion

CRASH300 engines:
- crash_expansion_engine: BUY direction, lead-in: trending/expanding
- crash_reversal_engine: SELL direction after multi-spike rally exhaustion

R_75 engines:
- r75_reversal_engine: both directions, lead-in: ranging/trending
- r75_continuation_engine: both directions, lead-in: trending
- r75_breakout_engine: both directions, lead-in: compressing

R_100 engines:
- r100_reversal_engine: both directions, lead-in: ranging/trending
- r100_continuation_engine: both directions, lead-in: trending
- r100_breakout_engine: both directions, lead-in: compressing

Engine coverage rule: engine fires if qualityTier=A or B AND lead-in shape matches.`,
    meta: { type: "engines" },
  });

  chunks.push({
    id: "repo:trade-management",
    text: `# V3 Trade Management Rules

Take-Profit (TP) — PRIMARY exit:
- Boom/Crash: 50% of 90-day price range (min 10% of entry price). Targets full spike travel.
- Volatility: entry ± 70% of major swing range (from 1500+ candle structural levels).
- NEVER scalp 1-5% moves. TP is always 50-200%+.

Stop-Loss (SL):
- SL distance = TP distance / 5 (1:5 R:R ratio)
- Safety cap: max 10% equity per position

Trailing Stop (SAFETY NET ONLY):
- Activates ONLY after trade reaches 30% of TP target
- Tracks peak unrealized profit, exits when profit drops 30% from peak
- TP is the primary exit — trailing is a safety net

Position sizing:
- Size = equity × equity_pct_per_trade × clamp(confidence, 0.5, 1.0)
- Max 2 positions per symbol (different strategy families)
- Max 3 simultaneous open trades

No time-based exits. Trades hold until TP, SL, or trailing stop.`,
    meta: { type: "trade_management" },
  });

  chunks.push({
    id: "repo:calibration-passes",
    text: `# Move Calibration — 4-Pass AI Pipeline

Pass 1 (Precursor): Analyzes 48-96 bars BEFORE a detected move to identify consistent
precursor conditions. Determines engine coverage (would current engines have fired?).
Output: move_precursor_passes table.

Pass 2 (Trigger): Analyzes first 48 bars OF the move to find the earliest valid entry.
Reports slippage from move start and capturable fraction of total move.
Output: move_behavior_passes (pass_name="trigger").

Pass 3 (Behavior): Profiles internal move behavior — smooth vs choppy, holdability score.
Computes MFE/MAE. Holdability measures survivability for a long-hold system.
Output: move_behavior_passes (pass_name="behavior").

Pass 4 (Extraction): Runs once per symbol after passes 1-3. Extracts structural IF-THEN rules,
engine gaps, scoring calibration, hold duration guidance, honest fit summary.
Output: strategy_calibration_profiles table.

Key metric: Honest fit score = capturedMoves / targetMoves (a move is "captured" only if
precursor fired AND trigger ran AND captureablePct > 0).`,
    meta: { type: "calibration" },
  });

  chunks.push({
    id: "repo:signal-pipeline",
    text: `# Signal Pipeline — How Trades Are Born

1. Tick Streaming: live price ticks from Deriv WebSocket
2. Feature Extraction: 40+ technical features from 1500+ candle structural window
3. Regime Classification (cached hourly): trend_up, trend_down, mean_reversion, ranging,
   compression, breakout_expansion, spike_zone, or no_trade
4. Strategy Evaluation: only matching strategies run per regime
5. Big Move Readiness score (0-100): Range Position (25%), MA Deviation (20%),
   Volatility Profile (20%), Range Expansion (15%), Directional Confirmation (20%)
6. Composite Threshold: readiness score ≥ min_composite_score, EV ≥ 0.001, R:R ≥ 1.5
7. AI Verification (research signal check, optional)
8. Portfolio Allocation: daily/weekly loss limits, max drawdown, max open trades
9. Position Sizing: equity × equity_pct_per_trade × confidence
10. Execution: S/R+Fib TP/SL computed, trade opened`,
    meta: { type: "signal_pipeline" },
  });

  let count = 0;
  for (const chunk of chunks) {
    await upsertChunk({
      sourceType: "code",
      sourceId: chunk.id,
      contentText: chunk.text,
      metadata: chunk.meta,
    });
    count++;
  }
  return count;
}

// ── Ingestion: DB Schema ──────────────────────────────────────────────────────

export async function indexSchemaContext(): Promise<number> {
  const chunks: Array<{ id: string; text: string }> = [];

  chunks.push({
    id: "schema:core-tables",
    text: `# Database Schema — Core Tables

candles: id, symbol, timeframe, open_ts, close_ts, open, high, low, close, tick_count, is_interpolated, created_at
  - Stores 1m and 5m OHLC candles for all symbols
  - is_interpolated=true rows are synthetic fills (excluded from AI analysis)
  - ~200k-300k rows per symbol

trades: id, broker_trade_id, symbol, strategy_name, side, entry_ts, exit_ts, entry_price, exit_price,
  sl, tp, size, pnl, status(open|closed), mode(paper|demo|real), notes, confidence, trailing_stop_pct,
  peak_price, max_exit_ts, exit_reason, current_price, trade_stage(1-3), mfe_pct, mae_pct

platform_state: id, key, value, updated_at
  - Key-value store for all settings: paper_capital, demo_capital, real_capital, min_composite_score, etc.
  - AI suggestions stored as ai_suggest_<key>

signal_log: id, symbol, strategy_name, direction, composite_score, ev, rr, status, rejection_reason,
  mode, created_at`,
  });

  chunks.push({
    id: "schema:calibration-tables",
    text: `# Database Schema — Calibration Tables

detected_moves: id, symbol, direction(up|down), move_type(reversal|continuation|breakout),
  start_ts, end_ts, start_price, end_price, move_pct, holding_minutes, quality_tier(A|B|C|D),
  quality_score(0-100), lead_in_shape(ranging|trending|expanding|compressing),
  spike_count_4h, directional_persistence, range_expansion, context_json

move_precursor_passes: id, move_id, symbol, direction, move_type, engine_matched,
  engine_would_fire, precursor_conditions(jsonb array), missed_reason, lead_in_summary,
  confidence_score, raw_ai_response, pass_run_id

move_behavior_passes: id, move_id, symbol, direction, pass_name(trigger|behavior),
  earliest_entry_ts, earliest_entry_price, entry_slippage, capturable_pct,
  max_favorable_pct, max_adverse_pct, bars_to_mfe_peak, behavior_pattern,
  exit_narrative, holdability_score, trigger_conditions, raw_ai_response, pass_run_id

strategy_calibration_profiles: id, symbol, move_type(all|reversal|continuation|breakout),
  window_days, target_moves, captured_moves, missed_moves, fit_score, miss_reasons,
  avg_move_pct, median_move_pct, avg_holding_hours, avg_capturable_pct,
  avg_holdability_score, engine_coverage, precursor_summary, trigger_summary,
  feeddown_schema, profitability_summary, generated_at

calibration_pass_runs: id, symbol, window_days, status, pass_name, total_moves,
  processed_moves, failed_moves, error_summary, meta_json, started_at, completed_at

ai_context_embeddings: id, source_type, source_id, content_text, embedding_vector(jsonb array),
  metadata_json, created_at`,
  });

  chunks.push({
    id: "schema:backtest-tables",
    text: `# Database Schema — Backtest Tables

backtest_runs: id, strategy_name, symbol, initial_capital, total_return, net_profit, win_rate,
  profit_factor, max_drawdown, trade_count, avg_holding_hours, expectancy, sharpe_ratio,
  config_json, metrics_json, status, created_at

backtest_trades: id, backtest_run_id, entry_ts, exit_ts, direction, entry_price, exit_price,
  pnl, exit_reason

behavior_events: id, symbol, strategy_name, direction, ts, event_type, price, context_json, created_at`,
  });

  let count = 0;
  for (const chunk of chunks) {
    await upsertChunk({
      sourceType: "schema",
      sourceId: chunk.id,
      contentText: chunk.text,
    });
    count++;
  }
  return count;
}

// ── Ingestion: Strategy Definitions ─────────────────────────────────────────

export async function indexStrategyContext(): Promise<number> {
  const chunks: Array<{ id: string; text: string }> = [];

  chunks.push({
    id: "strategy:boom300",
    text: `# BOOM300 Strategy Logic

Instrument: BOOM300 — price spikes UPWARD (1-in-300 tick probability).
Between spikes, price drifts DOWN.

Primary trade: SELL after swing high / spike cluster exhaustion.
Secondary trade: BUY during drift-down phases (less common).

Key setup — Spike Cluster Recovery (HIGHEST CONVICTION for BOOM):
- 3+ boom spikes in 4h OR 5+ in 24h → price exhausted upward
- Reversal candle (red body, >50% of range) confirms exhaustion
- SELL for 23-62% move lasting 2-24 days
- This appears at EVERY major swing high in 6 months of BOOM300 data

Swing Exhaustion setup (BOOM BUY — counter-trend):
- 14+ boom spikes in 7d + price DOWN 8%+ in 7d + near 30d low + momentum fade
- BUY for rally up after exhaustion

Engine: boom_expansion_engine (SELL, lead-in: trending/expanding)
Score gate: Paper≥60, Demo≥65, Real≥70`,
  });

  chunks.push({
    id: "strategy:crash300",
    text: `# CRASH300 Strategy Logic

Instrument: CRASH300 — price crashes DOWN (1-in-300 tick probability).
Between crashes, price drifts UP.

Primary trade: BUY after swing low / spike cluster exhaustion.
Secondary trade: SELL during drift-up phases (less common).

Key setup — Spike Cluster Recovery (HIGHEST CONVICTION for CRASH):
- 3+ crash spikes in 4h OR 5+ in 24h → price exhausted downward
- Reversal candle (green body, >50% of range) confirms exhaustion
- BUY for 25-176% move lasting 4-44 days
- This appears at EVERY major swing low in 6 months of CRASH300 data

Swing Exhaustion setup (CRASH SELL — counter-trend):
- 14+ crash spikes in 7d + price UP 8%+ in 7d + near 30d high + momentum fade
- SELL for cascade down after exhaustion

Engine: crash_expansion_engine (BUY, lead-in: trending/expanding)
Score gate: Paper≥60, Demo≥65, Real≥70`,
  });

  chunks.push({
    id: "strategy:r75-r100",
    text: `# R_75 and R_100 Strategy Logic

Instruments: R_75, R_100 — continuous random walk (Volatility indices).
No spike-specific behavior. Pure price action and technicals.

R_75: avg swing ~22% over 8 days, ~3 swings/month
R_100: bigger moves 18-92% over 3-27 days, ~2 swings/month

Primary setups:
1. Mean Reversion at Extremes:
   - Price at 30d range extreme (<3% from low or >-3% from high)
   - Directional reversal confirmation
   - Trade opposite the recent multi-day direction

2. Trend Continuation:
   - Confirmed reversal with EMA slope alignment (>0.0003 or <-0.0003)
   - Pullback to EMA (|emaDist| < 0.01), RSI 35-65
   - Continue in trend direction

3. Breakout:
   - 2+ trendline touches, price breaking above/below with ATR+momentum
   - Close beyond pre-move range

Engines: r75_reversal_engine, r75_continuation_engine, r75_breakout_engine
         r100_reversal_engine, r100_continuation_engine, r100_breakout_engine
Score gate: Paper≥60, Demo≥65, Real≥70`,
  });

  chunks.push({
    id: "strategy:families",
    text: `# Strategy Families (All Symbols)

1. Trend Continuation (minModelScore: 0.60)
   When: EMA slope confirmed, price pulled back near EMA, RSI 35-70, 24h price confirms direction
   Regime: trend_up, trend_down, breakout_expansion

2. Mean Reversion (minModelScore: 0.60)
   When: Price near 30d range extremes, multi-day decline/rally (7d change >5%), RSI extreme, liquidity sweep
   Regime: mean_reversion, ranging

3. Spike Cluster Recovery (minModelScore: 0.58)
   When: 3+ spikes in 4h OR 5+ in 24h, 5%+ 24h exhaustion move, reversal candle, slope flattening
   Regime: spike_zone, mean_reversion, ranging, compression
   Boom/Crash ONLY — not for volatility indices

4. Swing Exhaustion (minModelScore: 0.58)
   When: 14+ spikes in 7d with 8%+ price move near 30d extremes, failed new high/low in 24h
   Regime: trend_up, trend_down, mean_reversion, spike_zone, breakout_expansion

5. Trendline Breakout (minModelScore: 0.65)
   When: 2+ trendline touches, breaking above resistance or below support with momentum
   Regime: compression, ranging, breakout_expansion, trend_up, trend_down`,
  });

  let count = 0;
  for (const chunk of chunks) {
    await upsertChunk({
      sourceType: "strategy",
      sourceId: chunk.id,
      contentText: chunk.text,
    });
    count++;
  }
  return count;
}

// ── Ingestion: Calibration Outputs ───────────────────────────────────────────

export async function indexCalibrationContext(): Promise<number> {
  let count = 0;
  try {
    const { strategyCalibrationProfilesTable } = await import("@workspace/db");
    const profiles = await db.select().from(strategyCalibrationProfilesTable);

    for (const p of profiles) {
      const feeddown = p.feeddownSchema as Record<string, unknown> | null;
      const profitability = p.profitabilitySummary as Record<string, unknown> | null;

      const text = `# Calibration Profile: ${p.symbol} (moveType=${p.moveType})
Generated: ${p.generatedAt?.toISOString() ?? "unknown"} | Window: ${p.windowDays}d

Honest Fit: ${p.capturedMoves}/${p.targetMoves} moves captured (${(p.fitScore * 100).toFixed(1)}%)
Missed: ${p.missedMoves} | Miss reasons: ${JSON.stringify(p.missReasons ?? []).slice(0, 200)}

Move stats: avg ${p.avgMovePct?.toFixed(1)}% | median ${p.medianMovePct?.toFixed(1)}% | avg hold ${p.avgHoldingHours?.toFixed(1)}h
Holdability: ${p.avgHoldabilityScore?.toFixed(2) ?? "N/A"} | Capturable: ${((p.avgCaptureablePct ?? 0) * 100).toFixed(1)}%

${feeddown?.overallFitNarrative ? `Fit narrative: ${feeddown.overallFitNarrative}` : ""}
${feeddown?.topImprovementOpportunity ? `Top opportunity: ${feeddown.topImprovementOpportunity}` : ""}
${profitability ? `Top extraction path: ${(profitability as { topPath?: string }).topPath ?? "N/A"}` : ""}`;

      await upsertChunk({
        sourceType: "calibration",
        sourceId: `calibration:${p.symbol}:${p.moveType}`,
        contentText: text.slice(0, 4000),
        metadata: { symbol: p.symbol, moveType: p.moveType },
      });
      count++;
    }
  } catch (err) {
    console.warn("[ContextRetriever] calibration indexing skipped:", err instanceof Error ? err.message : err);
  }
  return count;
}
