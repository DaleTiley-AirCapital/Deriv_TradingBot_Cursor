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

async function getOpenAIClient(): Promise<OpenAI> {
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
  macroBiasModifier: number;
  compositeScore: number;
  entryStage: string;
  expectedValue: number;
}

export interface AIVerdict {
  verdict: "agree" | "disagree" | "uncertain";
  confidenceAdjustment: number;
  reasoning: string;
}

export async function verifySignal(ctx: SignalContext): Promise<AIVerdict> {
  const client = await getOpenAIClient();

  const prompt = `You are a quantitative trading AI for a LOW-FREQUENCY, HIGH-PROBABILITY capital extraction system on Deriv synthetic indices.

This system trades RARELY and holds for HOURS/DAYS. Only approve signals with genuine edge.

CONTEXT:
- Strategy Family: ${ctx.strategyFamily}
- Sub-strategy: ${ctx.strategyName}
- Instrument: ${ctx.symbol} (${ctx.instrumentFamily} family)
- Direction: ${ctx.direction}
- Entry Stage: ${ctx.entryStage}

REGIME:
- Current Regime: ${ctx.regimeState} (confidence: ${(ctx.regimeConfidence * 100).toFixed(0)}%)
- Macro Bias Modifier: ${ctx.macroBiasModifier > 0 ? "+" : ""}${(ctx.macroBiasModifier * 100).toFixed(1)}%

SCORES:
- Composite Score: ${ctx.compositeScore.toFixed(0)}/100
- Model Score: ${(ctx.score * 100).toFixed(1)}%
- Confidence: ${(ctx.confidence * 100).toFixed(1)}%
- Expected Value: ${(ctx.expectedValue * 100).toFixed(3)}%

TECHNICAL INDICATORS:
- RSI(14): ${ctx.rsi14.toFixed(2)}
- ATR(14): ${ctx.atr14.toFixed(6)}
- EMA(20): ${ctx.ema20.toFixed(4)}
- BB Width: ${ctx.bbWidth.toFixed(6)}
- Z-Score: ${ctx.zScore.toFixed(3)}

STRATEGY-SPECIFIC EVALUATION:
${ctx.strategyFamily === "trend_continuation" ? "- Is the trend strong enough to justify a continuation entry?\n- Is pullback depth appropriate (not too deep/shallow)?\n- Does momentum support the trend?" : ""}${ctx.strategyFamily === "mean_reversion" ? "- Is the overstretch genuine (not a trend continuation)?\n- Are reversal signals present (rejection candles, volume)?\n- Is smart money sweep confirmed?" : ""}${ctx.strategyFamily === "breakout_expansion" ? "- Is compression sufficient for a meaningful breakout?\n- Is expansion confirmed (not a false breakout)?\n- Does volume/ATR support the move?" : ""}${ctx.strategyFamily === "spike_event" ? "- Is spike probability statistically elevated?\n- Is the position sizing appropriate for spike risk?\n- Is the hold duration reasonable for spike capture?" : ""}

REASON: ${ctx.reason}

Recent Candles: ${ctx.recentCandles}
Recent Trades: ${ctx.recentWinLoss}

Respond with ONLY valid JSON:
{
  "verdict": "agree" | "disagree" | "uncertain",
  "confidenceAdjustment": <number between -20 and +10>,
  "reasoning": "<1-2 sentence strategy-specific explanation>"
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

  const prompt = `You are a quantitative finance analyst reviewing a backtest for a LOW-FREQUENCY capital extraction system on Deriv synthetic indices.

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
