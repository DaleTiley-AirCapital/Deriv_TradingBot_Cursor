import OpenAI from "openai";
import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createDecipheriv, scryptSync } from "crypto";

const ENC_KEY_SOURCE = process.env["DATABASE_URL"] || process.env["ENCRYPTION_SECRET"];
if (!ENC_KEY_SOURCE) {
  throw new Error("DATABASE_URL or ENCRYPTION_SECRET required for secret decryption.");
}
const ENC_DERIVED_KEY = scryptSync(ENC_KEY_SOURCE, "deriv-quant-salt", 32);

function decryptStoredSecret(stored: string): string {
  if (!stored.startsWith("enc:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;
  const iv = Buffer.from(parts[1], "hex");
  const decipher = createDecipheriv("aes-256-cbc", ENC_DERIVED_KEY, iv);
  let decrypted = decipher.update(parts[2], "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function getOpenAIKey(): Promise<string | null> {
  try {
    const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "openai_api_key"));
    const raw = rows[0]?.value || null;
    if (!raw) return null;
    return decryptStoredSecret(raw);
  } catch {
    return null;
  }
}

export async function getOpenAIClient(): Promise<OpenAI> {
  const key = await getOpenAIKey();
  if (!key) throw new Error("OpenAI API key not configured — set it in Settings");
  return new OpenAI({ apiKey: key });
}

export async function checkOpenAiHealth(): Promise<{ configured: boolean; working: boolean; error?: string }> {
  try {
    const key = await getOpenAIKey();
    if (!key) return { configured: false, working: false };

    const client = new OpenAI({ apiKey: key });
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Reply with OK" }],
      max_tokens: 5,
    });
    const ok = !!response.choices[0]?.message?.content;
    return { configured: true, working: ok };
  } catch (err) {
    return { configured: true, working: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export interface SignalContext {
  symbol: string;
  direction: string;
  mode: string;
  confidence: number;
  score: number;
  strategyName: string;
  strategyFamily: string;
  reason: string;
  rsi14: number;
  atr14: number;
  ema20: number;
  bbWidth: number;
  zScore: number;
  recentCandles: string;
  recentWinLoss: string;
  regimeState: string;
  regimeConfidence: number;
  instrumentFamily: string;
  macroBiasModifier?: number;
  compositeScore: number;
  expectedValue: number;
  swingHigh?: number;
  swingLow?: number;
  fibRetraceLevels?: number[];
  fibExtensionLevels?: number[];
  fibExtensionLevelsDown?: number[];
  latestClose?: number;
}

export interface AIVerdict {
  verdict: "agree" | "disagree" | "uncertain";
  confidenceAdjustment: number;
  reasoning: string;
}

export async function verifySignal(ctx: SignalContext): Promise<AIVerdict> {
  const client = await getOpenAIClient();

  const prompt = `You are a quantitative trading AI for a LOW-FREQUENCY, HIGH-PROBABILITY capital extraction system on Deriv synthetic indices.

This system trades RARELY and holds for HOURS/DAYS targeting 50-200%+ moves. Only approve signals with genuine multi-day breakout edge. NEVER approve scalp setups or weak signals.

ACTIVE TRADING SYMBOLS: CRASH300, BOOM300, R_75, R_100 only.
CRITICAL DIRECTIONALITY: CRASH indices → BUY after swing low exhaustion. BOOM indices → SELL after swing high exhaustion. Verify direction matches instrument family.

CONTEXT:
- Strategy Family: ${ctx.strategyFamily}
- Sub-strategy: ${ctx.strategyName}
- Instrument: ${ctx.symbol} (${ctx.instrumentFamily} family)
- Direction: ${ctx.direction}
- Trading Mode: ${ctx.mode}

REGIME:
- Current Regime: ${ctx.regimeState} (confidence: ${(ctx.regimeConfidence * 100).toFixed(0)}%)
- Regime Gate: Active (strategy must match regime permissions)

SCORES:
- Composite Score: ${ctx.compositeScore.toFixed(0)}/100
- Required gate for ${ctx.mode} mode: >=${ctx.mode === "paper" ? 60 : ctx.mode === "demo" ? 65 : 70}
- Gate result: ${ctx.compositeScore >= (ctx.mode === "paper" ? 60 : ctx.mode === "demo" ? 65 : 70) ? "PASS — score meets the active mode gate" : "FAIL — score does not meet the active mode gate"}
- Model Score: ${(ctx.score * 100).toFixed(1)}%
- Confidence: ${(ctx.confidence * 100).toFixed(1)}%
- Expected Value: ${(ctx.expectedValue * 100).toFixed(3)}%

TRADE MANAGEMENT (V2 Spike-Magnitude-Aware TP/SL):
- Latest Close: ${ctx.latestClose?.toFixed(4) ?? "N/A"}
- Swing High: ${ctx.swingHigh?.toFixed(4) ?? "N/A"}
- Swing Low: ${ctx.swingLow?.toFixed(4) ?? "N/A"}
- Fib Retrace Levels: ${ctx.fibRetraceLevels?.map(l => l.toFixed(4)).join(", ") ?? "N/A"}
- Fib Extensions (up): ${ctx.fibExtensionLevels?.map(l => l.toFixed(4)).join(", ") ?? "N/A"}
- Fib Extensions (down): ${ctx.fibExtensionLevelsDown?.map(l => l.toFixed(4)).join(", ") ?? "N/A"}
- TP: PRIMARY exit targeting 50-200%+ moves. Boom/Crash: 50% of 90-day range (min 10%). Vol: 70% major swing range.
- SL: TP distance / 5 (1:5 R:R). Safety cap: 10% equity max loss.
- Trailing: 30% peak-profit drawdown (SAFETY NET ONLY, activates after reaching 30% of TP target)
- NO time-based exits. Trades hold until TP, SL, or trailing stop.

TECHNICAL INDICATORS:
- RSI(14): ${ctx.rsi14.toFixed(2)}
- ATR(14): ${ctx.atr14.toFixed(6)}
- EMA(20): ${ctx.ema20.toFixed(4)}
- BB Width: ${ctx.bbWidth.toFixed(6)}
- Z-Score: ${ctx.zScore.toFixed(3)}

SCORE GATE RULE (CRITICAL — READ BEFORE EVALUATING):
The system has already verified that this signal's composite score meets the ${ctx.mode} mode gate (>=${ctx.mode === "paper" ? 60 : ctx.mode === "demo" ? 65 : 70}).
You MUST NOT re-apply any paper/demo/real score threshold in your evaluation.
You MUST NOT disagree solely because the score is below another mode's gate (e.g., demo or real) when this is a ${ctx.mode} trade.
You MUST NOT reference other mode thresholds in your reasoning.
Your job is ONLY to evaluate signal quality and setup validity — NOT to gate-check the score again.

STRICT EVALUATION CRITERIA — DISAGREE only if the setup itself is invalid:
1. Direction does not match instrument family (CRASH=BUY, BOOM=SELL, Vol=either with trend confirmation)
2. Setup is intraday noise — no genuine multi-day structural pattern
3. Price is not at a genuine exhaustion/reversal point with structural confluence
4. Insufficient room for 50%+ move to TP target
5. Recent candles show choppy noise, not a genuine reversal/continuation pattern

${ctx.strategyFamily === "trend_continuation" ? "TREND CONTINUATION CHECK:\n- Is EMA slope strong and sustained (not just a blip)?\n- Has price pulled back to EMA without breaking structure?\n- Is 24h price change confirming trend direction (>1%)?\n- Is there room for continuation to major swing target?" : ""}${ctx.strategyFamily === "mean_reversion" ? "MEAN REVERSION CHECK:\n- Is price genuinely at 30d range extreme (within 3%)?\n- Has there been a sustained multi-day move (7d change >5%)?\n- Are RSI and z-score at genuine extremes?\n- Is liquidity sweep confirmed (if applicable)?" : ""}${ctx.strategyFamily === "spike_cluster_recovery" ? "SPIKE CLUSTER RECOVERY CHECK:\n- Is spike cluster dense enough (3+ in 4h window)?\n- Has 24h exhaustion move exceeded 5%?\n- Is reversal candle genuine (not just a pause)?\n- Is EMA slope flattening/reversing?" : ""}${ctx.strategyFamily === "swing_exhaustion" ? "SWING EXHAUSTION CHECK:\n- Has multi-day move exceeded 8% in 7 days?\n- Is price within 5% of 30d range extreme?\n- Has 24h momentum failed (no new high/low)?\n- Is EMA slope turning against the prior trend?" : ""}${ctx.strategyFamily === "trendline_breakout" ? "TRENDLINE BREAKOUT CHECK:\n- Does the trendline have 2+ confirmed touches?\n- Is breakout distance within 2.5x ATR (not too extended)?\n- Is momentum confirmed (candle body >30%, ATR accelerating)?\n- Is EMA slope aligned with breakout direction?" : ""}

REASON: ${ctx.reason}

Recent Candles: ${ctx.recentCandles}
Recent Trades: ${ctx.recentWinLoss}

Respond with ONLY valid JSON:
{
  "verdict": "agree" | "disagree" | "uncertain",
  "confidenceAdjustment": <number between -20 and +10>,
  "reasoning": "<1-2 sentence explanation. If disagreeing, state which specific criterion failed.>"
}`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 300,
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty response from OpenAI");

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in OpenAI response");

  const parsed = JSON.parse(jsonMatch[0]);
  const verdict = parsed.verdict;
  if (!["agree", "disagree", "uncertain"].includes(verdict)) {
    throw new Error(`Invalid verdict: ${verdict}`);
  }

  return {
    verdict,
    confidenceAdjustment: Math.max(-20, Math.min(10, Number(parsed.confidenceAdjustment) || 0)),
    reasoning: String(parsed.reasoning || "No reasoning provided."),
  };
}

export interface BacktestMetrics {
  id: number;
  strategyName: string;
  symbol: string;
  initialCapital: number;
  totalReturn: number;
  netProfit: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  tradeCount: number;
  avgHoldingHours: number;
  expectancy: number;
  sharpeRatio: number;
}

export interface BacktestAnalysis {
  summary: string;
  whatWorked: string;
  whatDidNot: string;
  suggestions: string[];
}

export async function analyseBacktest(metrics: BacktestMetrics): Promise<BacktestAnalysis> {
  const client = await getOpenAIClient();

  const prompt = `You are a quantitative finance analyst reviewing a backtest for a LOW-FREQUENCY capital extraction system (V2) on Deriv synthetic indices.

V2 TRADE MANAGEMENT CONTEXT:
- TP is the PRIMARY exit targeting full spike magnitude (50-200%+ moves). Trailing stop is SAFETY NET ONLY.
- Boom/Crash TP: 50% of 90-day price range (min 10% of entry price). Boom/Crash SL: 5% of 90-day range (min 2%).
- Volatility TP: 70% of major swing range (multi-day structural levels). Volatility SL: nearest structural S/R confluence with 0.3% buffer.
- No ATR-based TP/SL ever. All exits from market structure + spike magnitude analysis.
- Trailing stop: 30% drawdown from peak unrealized profit (activates only in-profit, SAFETY NET ONLY)
- NO time-based exits. Trades hold 9-44 days until TP, SL, or trailing stop closes them.
- Position sizing: equity_pct_per_trade * confidence (single entry, no probe/confirmation stages)
- Expect ~5-30 trades per multi-month backtest (long hold, few trades). NOT hundreds of trades.

Backtest Results:
- Strategy: ${metrics.strategyName}
- Instrument: ${metrics.symbol}
- Initial Capital: $${metrics.initialCapital.toFixed(2)}
- Net Profit: $${metrics.netProfit.toFixed(2)}
- Total Return: ${(metrics.totalReturn * 100).toFixed(2)}%
- Win Rate: ${(metrics.winRate * 100).toFixed(1)}%
- Profit Factor: ${metrics.profitFactor.toFixed(2)}
- Max Drawdown: ${(metrics.maxDrawdown * 100).toFixed(2)}%
- Trade Count: ${metrics.tradeCount}
- Avg Holding Time: ${metrics.avgHoldingHours.toFixed(1)} hours
- Expectancy per Trade: $${metrics.expectancy.toFixed(2)}
- Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}

Evaluate against the V2 framework above. Consider whether S/R confluence TP placement, trailing stop behavior, and time-exit handling are producing expected results.

Respond with ONLY valid JSON:
{
  "summary": "<2-3 sentence overall assessment>",
  "whatWorked": "<1-2 sentences on strengths>",
  "whatDidNot": "<1-2 sentences on weaknesses>",
  "suggestions": [
    "<specific parameter suggestion 1>",
    "<specific parameter suggestion 2>",
    "<specific parameter suggestion 3>"
  ]
}`;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
      temperature: 0.4,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) throw new Error("Empty response from OpenAI");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in OpenAI response");

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: String(parsed.summary || ""),
      whatWorked: String(parsed.whatWorked || ""),
      whatDidNot: String(parsed.whatDidNot || ""),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String).slice(0, 3) : [],
    };
  } catch (err) {
    console.error("[OpenAI] Backtest analysis failed:", err instanceof Error ? err.message : err);
    throw err;
  }
}

export async function isOpenAIConfigured(): Promise<boolean> {
  const key = await getOpenAIKey();
  return !!key;
}
