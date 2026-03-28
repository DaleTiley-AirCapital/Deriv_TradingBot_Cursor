import { Router, type IRouter } from "express";
import { db, platformStateTable, tradesTable, signalLogTable } from "@workspace/db";
import { eq, and, gte, desc } from "drizzle-orm";
import { createDecipheriv, scryptSync } from "crypto";
import OpenAI from "openai";

const router: IRouter = Router();

const ENC_KEY_SOURCE = process.env["DATABASE_URL"] || process.env["ENCRYPTION_SECRET"];
const ENC_DERIVED_KEY = ENC_KEY_SOURCE ? scryptSync(ENC_KEY_SOURCE, "deriv-quant-salt", 32) : null;

function decryptStoredSecret(stored: string): string {
  if (!stored.startsWith("enc:") || !ENC_DERIVED_KEY) return stored;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored;
  const iv = Buffer.from(parts[1], "hex");
  const decipher = createDecipheriv("aes-256-cbc", ENC_DERIVED_KEY, iv);
  let decrypted = decipher.update(parts[2], "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function getOpenAIClient(): Promise<OpenAI> {
  const rows = await db.select().from(platformStateTable).where(eq(platformStateTable.key, "openai_api_key"));
  const raw = rows[0]?.value || null;
  if (!raw) throw new Error("OpenAI API key not configured");
  return new OpenAI({ apiKey: decryptStoredSecret(raw) });
}

async function getCurrentSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(platformStateTable);
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (!r.key.includes("api_key") && !r.key.includes("api_token")) {
      map[r.key] = r.value;
    }
  }
  return map;
}

const MODE_PREFIXES = ["paper", "demo", "real"];
const FAMILIES = ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event", "trendline_breakout"];
const PER_MODE_KEYS = [
  "capital", "equity_pct_per_trade", "max_open_trades", "allocation_mode",
  "max_daily_loss_pct", "max_weekly_loss_pct", "max_drawdown_pct",
  "extraction_target_pct", "auto_extraction",
  "correlated_family_cap",
];
const WRITABLE_SETTINGS = [
  "min_composite_score", "min_ev_threshold", "min_rr_ratio",
  "scoring_weight_regime_fit", "scoring_weight_setup_quality",
  "scoring_weight_trend_alignment", "scoring_weight_volatility_condition",
  "scoring_weight_reward_risk", "scoring_weight_probability_of_success",
  "scan_interval_seconds", "scan_stagger_seconds",
  "ai_verification_enabled", "kill_switch",
  "paper_mode_active", "demo_mode_active", "real_mode_active",
  ...MODE_PREFIXES.flatMap(m => PER_MODE_KEYS.map(k => `${m}_${k}`)),
  ...MODE_PREFIXES.map(m => `${m}_enabled_symbols`),
  ...MODE_PREFIXES.map(m => `${m}_enabled_strategies`),
];

const SYSTEM_KNOWLEDGE = `# Deriv Capital Extraction Platform V2 — Complete Knowledge Base

## 1. Platform Overview
This is the **Deriv Capital Extraction App V2** — a fully automated trading system for Deriv synthetic indices. The core philosophy is CAPITAL EXTRACTION: large capital, long hold, maximum profit. Grow an account, extract profits at target, reset and repeat.

### Supported Instruments (12 total)
- **Boom indices**: BOOM1000, BOOM900, BOOM600, BOOM300, BOOM500 — price spikes upward periodically
- **Crash indices**: CRASH1000, CRASH900, CRASH600, CRASH300, CRASH500 — price drops periodically
- **Volatility indices**: R_75 (75% volatility), R_100 (100% volatility) — continuous random walk

### Three Trading Modes (Independent)
Each mode has its own capital, settings, and trades. They run simultaneously and independently.
| Mode | Monthly Target | Risk Profile | Description |
|------|---------------|-------------|-------------|
| **Paper** | 120% | Aggressive | Simulated trades, no real money. Best for learning and testing. |
| **Demo** | 80% | Balanced | Uses Deriv demo account with virtual funds. Tests execution. |
| **Real** | 50% | Conservative | Real money. Tightest risk controls. Most conservative settings. |

## 2. The Five Strategy Families
Each family is a distinct trading approach, activated only when its matching market regime is detected.

### 2.1 Trend Continuation
- **When**: EMA slope > 0.0001 (up) or < -0.0001 (down), price pulled back near EMA (emaDist < 0.015), RSI 30-70
- **Regime**: trend_up or trend_down
- **Best for**: R_75, R_100 during trending periods

### 2.2 Mean Reversion
- **When**: z-score > 1.8 or < -1.8 (with zScore < 2.5 safety), RSI extreme (>62 or <38), 3+ adverse candles OR liquidity sweep
- **Regime**: mean_reversion or ranging
- **Best for**: Boom/Crash indices that overshoot

### 2.3 Breakout Expansion
- **When**: BB squeeze (width < 0.012), ATR expanding, price at BB edge
- **Regime**: compression or breakout_expansion
- **Best for**: All instruments during consolidation → expansion transitions

### 2.4 Spike Event
- **When**: Spike hazard score > 0.70 on Boom or Crash indices only
- **Regime**: spike_zone or ranging
- **Best for**: BOOM and CRASH indices exclusively

### 2.5 Trendline Breakout
- **When**: BB width expanding (> 0.008), price breaking above/below dynamic trendline with ATR confirmation, VWAP/pivot confluence
- **Regime**: compression, ranging, breakout_expansion, trend_up, trend_down
- **Best for**: All instruments during trendline break setups

## 3. V2 Trade Management — Spike-Magnitude-Aware TP/SL
TP is the PRIMARY exit. Trailing stop is SAFETY NET ONLY. No ATR-based TP/SL ever.

### Take-Profit (TP) — Boom/Crash Indices
1. Primary TP = entry ± spike p75 magnitude (from rolling 60-90 day spike_events analysis)
2. Targets full spike travel (50-200%+ moves). Never scalp 1-5% moves.
3. Structural confluence (major swing levels, fib extensions, pivots) used to refine target within 15% of spike TP.
4. Minimum TP floor = median spike magnitude.

### Take-Profit (TP) — Volatility Indices
1. TP = entry ± 70% of major swing range (from 1500+ candle 20-bar structural levels)
2. Clamped to major swing high/low if TP exceeds it.
3. Structural confluence clusters prioritised when 2+ levels within 0.5%.

### Stop-Loss (SL) — Boom/Crash Indices
1. SL distance = 30% of median spike magnitude (converted to percentage of entry price)
2. Minimum drift floor = 0.5%
3. Nearest structural support/resistance can tighten SL if between drift level and entry
4. Safety cap: max loss = 10% of equity per position

### Stop-Loss (SL) — Volatility Indices
1. Collect structural levels: major swing, swing, fib retracement, BB, pivots, Camarilla, VWAP, previous session levels
2. Find nearest confluence cluster (2+ levels within 0.5%) below entry (buy) or above entry (sell)
3. Place SL with 0.3% buffer outside the cluster
4. Safety cap: max loss = 10% of equity per position

### Trailing Stop — 30% Peak-Profit Drawdown
- Activates only when the trade is in profit
- Tracks peak unrealised profit percentage
- Triggers exit when profit drops 30% from peak (e.g., peak 10% → exit at 7%)
- This replaces V1's price-based trailing stop

### Time Exits
- **72 hours**: If profitable after 72h, close and take profit
- **168 hours**: Hard cap — all trades closed regardless of PnL
- No extensions, no per-family timing

## 4. Signal Pipeline — How Trades are Born
1. **Tick Streaming** → Live price ticks from Deriv WebSocket
2. **Feature Extraction** → 40+ technical features (EMA, RSI, z-score, BB, spike hazard, swing H/L, major swing H/L, spike magnitude stats, Fibonacci levels, VWAP, pivot points, Camarilla levels, psychological round numbers, previous session H/L/C) from 1500+ candle structural window
3. **Regime Classification** → Cached hourly: trend_up, trend_down, mean_reversion, ranging, compression, breakout_expansion, spike_zone, or no_trade
4. **Strategy Evaluation** → Only matching strategies run per regime
5. **ML Scoring** → Logistic regression model per family scores features (0-1)
6. **Composite Scoring** → 6-dimension weighted score (0-100):
   - Regime Fit (22%), Setup Quality (20%), Trend Alignment (15%), Volatility Condition (13%), Reward/Risk (15%), Probability of Success (15%)
7. **Filtering** → composite score ≥ min_composite_score, EV ≥ min_ev_threshold, R:R ≥ min_rr_ratio (estimated from S/R levels)
8. **AI Verification** (optional) → OpenAI reviews signal
9. **Portfolio Allocation** → Risk checks: daily/weekly loss limits, max drawdown, max open trades, correlated exposure cap
10. **Position Sizing** → equity × equity_pct_per_trade × confidence factor (up to 2 entries per symbol from different strategies)
11. **Execution** → S/R+Fib TP/SL computed, trade opened

## 5. Position Sizing (V2)
- Up to 2 positions per symbol from different strategy families (no probe/confirmation/momentum stages)
- Size = equity × equity_pct_per_trade × clamp(confidence, 0.5, 1.0) × allocation_mode multiplier
- Clamped to min 5% equity and max remaining capacity

## 6. Capital Extraction Cycle
1. Start with base capital
2. Trade until capital grows by extraction_target_pct (default 50%)
3. Extract profits (auto or manual), reset to base capital
4. Prevents compound risk

## 7. Settings Glossary — V2 Settings

### Global Settings
| Setting | What it means | Default |
|---------|--------------|---------|
| min_composite_score | Minimum quality score (0-100) for trading | 55/65/75 (paper/demo/real) |
| min_ev_threshold | Minimum expected value | 0.001 |
| min_rr_ratio | Minimum reward-to-risk ratio (from S/R levels) | 1.5 (live) / 1.2 (backtest) |
| scoring_weight_* | Six dimension weights for composite scoring | See §4 |
| scan_interval_seconds | Scan frequency | 30 |
| ai_verification_enabled | AI reviews signals before trading | true |
| kill_switch | Emergency halt — blocks all new trades | false |

### Per-Mode Settings (prefixed with paper_, demo_, or real_)
| Setting | What it means |
|---------|--------------|
| capital | Starting/current capital |
| equity_pct_per_trade | Percentage of equity per trade |
| max_open_trades | Max simultaneous positions |
| allocation_mode | "conservative" (0.7x), "balanced" (1.0x), or "aggressive" (1.3x) |
| max_daily_loss_pct | Max daily loss before halting |
| max_weekly_loss_pct | Max weekly loss before halting |
| max_drawdown_pct | Max drawdown from peak |
| extraction_target_pct | Profit % before extraction |
| auto_extraction | Auto-extract when target hit |
| correlated_family_cap | Max positions in correlated instruments |
| enabled_symbols | Comma-separated tradeable symbols |
| enabled_strategies | Comma-separated enabled strategy families |

## 8. Market Regime Definitions
| Regime | What's happening | Allowed strategies |
|--------|-----------------|-------------------|
| trend_up | Clear upward trend | trend_continuation |
| trend_down | Clear downward trend | trend_continuation |
| mean_reversion | Price overstretched | mean_reversion |
| compression | Low volatility squeeze | breakout_expansion |
| breakout_expansion | Volatility expanding | breakout_expansion |
| spike_zone | Boom/Crash spike imminent | spike_event |
| no_trade | Unclear signals | NONE — system waits |

## 9. AI Advisor Rules
1. You are an ADVISOR, not a controller. You NEVER directly change settings.
2. You can READ settings and pending AI suggestions.
3. You can WRITE suggestions (ai_suggest_ keys) for user to review and apply.
4. You can ANALYSE trade performance data for advice.
5. Always explain WHY — reference actual data.
6. Real mode = most conservative. Paper = most aggressive.
7. Never suggest composite score below 40.
8. Always favour FEWER, LARGER, HIGHER-QUALITY trades.

## 10. Core Trading Philosophy
- LARGE CAPITAL PER TRADE: Deploy 15-25% equity per position
- HIGHEST-QUALITY SIGNALS ONLY: Composite score ≥ 80+
- LONG HOLD: 72h profit exit, 168h hard cap
- DYNAMIC TP/SL: Spike-magnitude-aware (Boom/Crash) + structural S/R confluence (Volatility). TP is PRIMARY exit; trailing stop is SAFETY NET ONLY. No ATR fallbacks.
- 30% PEAK-PROFIT TRAILING: Lock in gains from peak unrealised profit
- FEW POSITIONS: Max 2-4 open trades
- EXTRACT PROFITS REGULARLY: Don't let compound risk grow`;



async function buildDynamicContext(): Promise<string> {
  const settings = await getCurrentSettings();

  const activeModes: string[] = [];
  for (const mode of MODE_PREFIXES) {
    if (settings[`${mode}_mode_active`] === "true") activeModes.push(mode);
  }

  const modesSummary = MODE_PREFIXES.map(mode => {
    const active = settings[`${mode}_mode_active`] === "true";
    const capital = settings[`${mode}_capital`] || "N/A";
    const eqPct = settings[`${mode}_equity_pct_per_trade`] || "N/A";
    const maxTrades = settings[`${mode}_max_open_trades`] || "N/A";
    const allocation = settings[`${mode}_allocation_mode`] || "balanced";
    const extractTarget = settings[`${mode}_extraction_target_pct`] || "50";
    return `${mode.toUpperCase()}: ${active ? "ACTIVE" : "INACTIVE"} | Capital: $${capital} | Equity/trade: ${eqPct}% | Max trades: ${maxTrades} | Allocation: ${allocation} | Extraction target: ${extractTarget}%`;
  }).join("\n");

  const aiSuggestions: string[] = [];
  for (const [k, v] of Object.entries(settings)) {
    if (k.startsWith("ai_suggest_")) {
      const actualKey = k.replace("ai_suggest_", "");
      const currentValue = settings[actualKey] || "unknown";
      aiSuggestions.push(`${actualKey}: current="${currentValue}" → suggested="${v}"`);
    }
  }

  const globalSettings = [
    `min_composite_score: ${settings["min_composite_score"] || "55"}`,
    `min_ev_threshold: ${settings["min_ev_threshold"] || "0.001"}`,
    `min_rr_ratio: ${settings["min_rr_ratio"] || "1.5"}`,
    `scan_interval_seconds: ${settings["scan_interval_seconds"] || "30"}`,
    `ai_verification_enabled: ${settings["ai_verification_enabled"] || "true"}`,
    `kill_switch: ${settings["kill_switch"] || "false"}`,
  ].join("\n");

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  let recentTradesSummary = "No recent trades in database.";
  try {
    const recentTrades = await db.select().from(tradesTable)
      .where(gte(tradesTable.entryTs, sevenDaysAgo))
      .orderBy(desc(tradesTable.entryTs))
      .limit(20);

    if (recentTrades.length > 0) {
      const openCount = recentTrades.filter(t => t.status === "open").length;
      const closedRecent = recentTrades.filter(t => t.status === "closed");
      const totalPnl = closedRecent.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const winCount = closedRecent.filter(t => (t.pnl ?? 0) > 0).length;
      const winRate = closedRecent.length > 0 ? (winCount / closedRecent.length * 100).toFixed(1) : "N/A";

      recentTradesSummary = `Last 7 days: ${recentTrades.length} trades (${openCount} open, ${closedRecent.length} closed) | Win rate: ${winRate}% | Total PnL: $${totalPnl.toFixed(2)}`;
    }
  } catch (err) {
    console.warn("[AiChat] Failed to query recent trades for context:", err instanceof Error ? err.message : err);
  }

  let sections = `\n--- CURRENT SYSTEM STATE ---\n`;
  sections += `\nActive Modes:\n${modesSummary}\n`;
  sections += `\nGlobal Settings:\n${globalSettings}\n`;
  sections += `\nRecent Performance:\n${recentTradesSummary}\n`;

  if (aiSuggestions.length > 0) {
    sections += `\nPending AI Suggestions (${aiSuggestions.length}):\n${aiSuggestions.join("\n")}\n`;
  } else {
    sections += `\nPending AI Suggestions: None\n`;
  }

  return sections;
}


const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_current_settings",
      description: "Get all current platform settings, their values, and any pending AI suggestions",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_suggestions",
      description: "Write AI suggestions for settings. These are NOT applied automatically — the user must review and apply them manually in the Settings page. Use this to recommend value changes.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "object",
            description: "Key-value pairs of suggested settings. Keys should match actual setting names (e.g. paper_equity_pct_per_trade, min_composite_score, min_rr_ratio)",
            additionalProperties: { type: "string" },
          },
          reasoning: {
            type: "string",
            description: "Brief explanation of why these suggestions are being made",
          },
        },
        required: ["suggestions", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_trades",
      description: "Query recent trade performance data. Use this to answer questions about trade history, win rates, PnL, durations, strategy performance, and TP/SL effectiveness. Always call this before giving performance-based advice.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["paper", "demo", "real", "all"],
            description: "Which trading mode to analyze. Use 'all' for cross-mode analysis.",
          },
          days: {
            type: "number",
            description: "Number of days to look back. Default 7.",
          },
          focus: {
            type: "string",
            enum: ["overview", "by_strategy", "by_symbol", "durations", "tp_sl_effectiveness", "recent_closed", "open_positions"],
            description: "What aspect to focus the analysis on.",
          },
        },
        required: ["focus"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_signals",
      description: "Query signal log data to understand signal hit rates, rejection reasons, scoring patterns, and regime distribution. Use this to explain why trades are or aren't being taken.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Number of days to look back. Default 7.",
          },
          focus: {
            type: "string",
            enum: ["hit_rates", "rejection_reasons", "regime_distribution", "score_distribution", "by_symbol"],
            description: "What aspect of signal data to analyze.",
          },
        },
        required: ["focus"],
      },
    },
  },
];


async function handleAnalyzeTrades(args: { mode?: string; days?: number; focus: string }): Promise<string> {
  const days = args.days || 7;
  const since = new Date(Date.now() - days * 86400000);
  const modeFilter = args.mode && args.mode !== "all" ? args.mode : null;

  const conditions = [gte(tradesTable.entryTs, since)];
  if (modeFilter) conditions.push(eq(tradesTable.mode, modeFilter));

  const trades = await db.select().from(tradesTable)
    .where(and(...conditions))
    .orderBy(desc(tradesTable.entryTs))
    .limit(200);

  if (trades.length === 0) {
    return JSON.stringify({ message: `No trades found in the last ${days} days${modeFilter ? ` for ${modeFilter} mode` : ""}.` });
  }

  const openTrades = trades.filter(t => t.status === "open");
  const closedTrades = trades.filter(t => t.status === "closed");

  switch (args.focus) {
    case "overview": {
      const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0);
      const losses = closedTrades.filter(t => (t.pnl ?? 0) <= 0);
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length : 0;
      const avgDurationHrs = closedTrades.length > 0
        ? closedTrades.filter(t => t.exitTs).reduce((s, t) => s + (t.exitTs!.getTime() - t.entryTs.getTime()) / 3600000, 0) / closedTrades.filter(t => t.exitTs).length
        : 0;

      return JSON.stringify({
        period: `Last ${days} days`,
        mode: modeFilter || "all",
        totalTrades: trades.length,
        openTrades: openTrades.length,
        closedTrades: closedTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: closedTrades.length > 0 ? `${(wins.length / closedTrades.length * 100).toFixed(1)}%` : "N/A",
        totalPnl: `$${totalPnl.toFixed(2)}`,
        avgWin: `$${avgWin.toFixed(2)}`,
        avgLoss: `$${avgLoss.toFixed(2)}`,
        avgDurationHours: `${avgDurationHrs.toFixed(1)}h`,
        profitFactor: losses.length > 0 && avgLoss !== 0 ? ((avgWin * wins.length) / Math.abs(avgLoss * losses.length)).toFixed(2) : "N/A",
      });
    }

    case "by_strategy": {
      const byStrategy: Record<string, { total: number; wins: number; pnl: number; avgScore: number }> = {};
      for (const t of closedTrades) {
        if (!byStrategy[t.strategyName]) byStrategy[t.strategyName] = { total: 0, wins: 0, pnl: 0, avgScore: 0 };
        byStrategy[t.strategyName].total++;
        if ((t.pnl ?? 0) > 0) byStrategy[t.strategyName].wins++;
        byStrategy[t.strategyName].pnl += t.pnl ?? 0;
        byStrategy[t.strategyName].avgScore += t.confidence ?? 0;
      }
      const result: Record<string, any> = {};
      for (const [strat, data] of Object.entries(byStrategy)) {
        result[strat] = {
          trades: data.total,
          wins: data.wins,
          winRate: `${(data.wins / data.total * 100).toFixed(1)}%`,
          totalPnl: `$${data.pnl.toFixed(2)}`,
          avgConfidence: (data.avgScore / data.total).toFixed(3),
        };
      }
      return JSON.stringify({ period: `Last ${days} days`, mode: modeFilter || "all", strategyBreakdown: result });
    }

    case "by_symbol": {
      const bySymbol: Record<string, { total: number; wins: number; pnl: number }> = {};
      for (const t of closedTrades) {
        if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { total: 0, wins: 0, pnl: 0 };
        bySymbol[t.symbol].total++;
        if ((t.pnl ?? 0) > 0) bySymbol[t.symbol].wins++;
        bySymbol[t.symbol].pnl += t.pnl ?? 0;
      }
      const result: Record<string, any> = {};
      for (const [sym, data] of Object.entries(bySymbol)) {
        result[sym] = {
          trades: data.total,
          winRate: `${(data.wins / data.total * 100).toFixed(1)}%`,
          totalPnl: `$${data.pnl.toFixed(2)}`,
        };
      }
      return JSON.stringify({ period: `Last ${days} days`, mode: modeFilter || "all", symbolBreakdown: result });
    }

    case "durations": {
      const durations = closedTrades
        .filter(t => t.exitTs)
        .map(t => ({
          symbol: t.symbol,
          strategy: t.strategyName,
          durationHours: ((t.exitTs!.getTime() - t.entryTs.getTime()) / 3600000).toFixed(1),
          pnl: `$${(t.pnl ?? 0).toFixed(2)}`,
          exitReason: t.exitReason || "unknown",
        }));
      const avgDuration = durations.length > 0
        ? (durations.reduce((s, d) => s + parseFloat(d.durationHours), 0) / durations.length).toFixed(1)
        : "0";
      const exitReasons: Record<string, number> = {};
      for (const d of durations) {
        exitReasons[d.exitReason] = (exitReasons[d.exitReason] || 0) + 1;
      }
      return JSON.stringify({
        period: `Last ${days} days`,
        avgDurationHours: avgDuration,
        exitReasonCounts: exitReasons,
        trades: durations.slice(0, 15),
      });
    }

    case "tp_sl_effectiveness": {
      const analysis = closedTrades.filter(t => t.exitTs).map(t => {
        const tpDist = Math.abs(t.tp - t.entryPrice);
        const slDist = Math.abs(t.sl - t.entryPrice);
        const actualMove = t.exitPrice ? Math.abs(t.exitPrice - t.entryPrice) : 0;
        const tpReached = t.exitReason === "tp_hit" || (t.pnl ?? 0) > 0 && actualMove >= tpDist * 0.9;
        const slReached = t.exitReason === "sl_hit" || (t.pnl ?? 0) < 0 && actualMove >= slDist * 0.9;
        return { symbol: t.symbol, strategy: t.strategyName, tpDist, slDist, actualMove, tpReached, slReached, exitReason: t.exitReason || "unknown", pnl: t.pnl ?? 0 };
      });
      const tpHits = analysis.filter(a => a.tpReached).length;
      const slHits = analysis.filter(a => a.slReached).length;
      const timeExits = analysis.filter(a => a.exitReason?.includes("time")).length;
      const harvestExits = analysis.filter(a => a.exitReason?.includes("harvest") || a.exitReason?.includes("peak")).length;
      const avgTpDistance = analysis.length > 0 ? analysis.reduce((s, a) => s + a.tpDist, 0) / analysis.length : 0;
      const avgSlDistance = analysis.length > 0 ? analysis.reduce((s, a) => s + a.slDist, 0) / analysis.length : 0;
      return JSON.stringify({
        period: `Last ${days} days`,
        totalClosed: analysis.length,
        tpHits,
        slHits,
        timeExits,
        harvestExits,
        otherExits: analysis.length - tpHits - slHits - timeExits - harvestExits,
        avgTpDistance: avgTpDistance.toFixed(4),
        avgSlDistance: avgSlDistance.toFixed(4),
        avgRR: avgSlDistance > 0 ? (avgTpDistance / avgSlDistance).toFixed(2) : "N/A",
      });
    }

    case "recent_closed": {
      const recent = closedTrades.slice(0, 10).map(t => ({
        id: t.id,
        symbol: t.symbol,
        strategy: t.strategyName,
        side: t.side,
        mode: t.mode,
        entryPrice: t.entryPrice.toFixed(4),
        exitPrice: t.exitPrice?.toFixed(4) || "N/A",
        pnl: `$${(t.pnl ?? 0).toFixed(2)}`,
        durationHours: t.exitTs ? ((t.exitTs.getTime() - t.entryTs.getTime()) / 3600000).toFixed(1) + "h" : "N/A",
        exitReason: t.exitReason || "unknown",
        confidence: t.confidence?.toFixed(3) || "N/A",
      }));
      return JSON.stringify({ period: `Last ${days} days`, recentClosedTrades: recent });
    }

    case "open_positions": {
      const open = openTrades.map(t => {
        const unrealizedPnl = t.currentPrice && t.entryPrice
          ? (t.side === "buy" ? t.currentPrice - t.entryPrice : t.entryPrice - t.currentPrice) * (t.size / t.entryPrice)
          : 0;
        const hoursOpen = (Date.now() - t.entryTs.getTime()) / 3600000;
        return {
          id: t.id,
          symbol: t.symbol,
          strategy: t.strategyName,
          side: t.side,
          mode: t.mode,
          entryPrice: t.entryPrice.toFixed(4),
          currentPrice: t.currentPrice?.toFixed(4) || "N/A",
          tp: t.tp.toFixed(4),
          sl: t.sl.toFixed(4),
          size: `$${t.size.toFixed(2)}`,
          unrealizedPnl: `$${unrealizedPnl.toFixed(2)}`,
          hoursOpen: `${hoursOpen.toFixed(1)}h`,
          peakPrice: t.peakPrice?.toFixed(4) || "N/A",
          maxExitTs: t.maxExitTs?.toISOString() || "N/A",
        };
      });
      return JSON.stringify({ openPositions: open, count: open.length });
    }

    default:
      return JSON.stringify({ error: "Unknown focus type" });
  }
}


async function handleAnalyzeSignals(args: { days?: number; focus: string }): Promise<string> {
  const days = args.days || 7;
  const since = new Date(Date.now() - days * 86400000);

  const signals = await db.select().from(signalLogTable)
    .where(gte(signalLogTable.ts, since))
    .orderBy(desc(signalLogTable.ts))
    .limit(500);

  if (signals.length === 0) {
    return JSON.stringify({ message: `No signals logged in the last ${days} days.` });
  }

  switch (args.focus) {
    case "hit_rates": {
      const total = signals.length;
      const allowed = signals.filter(s => s.allowedFlag).length;
      const rejected = total - allowed;
      const byFamily: Record<string, { total: number; allowed: number }> = {};
      for (const s of signals) {
        const fam = s.strategyFamily || s.strategyName;
        if (!byFamily[fam]) byFamily[fam] = { total: 0, allowed: 0 };
        byFamily[fam].total++;
        if (s.allowedFlag) byFamily[fam].allowed++;
      }
      const familyRates: Record<string, string> = {};
      for (const [fam, data] of Object.entries(byFamily)) {
        familyRates[fam] = `${data.allowed}/${data.total} (${(data.allowed / data.total * 100).toFixed(1)}%)`;
      }
      return JSON.stringify({
        period: `Last ${days} days`,
        totalSignals: total,
        allowed,
        rejected,
        overallHitRate: `${(allowed / total * 100).toFixed(1)}%`,
        byFamily: familyRates,
      });
    }

    case "rejection_reasons": {
      const rejected = signals.filter(s => !s.allowedFlag && s.rejectionReason);
      const reasons: Record<string, number> = {};
      for (const s of rejected) {
        const reason = s.rejectionReason || "unknown";
        const normalized = reason.replace(/\([^)]*\)/g, "").replace(/[0-9.]+/g, "N").trim();
        reasons[normalized] = (reasons[normalized] || 0) + 1;
      }
      const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
      return JSON.stringify({
        period: `Last ${days} days`,
        totalRejected: rejected.length,
        topReasons: sorted.slice(0, 10).map(([reason, count]) => ({ reason, count })),
      });
    }

    case "regime_distribution": {
      const regimes: Record<string, number> = {};
      for (const s of signals) {
        const r = s.regime || "unknown";
        regimes[r] = (regimes[r] || 0) + 1;
      }
      return JSON.stringify({
        period: `Last ${days} days`,
        totalSignals: signals.length,
        regimeDistribution: regimes,
      });
    }

    case "score_distribution": {
      const scores = signals.filter(s => s.compositeScore != null).map(s => s.compositeScore!);
      if (scores.length === 0) return JSON.stringify({ message: "No scored signals found." });
      const buckets: Record<string, number> = { "0-50": 0, "50-60": 0, "60-70": 0, "70-80": 0, "80-85": 0, "85-90": 0, "90-95": 0, "95-100": 0 };
      for (const s of scores) {
        if (s < 50) buckets["0-50"]++;
        else if (s < 60) buckets["50-60"]++;
        else if (s < 70) buckets["60-70"]++;
        else if (s < 80) buckets["70-80"]++;
        else if (s < 85) buckets["80-85"]++;
        else if (s < 90) buckets["85-90"]++;
        else if (s < 95) buckets["90-95"]++;
        else buckets["95-100"]++;
      }
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      return JSON.stringify({
        period: `Last ${days} days`,
        totalScored: scores.length,
        avgCompositeScore: avg.toFixed(1),
        distribution: buckets,
      });
    }

    case "by_symbol": {
      const bySymbol: Record<string, { total: number; allowed: number; avgScore: number }> = {};
      for (const s of signals) {
        if (!bySymbol[s.symbol]) bySymbol[s.symbol] = { total: 0, allowed: 0, avgScore: 0 };
        bySymbol[s.symbol].total++;
        if (s.allowedFlag) bySymbol[s.symbol].allowed++;
        bySymbol[s.symbol].avgScore += s.compositeScore ?? 0;
      }
      const result: Record<string, any> = {};
      for (const [sym, data] of Object.entries(bySymbol)) {
        result[sym] = {
          signals: data.total,
          allowed: data.allowed,
          hitRate: `${(data.allowed / data.total * 100).toFixed(1)}%`,
          avgCompositeScore: (data.avgScore / data.total).toFixed(1),
        };
      }
      return JSON.stringify({ period: `Last ${days} days`, symbolBreakdown: result });
    }

    default:
      return JSON.stringify({ error: "Unknown focus type" });
  }
}


router.post("/ai/chat", async (req, res): Promise<void> => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages array required" });
      return;
    }

    const client = await getOpenAIClient();

    const dynamicContext = await buildDynamicContext();
    const fullSystemPrompt = SYSTEM_KNOWLEDGE + "\n" + dynamicContext;

    const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: fullSystemPrompt },
      ...messages,
    ];

    let response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: chatMessages,
      tools,
      max_tokens: 1500,
    });

    let attempts = 0;
    const maxAttempts = 5;

    while (response.choices[0]?.finish_reason === "tool_calls" && attempts < maxAttempts) {
      attempts++;
      const toolCalls = response.choices[0].message.tool_calls || [];
      chatMessages.push(response.choices[0].message);

      for (const tc of toolCalls) {
        let result: string;
        try {
          if (!("function" in tc)) { continue; }
          const fn = tc as { type: "function"; function: { name: string; arguments: string }; id: string };
          if (fn.function.name === "get_current_settings") {
            const settings = await getCurrentSettings();
            const aiSuggestions: Record<string, string> = {};
            for (const [k, v] of Object.entries(settings)) {
              if (k.startsWith("ai_suggest_")) {
                aiSuggestions[k.replace("ai_suggest_", "")] = v;
              }
            }
            const actualSettings: Record<string, string> = {};
            for (const [k, v] of Object.entries(settings)) {
              if (!k.startsWith("ai_suggest_") && !k.startsWith("ai_")) {
                actualSettings[k] = v;
              }
            }
            result = JSON.stringify({ settings: actualSettings, pendingSuggestions: aiSuggestions }, null, 2);
          } else if (fn.function.name === "write_suggestions") {
            const args = JSON.parse(fn.function.arguments);
            const toSuggest = args.suggestions || {};
            const reasoning = args.reasoning || "";
            const written: string[] = [];
            const rejected: string[] = [];

            for (const [key, value] of Object.entries(toSuggest)) {
              if (WRITABLE_SETTINGS.includes(key)) {
                const suggestKey = `ai_suggest_${key}`;
                await db
                  .insert(platformStateTable)
                  .values({ key: suggestKey, value: String(value) })
                  .onConflictDoUpdate({
                    target: platformStateTable.key,
                    set: { value: String(value), updatedAt: new Date() },
                  });
                written.push(`${key} → ${value}`);
              } else {
                rejected.push(`${key} (not a valid setting key)`);
              }
            }

            await db.insert(platformStateTable)
              .values({ key: "ai_chat_suggestion_at", value: new Date().toISOString() })
              .onConflictDoUpdate({ target: platformStateTable.key, set: { value: new Date().toISOString(), updatedAt: new Date() } });

            result = JSON.stringify({
              written,
              rejected,
              message: written.length > 0
                ? `Wrote ${written.length} suggestion(s). The user can review and apply them in the Settings page.`
                : "No suggestions were written.",
              reasoning,
            });
          } else if (fn.function.name === "analyze_trades") {
            const args = JSON.parse(fn.function.arguments);
            result = await handleAnalyzeTrades(args);
          } else if (fn.function.name === "analyze_signals") {
            const args = JSON.parse(fn.function.arguments);
            result = await handleAnalyzeSignals(args);
          } else {
            result = JSON.stringify({ error: "Unknown function" });
          }
        } catch (err) {
          result = JSON.stringify({ error: err instanceof Error ? err.message : "Function call failed" });
        }

        chatMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }

      response = await client.chat.completions.create({
        model: "gpt-4o",
        messages: chatMessages,
        tools,
        max_tokens: 1500,
      });
    }

    const reply = response.choices[0]?.message?.content || "I couldn't generate a response.";
    const suggestionsWritten = chatMessages.some(
      m => m.role === "tool" && typeof m.content === "string" && m.content.includes('"written"')
    );

    res.json({ reply, settingsChanged: false, suggestionsWritten });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI chat failed";
    res.status(500).json({ error: message });
  }
});

export default router;
