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

const MODE_PREFIXES = ["paper", "demo", "real"];
const FAMILIES = ["trend_continuation", "mean_reversion", "breakout_expansion", "spike_event"];
const PER_MODE_KEYS = [
  "capital", "equity_pct_per_trade", "max_open_trades", "allocation_mode",
  "tp_multiplier_strong", "tp_multiplier_medium", "tp_multiplier_weak",
  "sl_ratio", "trailing_stop_pct", "time_exit_window_hours",
  "tp_capture_ratio", "min_sl_atr_multiplier",
  "max_daily_loss_pct", "max_weekly_loss_pct", "max_drawdown_pct",
  "probe_threshold", "confirmation_threshold", "momentum_threshold",
  "stage_multiplier_probe", "stage_multiplier_confirmation", "stage_multiplier_momentum",
  "peak_drawdown_exit_pct", "min_peak_profit_pct", "large_peak_threshold_pct",
  "extraction_target_pct", "auto_extraction",
  "correlated_family_cap",
];
const PER_FAMILY_KEYS = [
  "tp_atr_multiplier", "sl_atr_multiplier", "initial_exit_hours",
  "extension_hours", "max_exit_hours", "harvest_sensitivity",
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
  ...MODE_PREFIXES.flatMap(m => FAMILIES.flatMap(f => PER_FAMILY_KEYS.map(k => `${m}_${f}_${k}`))),
  ...MODE_PREFIXES.map(m => `${m}_enabled_symbols`),
  ...MODE_PREFIXES.map(m => `${m}_enabled_strategies`),
];

const SYSTEM_PROMPT = `You are the AI assistant for a Deriv Capital Extraction trading platform. You help users understand settings, review AI suggestions, and learn about strategies.

IMPORTANT: You are an ADVISOR, not a controller. You NEVER directly change settings. Instead, you can:
1. Read current settings and AI suggestions
2. Write new AI suggestions for the user to review and manually apply in Settings
3. Explain the reasoning behind suggestions

CORE TRADING PHILOSOPHY — This is a CAPITAL EXTRACTION strategy:
- HIGH CAPITAL PER TRADE: Deploy 15–25% equity per position. Large, meaningful trades.
- HIGHEST-VALUE SIGNALS ONLY: Composite score threshold 85+. Fewer trades, high conviction.
- HOLD FOR LONGER PERIODS: Time exit windows of 48–168 hours. Swing trade with patience.
- WIDE TAKE PROFITS: TP multipliers of 2.5x–4.0x ATR. Target large moves.
- TIGHT TRAILING STOPS: Trail 20–25% behind peak price. Protect profits aggressively.
- FEW SIMULTANEOUS POSITIONS: Max 2–3 open trades. Concentrate capital.

You have access to these capabilities via function calls:
1. get_current_settings - View all current platform settings and existing AI suggestions
2. write_suggestions - Write AI suggestions for the user to review (NEVER changes actual settings)

Platform architecture:
- 3 independent trading modes: Paper (120%/mo target), Demo (80%/mo), Real (50%/mo)
- 4 strategy families: trend_continuation, mean_reversion, breakout_expansion, spike_event
- Composite scoring system (0-100) with 6 weighted dimensions
- Signal scoring thresholds, scan timing, and kill switch are GLOBAL
- TP/SL, trailing stop, position sizing, time exit, risk limits, instruments, and strategies are PER-MODE
- All settings are prefixed with mode name (e.g. paper_equity_pct_per_trade, demo_sl_ratio, real_max_open_trades)

When making recommendations:
- Always favour FEWER, LARGER, HIGHER-QUALITY trades
- For Real mode, be most conservative. For Paper, most aggressive.
- Never suggest lowering composite score below 80
- Explain WHY you're suggesting a change — what data supports it
- Write suggestions using write_suggestions, then tell the user to check Settings to review and apply them

Be concise and helpful. Format numbers clearly. Always explain your reasoning.`;


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
            description: "Key-value pairs of suggested settings. Keys should match actual setting names (e.g. paper_equity_pct_per_trade, demo_sl_ratio, min_composite_score)",
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
          } else if (tc.function.name === "write_suggestions") {
            const args = JSON.parse(tc.function.arguments);
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
