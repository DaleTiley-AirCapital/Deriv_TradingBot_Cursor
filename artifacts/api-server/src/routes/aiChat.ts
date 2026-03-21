import { Router, type IRouter } from "express";
import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

const WRITABLE_SETTINGS = [
  "min_composite_score", "min_ev_threshold", "min_rr_ratio",
  "scoring_weight_regime_fit", "scoring_weight_setup_quality",
  "scoring_weight_trend_alignment", "scoring_weight_volatility_condition",
  "scoring_weight_reward_risk", "scoring_weight_probability_of_success",
  "scan_interval_seconds", "scan_stagger_seconds",
  "ai_verification_enabled", "kill_switch",
  "paper_mode_active", "demo_mode_active", "real_mode_active",
  "paper_tp_multiplier_strong", "paper_tp_multiplier_medium", "paper_tp_multiplier_weak",
  "paper_sl_ratio", "paper_trailing_stop_pct", "paper_time_exit_window_hours",
  "paper_equity_pct_per_trade", "paper_max_open_trades",
  "paper_max_daily_loss_pct", "paper_max_weekly_loss_pct", "paper_max_drawdown_pct",
  "demo_tp_multiplier_strong", "demo_tp_multiplier_medium", "demo_tp_multiplier_weak",
  "demo_sl_ratio", "demo_trailing_stop_pct", "demo_time_exit_window_hours",
  "demo_equity_pct_per_trade", "demo_max_open_trades",
  "demo_max_daily_loss_pct", "demo_max_weekly_loss_pct", "demo_max_drawdown_pct",
  "real_tp_multiplier_strong", "real_tp_multiplier_medium", "real_tp_multiplier_weak",
  "real_sl_ratio", "real_trailing_stop_pct", "real_time_exit_window_hours",
  "real_equity_pct_per_trade", "real_max_open_trades",
  "real_max_daily_loss_pct", "real_max_weekly_loss_pct", "real_max_drawdown_pct",
];

const SYSTEM_PROMPT = `You are the AI assistant for a Deriv Quant Trading Platform. You help users configure their trading settings, understand strategies, and manage their platform.

You have access to these capabilities via function calls:
1. get_current_settings - View all current platform settings
2. update_settings - Change specific settings (only allowed keys)

Platform overview:
- 3 independent trading modes: Paper (simulated), Demo (Deriv demo account), Real (Deriv real account)
- 7 strategies: trend-pullback, exhaustion-rebound, volatility-breakout, spike-hazard, volatility-expansion, liquidity-sweep, macro-bias
- Composite scoring system (0-100) with 6 dimensions and configurable weights
- Signal scoring thresholds, scan timing, and kill switch are GLOBAL (same for all modes)
- TP/SL, trailing stop, position sizing, risk limits, instruments, and strategies are PER-MODE

Trailing stop: SL trails X% behind the highest point reached. Default 25%.
Time exit: Positions auto-close after configurable hours. Per-mode.
Kill switch: Emergency stop all trading.

Be concise and helpful. When changing settings, confirm what you're about to do. Format numbers clearly.`;

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_current_settings",
      description: "Get all current platform settings and their values",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_settings",
      description: "Update one or more platform settings. Only use after confirming with the user.",
      parameters: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            description: "Key-value pairs of settings to update",
            additionalProperties: { type: "string" },
          },
        },
        required: ["settings"],
      },
    },
  },
];

router.post("/ai/chat", async (req, res): Promise<void> => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages array required" });
      return;
    }

    const client = await getOpenAIClient();

    const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages,
    ];

    let response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: chatMessages,
      tools,
      max_tokens: 1000,
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
          if (tc.function.name === "get_current_settings") {
            const settings = await getCurrentSettings();
            result = JSON.stringify(settings, null, 2);
          } else if (tc.function.name === "update_settings") {
            const args = JSON.parse(tc.function.arguments);
            const toUpdate = args.settings || {};
            const updated: string[] = [];
            const rejected: string[] = [];

            for (const [key, value] of Object.entries(toUpdate)) {
              if (WRITABLE_SETTINGS.includes(key)) {
                await db
                  .insert(platformStateTable)
                  .values({ key, value: String(value) })
                  .onConflictDoUpdate({
                    target: platformStateTable.key,
                    set: { value: String(value), updatedAt: new Date() },
                  });
                updated.push(`${key} = ${value}`);
              } else {
                rejected.push(`${key} (not writable)`);
              }
            }
            result = JSON.stringify({
              updated,
              rejected,
              message: updated.length > 0 ? `Updated ${updated.length} setting(s)` : "No settings were updated",
            });
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
        max_tokens: 1000,
      });
    }

    const reply = response.choices[0]?.message?.content || "I couldn't generate a response.";
    const settingsChanged = chatMessages.some(
      m => m.role === "tool" && typeof m.content === "string" && m.content.includes('"updated"')
    );

    res.json({ reply, settingsChanged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI chat failed";
    res.status(500).json({ error: message });
  }
});

export default router;
