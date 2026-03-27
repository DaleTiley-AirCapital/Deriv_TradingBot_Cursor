import React, { useEffect, useState, useCallback } from "react";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useGetAccountInfo,
  useToggleTradingMode,
  getGetAccountInfoQueryKey,
} from "@workspace/api-client-react";
import type { ToggleTradingModeRequestMode, ActionResponse } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui-elements";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Shield, TrendingUp, Clock, Crosshair, Save, RotateCcw, CheckCircle2, Key, Eye, EyeOff, AlertTriangle, Zap, Bot, Lock, Unlock, Database, Download, FlaskConical, Sparkles, ChevronRight, ChevronDown, XCircle, Wifi, Loader2, Trash2, BarChart3, Target, Layers, Activity } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

const V1_DEFAULTS: Record<string, Record<string, string>> = {
  paper: {
    capital: "10000", equity_pct_per_trade: "30", max_open_trades: "4", allocation_mode: "aggressive",
    min_composite_score: "55", min_ev_threshold: "0.001", min_rr_ratio: "1.5",
    max_daily_loss_pct: "8", max_weekly_loss_pct: "15", max_drawdown_pct: "25",
    extraction_target_pct: "50", auto_extraction: "false",
    correlated_family_cap: "4",
  },
  demo: {
    capital: "600", equity_pct_per_trade: "20", max_open_trades: "3", allocation_mode: "balanced",
    min_composite_score: "65", min_ev_threshold: "0.001", min_rr_ratio: "1.5",
    max_daily_loss_pct: "5", max_weekly_loss_pct: "10", max_drawdown_pct: "18",
    extraction_target_pct: "50", auto_extraction: "false",
    correlated_family_cap: "3",
  },
  real: {
    capital: "600", equity_pct_per_trade: "15", max_open_trades: "3", allocation_mode: "balanced",
    min_composite_score: "75", min_ev_threshold: "0.001", min_rr_ratio: "1.5",
    max_daily_loss_pct: "3", max_weekly_loss_pct: "6", max_drawdown_pct: "12",
    extraction_target_pct: "50", auto_extraction: "false",
    correlated_family_cap: "3",
  },
};

interface AiSuggestions { [key: string]: string }

interface SettingFieldProps {
  label: string;
  description: string;
  value: string;
  onChange: (val: string) => void;
  type?: "number" | "text" | "toggle" | "select" | "password";
  options?: { value: string; label: string }[];
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  locked: boolean;
  onUnlock: () => void;
  aiSuggestion?: string;
  onApplySuggestion?: () => void;
}

function UnlockWarningDialog({ settingLabel, onConfirm, onCancel }: { settingLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-card border border-warning/30 rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-warning" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-foreground">Modify Setting</h3>
            <p className="text-sm text-muted-foreground">{settingLabel}</p>
          </div>
        </div>
        <div className="space-y-3 mb-6 text-sm text-muted-foreground">
          <p>These values have been <span className="text-foreground font-semibold">researched in depth and verified</span> through extensive backtesting.</p>
          <p>By changing this value you are <span className="text-warning font-semibold">increasing risk exponentially</span>. This is not advised unless you have thoroughly researched and understand the impact.</p>
          <p className="text-xs text-muted-foreground/70">Incorrect settings can lead to rapid account depletion.</p>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all">
            Keep Locked
          </button>
          <button onClick={onConfirm} className="flex-1 px-4 py-2.5 rounded-lg bg-warning/80 text-warning-foreground text-sm font-bold uppercase tracking-wider hover:bg-warning transition-all">
            Unlock & Edit
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function SettingField({ label, description, value, onChange, type = "number", options, suffix, min, max, step, placeholder, locked, onUnlock, aiSuggestion, onApplySuggestion }: SettingFieldProps) {
  const [showPassword, setShowPassword] = useState(false);

  const hasSuggestion = aiSuggestion !== undefined && aiSuggestion !== value;
  const suggestionHigher = hasSuggestion && parseFloat(aiSuggestion!) > parseFloat(value);

  if (type === "toggle") {
    const isOn = value === "true";
    const toggleSuggestion = hasSuggestion;
    return (
      <div className="py-3 border-b border-border/30 last:border-0">
        <div className="flex items-center justify-between">
          <div className="flex-1 pr-4">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          </div>
          <div className="flex items-center gap-2">
            {locked ? (
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-muted-foreground">{isOn ? "ON" : "OFF"}</span>
                <button onClick={onUnlock} className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors" title="Unlock to edit">
                  <Lock className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => onChange(isOn ? "false" : "true")}
                className={cn("relative inline-flex h-6 w-11 items-center rounded-full transition-colors", isOn ? "bg-destructive" : "bg-muted")}
              >
                <span className={cn("inline-block h-4 w-4 rounded-full bg-white transition-transform shadow-sm", isOn ? "translate-x-6" : "translate-x-1")} />
              </button>
            )}
          </div>
        </div>
        {toggleSuggestion && (
          <div data-ai-suggestion className="flex items-center justify-end gap-2 mt-1.5">
            <span className={cn("text-xs", suggestionHigher ? "text-emerald-500" : "text-amber-500")}>
              AI suggests: <span className="font-mono font-semibold">{aiSuggestion}</span>
            </span>
            {onApplySuggestion && (
              <button onClick={locked ? onUnlock : onApplySuggestion} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors">
                {locked ? "Unlock to Apply" : "Apply"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (type === "select" && options) {
    return (
      <div className="py-3 border-b border-border/30 last:border-0">
        <div className="flex items-center justify-between">
          <div className="flex-1 pr-4">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          </div>
          <div className="flex items-center gap-2">
            {locked ? (
              <>
                <span className="text-sm font-mono text-muted-foreground capitalize">{value}</span>
                <button onClick={onUnlock} className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors" title="Unlock to edit">
                  <Lock className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <div className="flex gap-1.5">
                {options.map((opt) => (
                  <button key={opt.value} onClick={() => onChange(opt.value)}
                    className={cn("px-3 py-1.5 rounded-md text-xs font-medium uppercase tracking-wider transition-all border",
                      value === opt.value ? "bg-primary/10 border-primary text-primary" : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    )}
                  >{opt.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
        {hasSuggestion && (
          <div data-ai-suggestion className="flex items-center justify-end gap-2 mt-1.5">
            <span className={cn("text-xs", suggestionHigher ? "text-emerald-500" : "text-amber-500")}>
              AI suggests: <span className="font-mono font-semibold">{aiSuggestion}</span>
            </span>
            {onApplySuggestion && (
              <button onClick={locked ? onUnlock : onApplySuggestion} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors">
                {locked ? "Unlock to Apply" : "Apply"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (type === "password") {
    return (
      <div className="flex items-center justify-between py-3 border-b border-border/30 last:border-0">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {locked ? (
            <>
              <span className="text-sm font-mono text-muted-foreground">{value ? "****configured****" : "Not set"}</span>
              <button onClick={onUnlock} className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors" title="Unlock to edit">
                <Lock className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <input type={showPassword ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
                className="w-56 h-9 rounded-md border border-primary/40 bg-background/50 px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
              />
              <button onClick={() => setShowPassword(!showPassword)} className="text-muted-foreground hover:text-foreground transition-colors">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="py-3 border-b border-border/30 last:border-0">
      <div className="flex items-center justify-between">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {locked ? (
            <>
              <div className="flex items-center gap-1.5 px-3 h-9 rounded-md border border-border/50 bg-muted/20">
                <span className="text-sm font-mono text-foreground">{value}</span>
                {suffix && <span className="text-xs text-muted-foreground font-mono">{suffix}</span>}
              </div>
              <button onClick={onUnlock} className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors" title="Unlock to edit">
                <Lock className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <input type="number" value={value} onChange={(e) => onChange(e.target.value)} min={min} max={max} step={step ?? 0.1}
                className="w-24 h-9 rounded-md border border-primary/40 bg-background/50 px-3 text-sm font-mono text-right text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
              />
              {suffix && <span className="text-xs text-muted-foreground font-mono w-6">{suffix}</span>}
            </>
          )}
        </div>
      </div>
      {hasSuggestion && (
        <div data-ai-suggestion className="flex items-center justify-end gap-2 mt-1.5">
          <span className={cn("text-xs", suggestionHigher ? "text-emerald-500" : "text-amber-500")}>
            AI suggests: <span className="font-mono font-semibold">{aiSuggestion}</span>
          </span>
          {onApplySuggestion && (
            <button onClick={locked ? onUnlock : onApplySuggestion} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors">
              {locked ? "Unlock to Apply" : "Apply"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LiveModeConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-card border border-destructive/30 rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center"><AlertTriangle className="w-6 h-6 text-destructive" /></div>
          <div><h3 className="text-lg font-bold text-foreground">Switch to LIVE Trading</h3><p className="text-sm text-muted-foreground">This will use real money</p></div>
        </div>
        <div className="space-y-3 mb-6 text-sm text-muted-foreground">
          <p>You are about to switch to <span className="text-destructive font-bold">LIVE trading mode</span>. This means:</p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Real trades will be executed on your Deriv account</li>
            <li>Real money will be at risk</li>
            <li>All signals that pass filters will trigger live orders</li>
          </ul>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all">Cancel</button>
          <button onClick={onConfirm} className="flex-1 px-4 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-bold uppercase tracking-wider hover:bg-destructive/90 transition-all shadow-lg shadow-destructive/20">Confirm LIVE</button>
        </div>
      </motion.div>
    </div>
  );
}

function PaperResetConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-card border border-warning/30 rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center"><Trash2 className="w-6 h-6 text-warning" /></div>
          <div><h3 className="text-lg font-bold text-foreground">Reset Paper Trading</h3><p className="text-sm text-muted-foreground">This cannot be undone</p></div>
        </div>
        <div className="space-y-3 mb-6 text-sm text-muted-foreground">
          <p>This will permanently:</p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Delete all paper trades (open and closed)</li>
            <li>Reset paper P&L to zero</li>
            <li>Reset paper capital to the configured starting amount</li>
          </ul>
          <p className="text-xs">Demo and Real mode data will <span className="font-medium text-foreground">not</span> be affected.</p>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all">Cancel</button>
          <button onClick={onConfirm} className="flex-1 px-4 py-2.5 rounded-lg bg-warning text-warning-foreground text-sm font-bold uppercase tracking-wider hover:bg-warning/90 transition-all">Reset Paper</button>
        </div>
      </motion.div>
    </div>
  );
}

function FactoryResetConfirmDialog({ onConfirm, onCancel, resetting }: { onConfirm: () => void; onCancel: () => void; resetting: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-card border border-destructive/30 rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center"><Trash2 className="w-6 h-6 text-destructive" /></div>
          <div><h3 className="text-lg font-bold text-foreground">Factory Reset</h3><p className="text-sm text-muted-foreground">This cannot be undone</p></div>
        </div>
        <div className="space-y-3 mb-6 text-sm text-muted-foreground">
          <p>This will permanently delete:</p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>All candle data (full available history)</li>
            <li>All backtest results and AI optimisations</li>
            <li>All trades (paper, demo, and real)</li>
            <li>All settings (reset to defaults)</li>
          </ul>
          <p className="text-xs">Your API keys will be <span className="font-medium text-foreground">preserved</span>. After reset, the setup wizard will run again.</p>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={resetting} className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={resetting} className="flex-1 px-4 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-bold uppercase tracking-wider hover:bg-destructive/90 transition-all disabled:opacity-50">{resetting ? "Resetting..." : "Factory Reset"}</button>
        </div>
      </motion.div>
    </div>
  );
}

const ALL_INSTRUMENTS = [
  { symbol: "BOOM1000", label: "Boom 1000", category: "Boom/Crash" },
  { symbol: "CRASH1000", label: "Crash 1000", category: "Boom/Crash" },
  { symbol: "BOOM900", label: "Boom 900", category: "Boom/Crash" },
  { symbol: "CRASH900", label: "Crash 900", category: "Boom/Crash" },
  { symbol: "BOOM600", label: "Boom 600", category: "Boom/Crash" },
  { symbol: "CRASH600", label: "Crash 600", category: "Boom/Crash" },
  { symbol: "BOOM500", label: "Boom 500", category: "Boom/Crash" },
  { symbol: "CRASH500", label: "Crash 500", category: "Boom/Crash" },
  { symbol: "BOOM300", label: "Boom 300", category: "Boom/Crash" },
  { symbol: "CRASH300", label: "Crash 300", category: "Boom/Crash" },
  { symbol: "R_75", label: "Volatility 75", category: "Volatility" },
  { symbol: "R_100", label: "Volatility 100", category: "Volatility" },
];

const STRATEGY_FAMILIES = [
  { key: "trend_continuation", label: "Trend Continuation", desc: "Enters on pullbacks within established trends", subStrategies: ["Trend Pullback"] },
  { key: "mean_reversion", label: "Mean Reversion", desc: "Catches reversals after extreme moves or liquidity sweeps", subStrategies: ["Exhaustion Rebound", "Liquidity Sweep + Reversal"] },
  { key: "breakout_expansion", label: "Breakout / Expansion", desc: "Trades breakouts and explosive volatility moves", subStrategies: ["Volatility Breakout", "Volatility Expansion Capture"] },
  { key: "spike_event", label: "Spike / Event", desc: "Exploits Boom/Crash spike patterns deterministically", subStrategies: ["Spike Hazard Capture"] },
  { key: "trendline_breakout", label: "Trendline Breakout", desc: "Breakouts from dynamic trendlines with VWAP/pivot confluence", subStrategies: ["Trendline Breakout"] },
];

function InstrumentsPicker({ enabledSymbols, onChange, aiSuggestion, onApplySuggestion }: { enabledSymbols: string; onChange: (v: string) => void; aiSuggestion?: string; onApplySuggestion?: () => void }) {
  const enabled = new Set(enabledSymbols ? enabledSymbols.split(",").filter(Boolean) : ALL_INSTRUMENTS.map(i => i.symbol));
  const toggle = (sym: string) => { const next = new Set(enabled); if (next.has(sym)) next.delete(sym); else next.add(sym); onChange(Array.from(next).join(",")); };
  const categories = [...new Set(ALL_INSTRUMENTS.map(i => i.category))];
  const hasSuggestion = aiSuggestion !== undefined && aiSuggestion !== enabledSymbols;
  return (
    <div className="space-y-3">
      {categories.map(cat => (
        <div key={cat}>
          <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">{cat}</p>
          <div className="flex flex-wrap gap-2">
            {ALL_INSTRUMENTS.filter(i => i.category === cat).map(inst => (
              <button key={inst.symbol} onClick={() => toggle(inst.symbol)}
                className={cn("px-3 py-1.5 rounded-md text-xs font-medium border transition-all",
                  enabled.has(inst.symbol) ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted/30 border-border text-muted-foreground hover:border-primary/20"
                )}>{inst.label}</button>
            ))}
          </div>
        </div>
      ))}
      {hasSuggestion && (
        <div data-ai-suggestion className="flex items-center justify-end gap-2 mt-1.5">
          <span className="text-xs text-emerald-500">AI suggests different instrument selection</span>
          {onApplySuggestion && (
            <button onClick={onApplySuggestion} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors">Apply</button>
          )}
        </div>
      )}
    </div>
  );
}

function StrategyFamilySelector({ enabledStrategies, onChange, aiSuggestion, onApplySuggestion }: { enabledStrategies: string; onChange: (v: string) => void; aiSuggestion?: string; onApplySuggestion?: () => void }) {
  const parsed = enabledStrategies.split(",").filter(Boolean);
  const OLD_TO_FAMILY: Record<string, string> = { "trend-pullback": "trend_continuation", "exhaustion-rebound": "mean_reversion", "liquidity-sweep": "mean_reversion", "volatility-breakout": "breakout_expansion", "volatility-expansion": "breakout_expansion", "spike-hazard": "spike_event" };
  const migrated = new Set<string>();
  for (const p of parsed) { if (OLD_TO_FAMILY[p]) migrated.add(OLD_TO_FAMILY[p]); else migrated.add(p); }
  const enabled = migrated.size > 0 ? migrated : new Set(STRATEGY_FAMILIES.map(f => f.key));
  const toggle = (key: string) => { const next = new Set(enabled); if (next.has(key)) next.delete(key); else next.add(key); onChange(Array.from(next).join(",")); };
  const hasSuggestion = aiSuggestion !== undefined && aiSuggestion !== enabledStrategies;
  return (
    <div className="space-y-2">
      {STRATEGY_FAMILIES.map(family => (
        <button key={family.key} onClick={() => toggle(family.key)}
          className={cn("flex items-start gap-3 w-full p-3 rounded-lg border text-left transition-all",
            enabled.has(family.key) ? "bg-primary/5 border-primary/30" : "bg-muted/20 border-border hover:border-primary/20"
          )}>
          <div className={cn("w-4 h-4 mt-0.5 rounded border-2 flex items-center justify-center shrink-0 transition-colors",
            enabled.has(family.key) ? "bg-primary border-primary" : "border-muted-foreground/30"
          )}>{enabled.has(family.key) && <CheckCircle2 className="w-3 h-3 text-primary-foreground" />}</div>
          <div className="flex-1 min-w-0">
            <p className={cn("text-sm font-medium", enabled.has(family.key) ? "text-foreground" : "text-muted-foreground")}>{family.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{family.desc}</p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">Sub-strategies: {family.subStrategies.join(", ")}</p>
          </div>
        </button>
      ))}
      {hasSuggestion && (
        <div data-ai-suggestion className="flex items-center justify-end gap-2 mt-1.5">
          <span className="text-xs text-emerald-500">AI suggests different strategy selection</span>
          {onApplySuggestion && (
            <button onClick={onApplySuggestion} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors">Apply</button>
          )}
        </div>
      )}
    </div>
  );
}

function SectionSaveButton({ sectionKeys, form, saving, onSave }: { sectionKeys: string[]; form: Record<string, string>; saving: boolean; onSave: (keys: string[], overrides?: Record<string, string>) => void }) {
  return (
    <div className="pt-3 border-t border-border/30 mt-3">
      <button onClick={() => onSave(sectionKeys)} disabled={saving}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        {saving ? "Saving..." : "Save Section"}
      </button>
    </div>
  );
}

interface SetupStatus { hasToken: boolean; totalCandles: number; hasEnoughData: boolean; hasInitialBacktests: boolean; backtestCount: number; expectedBacktests: number; setupComplete: boolean; }
interface SetupProgress { phase: string; message?: string; overallPct?: number; candleTotal?: number; estRemainingSec?: number; btCompleted?: number; btTotal?: number; symbol?: string; symbolIndex?: number; totalSymbols?: number; candlesForSymbol?: number; grandTotal?: number; completed?: number; total?: number; estimatedSecondsRemaining?: number; settings?: Record<string, number>; backtestsCreated?: number; }
interface PreflightResult { derivDemo: { ok: boolean; error?: string }; derivReal: { ok: boolean; error?: string }; openai: { ok: boolean; error?: string }; }

function InitialSetupWizard({ onComplete, openAiKeySet }: { onComplete: () => void; openAiKeySet: boolean }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<"idle" | "preflight" | "backfill" | "analyse" | "optimise" | "done">("idle");
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const base = import.meta.env.BASE_URL || "/";

  const fetchStatus = async () => { try { const r = await fetch(`${base}api/setup/status`); if (r.ok) setStatus(await r.json()); } catch {} };
  useEffect(() => { fetchStatus(); }, []);

  const streamPhase = async (url: string): Promise<boolean> => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
    if (!response.body) throw new Error("No response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") return true;
        let data: SetupProgress | null = null;
        try { data = JSON.parse(raw); } catch { continue; }
        if (data) {
          setProgress(data);
          if (data.phase === "error") throw new Error(data.message ?? "Unknown error");
          if (data.phase?.startsWith("backfill")) setCurrentStep("backfill");
          else if (data.phase?.startsWith("backtest")) setCurrentStep("analyse");
          else if (data.phase === "optimising") setCurrentStep("optimise");
          else if (data.phase === "complete") setCurrentStep("done");
        }
      }
    }
    return true;
  };

  const handleRunPreflight = async () => {
    if (preflightRunning) return;
    setPreflightRunning(true); setPreflight(null);
    try { const r = await fetch(`${base}api/setup/preflight`, { method: "POST", headers: { "Content-Type": "application/json" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); setPreflight(await r.json()); }
    catch (err) { const msg = err instanceof Error ? err.message : "Preflight request failed."; setPreflight({ derivDemo: { ok: false, error: msg }, derivReal: { ok: false, error: msg }, openai: { ok: false, error: msg } }); }
    finally { setPreflightRunning(false); }
  };

  const handleStartSetup = async () => {
    if (running) return;
    setRunning(true);
    try {
      setCurrentStep("preflight"); setPreflightRunning(true); setPreflight(null);
      const preflightResp = await fetch(`${base}api/setup/preflight`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!preflightResp.ok) throw new Error(`Connection check request failed (HTTP ${preflightResp.status}).`);
      const preflightData: PreflightResult = await preflightResp.json();
      setPreflight(preflightData); setPreflightRunning(false);
      if (!preflightData.derivDemo.ok && !preflightData.derivReal.ok) throw new Error("No Deriv API connection succeeded.");
      await new Promise(r => setTimeout(r, 1500));
      setCurrentStep("backfill"); setProgress({ phase: "backfill_start", message: "Starting initialisation..." });
      await streamPhase(`${base}api/setup/initialise`);
      setCurrentStep("done"); setProgress(null);
      toast({ title: "Initial Setup Complete", description: "Data downloaded and strategies backtested. AI suggestions are ready for review in Settings." });
      fetchStatus(); onComplete();
    } catch (err) { setProgress({ phase: "error", message: err instanceof Error ? err.message : "Setup failed" }); setRunning(false); setCurrentStep("idle"); }
  };

  if (dismissed || status?.setupComplete) return null;
  if (!status) return null;
  const bothKeysConfigured = status.hasToken && openAiKeySet;
  const STEP_LABELS = [
    { key: "backfill", icon: Download, label: "Download all available trading history" },
    { key: "analyse", icon: FlaskConical, label: "Run all strategies as backtests" },
    { key: "done", icon: Sparkles, label: "AI generates suggestions (never changes settings)" },
  ] as const;
  const progressPct = progress?.overallPct ?? (currentStep === "done" ? 100 : 0);
  const isRunningPost = running && currentStep !== "preflight";
  const isPreflightPhase = running && currentStep === "preflight";

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
      <Card className="border-2 border-primary/40 bg-primary/5">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base"><Database className="w-4 h-4 text-primary" />{currentStep === "done" ? "Initial Setup Complete" : "Initial Setup Required"}</CardTitle>
            {!running && <button onClick={() => setDismissed(true)} className="text-muted-foreground hover:text-foreground transition-colors mt-0.5" title="Dismiss"><XCircle className="w-4 h-4" /></button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!running && currentStep === "idle" && (
            <>
              {!status.hasToken ? (
                <p className="text-sm text-muted-foreground">Enter your <span className="text-primary font-medium">Deriv API token</span> in the API Keys section below, then return here to run initial setup.</p>
              ) : !openAiKeySet ? (
                <p className="text-sm text-muted-foreground">Enter your <span className="text-primary font-medium">OpenAI API key</span> in the API Keys section below. Both keys are required before running initial setup.</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">Before trading, the system needs to download all available price history and run all strategies as backtests. The AI will then generate <span className="font-medium text-foreground">suggestions</span> (it will never change your settings automatically).</p>
                  <div className="flex flex-col gap-2 pl-1">
                    {STEP_LABELS.map(({ key, icon: Icon, label }) => <div key={key} className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="w-3.5 h-3.5 text-primary/70 shrink-0" />{label}</div>)}
                  </div>
                  <div className="flex items-center gap-2 pt-1"><p className="text-xs text-muted-foreground">{status.totalCandles > 0 ? `${status.totalCandles.toLocaleString()} candles already stored` : "No historical data yet"}</p></div>
                  {preflight && (
                    <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/50 bg-background/50">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Connection Check Results</p>
                      {[{ label: "Deriv Demo", result: preflight.derivDemo }, { label: "Deriv Real", result: preflight.derivReal }, { label: "OpenAI API", result: preflight.openai }].map(({ label, result }) => (
                        <div key={label} className="flex items-center gap-2 text-sm">
                          {result.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> : <XCircle className="w-4 h-4 text-destructive shrink-0" />}
                          <span className={result.ok ? "text-emerald-500 font-medium" : "text-destructive font-medium"}>{label}: {result.ok ? "Connected" : result.error}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-3 flex-wrap">
                    {bothKeysConfigured && (
                      <button onClick={handleRunPreflight} disabled={preflightRunning} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all disabled:opacity-50">
                        {preflightRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}{preflightRunning ? "Checking..." : "Check Connections"}
                      </button>
                    )}
                    <button onClick={handleStartSetup} disabled={!bothKeysConfigured} title={!bothKeysConfigured ? "Both Deriv API token and OpenAI API key must be configured" : undefined}
                      className={cn("flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all",
                        bothKeysConfigured ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-primary/40" : "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
                      )}><Zap className="w-4 h-4" />Run Initial Setup<ChevronRight className="w-4 h-4" /></button>
                  </div>
                </>
              )}
            </>
          )}
          {(isPreflightPhase || (running && preflight && currentStep !== "idle")) && !isRunningPost && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">{preflightRunning ? <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" /> : <Wifi className="w-4 h-4 text-primary shrink-0" />}<span className="text-sm font-medium text-foreground">{preflightRunning ? "Checking API connections..." : "Connection Check"}</span></div>
              {preflight && (
                <div className="flex flex-col gap-1.5">
                  {[{ label: "Deriv Demo", result: preflight.derivDemo }, { label: "Deriv Real", result: preflight.derivReal }, { label: "OpenAI", result: preflight.openai }].map(({ label, result }) => (
                    <div key={label} className="flex items-center gap-2 text-sm">
                      {result.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> : <XCircle className="w-4 h-4 text-destructive shrink-0" />}
                      <span className={result.ok ? "text-emerald-500" : "text-destructive"}>{label}: {result.ok ? "Connected" : result.error}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {isRunningPost && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {STEP_LABELS.map(({ key, icon: Icon, label }, i) => {
                  const isDone = currentStep === "done" || (key === "backfill" && (currentStep === "analyse" || currentStep === "optimise")) || (key === "analyse" && currentStep === "optimise");
                  const isActive = currentStep === key || (key === "done" && currentStep === "optimise");
                  return (
                    <React.Fragment key={key}>
                      <div className={cn("flex items-center gap-1.5 text-xs font-medium transition-colors", isDone ? "text-emerald-500" : isActive ? "text-primary" : "text-muted-foreground/40")}>
                        <Icon className="w-3.5 h-3.5 shrink-0" /><span className="hidden sm:inline">{label.split(" ").slice(0, 3).join(" ")}</span>
                      </div>
                      {i < STEP_LABELS.length - 1 && <div className={cn("flex-1 h-px", isDone ? "bg-emerald-500/40" : "bg-border/50")} />}
                    </React.Fragment>
                  );
                })}
              </div>
              <div className="space-y-1.5">
                <div className="w-full h-2 bg-border/40 rounded-full overflow-hidden"><motion.div className="h-full bg-primary rounded-full" initial={{ width: "0%" }} animate={{ width: `${progressPct}%` }} transition={{ ease: "easeOut" }} /></div>
                <p className="text-xs text-muted-foreground min-h-[1.25rem]">{progress?.message ?? "Working..."}{(progress?.estRemainingSec ?? progress?.estimatedSecondsRemaining ?? 0) > 5 ? ` · ~${Math.ceil((progress?.estRemainingSec ?? progress?.estimatedSecondsRemaining ?? 0) / 60)} min remaining` : ""}</p>
              </div>
              {progress?.phase === "error" && <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{progress.message}</span></div>}
            </div>
          )}
          {!running && progress?.phase === "error" && currentStep === "idle" && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{progress.message}</span></div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface SymbolDiag { configured: string; instrumentFamily: string; activeSymbolFound: boolean; apiSymbol: string | null; displayName: string | null; marketType: string | null; streaming: boolean; lastTickTs: number | null; lastTickValue: number | null; tickCount5min: number; stale: boolean; error: string | null; }
interface SymbolDiagResponse { summary: { total: number; valid: number; streaming: number; stale: number; errors: number }; symbols: SymbolDiag[]; }

function SymbolDiagnosticsPanel() {
  const [data, setData] = useState<SymbolDiagResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const base = import.meta.env.BASE_URL || "/";
  const fetchDiag = async () => { setLoading(true); try { const r = await fetch(`${base}api/diagnostics/symbols`); if (r.ok) setData(await r.json()); } catch {} setLoading(false); };
  const revalidate = async () => {
    setRevalidating(true);
    try { const r = await fetch(`${base}api/diagnostics/symbols/revalidate`, { method: "POST" }); if (r.ok) { const result = await r.json(); setData({ summary: { total: result.symbols.length, valid: result.symbols.filter((s: SymbolDiag) => s.activeSymbolFound).length, streaming: result.symbols.filter((s: SymbolDiag) => s.streaming).length, stale: result.symbols.filter((s: SymbolDiag) => s.stale).length, errors: result.symbols.filter((s: SymbolDiag) => s.error).length }, symbols: result.symbols }); } } catch {}
    setRevalidating(false);
  };
  useEffect(() => { fetchDiag(); }, []);
  const statusColor = (sym: SymbolDiag) => { if (sym.error && !sym.activeSymbolFound) return "text-red-500"; if (sym.stale) return "text-yellow-500"; if (sym.streaming) return "text-green-500"; return "text-muted-foreground"; };
  const statusIcon = (sym: SymbolDiag) => { if (sym.error && !sym.activeSymbolFound) return <XCircle className="w-3.5 h-3.5" />; if (sym.stale) return <AlertTriangle className="w-3.5 h-3.5" />; if (sym.streaming) return <Wifi className="w-3.5 h-3.5" />; return <Clock className="w-3.5 h-3.5" />; };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="w-4 h-4" />Symbol Stream Health</CardTitle></CardHeader>
        <CardContent>
          {loading && !data ? <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div> : data ? (
            <>
              <div className="grid grid-cols-5 gap-2 mb-4">
                {[{ label: "Total", value: data.summary.total, color: "text-foreground" }, { label: "Valid", value: data.summary.valid, color: "text-emerald-500" }, { label: "Streaming", value: data.summary.streaming, color: "text-green-500" }, { label: "Stale", value: data.summary.stale, color: "text-yellow-500" }, { label: "Errors", value: data.summary.errors, color: "text-red-500" }].map(s => (
                  <div key={s.label} className="text-center p-2 rounded-lg bg-muted/20 border border-border/30"><p className="text-[10px] text-muted-foreground uppercase">{s.label}</p><p className={cn("text-lg font-bold tabular-nums", s.color)}>{s.value}</p></div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border/50 text-muted-foreground"><th className="text-left py-2 font-medium">Symbol</th><th className="text-left py-2 font-medium">Status</th><th className="text-right py-2 font-medium">Last Tick</th><th className="text-right py-2 font-medium">Price</th><th className="text-right py-2 font-medium">Ticks/5min</th></tr></thead>
                  <tbody>
                    {data.symbols.map(sym => (
                      <tr key={sym.configured} className="border-b border-border/20 hover:bg-muted/10">
                        <td className="py-2 font-medium text-foreground">{sym.displayName || sym.configured}</td>
                        <td className="py-2"><span className={cn("flex items-center gap-1", statusColor(sym))}>{statusIcon(sym)}{sym.streaming ? "Live" : sym.stale ? "Stale" : sym.error ? "Error" : "Idle"}</span></td>
                        <td className="py-2 text-right text-muted-foreground tabular-nums">{sym.lastTickTs ? new Date(sym.lastTickTs).toLocaleTimeString() : "—"}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{sym.lastTickValue?.toFixed(2) ?? "—"}</td>
                        <td className="py-2 text-right tabular-nums">{sym.tickCount5min}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={fetchDiag} className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors">Refresh</button>
                <button onClick={revalidate} disabled={revalidating} className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50">{revalidating ? "Revalidating..." : "Revalidate All"}</button>
              </div>
            </>
          ) : <p className="text-sm text-muted-foreground">Unable to load diagnostics.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

type TabKey = "general" | "paper" | "demo" | "real" | "diagnostics";
const TABS: { key: TabKey; label: string; color: string }[] = [
  { key: "general", label: "General", color: "primary" },
  { key: "paper", label: "Paper Mode", color: "warning" },
  { key: "demo", label: "Demo USD", color: "primary" },
  { key: "real", label: "Real USD", color: "destructive" },
  { key: "diagnostics", label: "Diagnostics", color: "primary" },
];

const MODE_DESCRIPTIONS: Record<string, { title: string; desc: string; target: string; color: string }> = {
  paper: { title: "Paper Mode — Aggressive Learner", desc: "Enters trades fast, holds long, deploys maximum capital. This is your testing ground for maximum learning and profit potential.", target: "Target: ~120% monthly return", color: "warning" },
  demo: { title: "Demo Mode — Balanced Performer", desc: "Takes reasonable risks with moderate capital deployment. Shows you what sustainable high-return trading looks like.", target: "Target: ~80% monthly return", color: "primary" },
  real: { title: "Real Mode — Conservative Fortress", desc: "Selective entries, careful position sizing, strict risk controls. Protects your real capital while still targeting strong returns.", target: "Target: ~50% monthly return", color: "destructive" },
};

interface AiMetaInfo {
  weeklyAnalysisAt: string | null;
  suggestionTrend: string;
  tradesAnalyzed: number;
  observedWinRate: number;
  nextWeeklyAnalysis: string | null;
  optimisedAt: string | null;
  modeSuggestionCounts: Record<string, number>;
}

function SuggestionSummaryCard({ mode, form, suggestions, aiMeta }: { mode: "paper" | "demo" | "real"; form: Record<string, string>; suggestions: AiSuggestions; aiMeta: AiMetaInfo }) {
  const suggestionCount = Object.keys(suggestions).filter(k => k.startsWith(`${mode}_`) && suggestions[k] !== form[k]).length;
  const trendLabel = aiMeta.suggestionTrend === "more_aggressive" ? "More Aggressive" : aiMeta.suggestionTrend === "more_conservative" ? "More Conservative" : "Balanced";
  const trendColor = aiMeta.suggestionTrend === "more_aggressive" ? "text-emerald-500" : aiMeta.suggestionTrend === "more_conservative" ? "text-amber-500" : "text-muted-foreground";
  const trendIcon = aiMeta.suggestionTrend === "more_aggressive" ? "↑" : aiMeta.suggestionTrend === "more_conservative" ? "↓" : "→";
  const lastAnalysis = aiMeta.weeklyAnalysisAt || aiMeta.optimisedAt;

  if (suggestionCount === 0 && !lastAnalysis) return null;

  return (
    <Card className="border border-emerald-500/20 bg-emerald-500/5">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center gap-2 mb-3">
          <Bot className="w-4 h-4 text-emerald-500" />
          <span className="text-sm font-semibold text-foreground">AI Suggestions</span>
          {suggestionCount > 0 && (
            <span className="ml-auto px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs font-bold text-emerald-500">{suggestionCount} pending</span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground">Direction</p>
            <p className={cn("font-semibold mt-0.5", trendColor)}>{trendIcon} {trendLabel}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Trades Analyzed</p>
            <p className="font-semibold text-foreground mt-0.5">{aiMeta.tradesAnalyzed || "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Win Rate</p>
            <p className="font-semibold text-foreground mt-0.5">{aiMeta.observedWinRate > 0 ? `${(aiMeta.observedWinRate * 100).toFixed(1)}%` : "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Last Analysis</p>
            <p className="font-semibold text-foreground mt-0.5">{lastAnalysis ? new Date(lastAnalysis).toLocaleDateString() : "Not yet"}</p>
          </div>
        </div>
        {suggestionCount > 0 && (
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-muted-foreground">Unlock fields and look for green/amber badges to review individual suggestions.</p>
            <button
              onClick={() => {
                const els = document.querySelectorAll("[data-ai-suggestion]");
                els.forEach(el => {
                  el.classList.add("ring-2", "ring-emerald-500/50", "rounded-md", "bg-emerald-500/5");
                  setTimeout(() => el.classList.remove("ring-2", "ring-emerald-500/50", "rounded-md", "bg-emerald-500/5"), 3000);
                });
                const first = els[0];
                if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              className="ml-3 shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 font-medium transition-colors"
            >
              <Bot className="w-3 h-3" /> Review Suggestions
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ModeSettingsTab({ mode, form, update, suggestions, onApplySuggestion, unlockedSections, onUnlockSection, onSaveSection, saving, onPaperReset, aiMeta }: {
  mode: "paper" | "demo" | "real"; form: Record<string, string>; update: (key: string, value: string) => void;
  suggestions: AiSuggestions; onApplySuggestion: (key: string) => void;
  unlockedSections: Set<string>; onUnlockSection: (section: string) => void;
  onSaveSection: (keys: string[], overrides?: Record<string, string>) => void; saving: boolean; onPaperReset?: () => void;
  aiMeta: AiMetaInfo;
}) {
  const p = (key: string) => `${mode}_${key}`;
  const modeLabel = mode === "paper" ? "Paper" : mode === "demo" ? "Demo" : "Real";
  const defaults = V1_DEFAULTS[mode];
  const d = (key: string) => defaults[key] || "0";
  const modeInfo = MODE_DESCRIPTIONS[mode];

  const isLocked = (section: string) => !unlockedSections.has(`${mode}_${section}`);
  const handleUnlock = (section: string) => onUnlockSection(`${mode}_${section}`);

  return (
    <div className="space-y-6">
      <Card className={cn("border-2", `border-${modeInfo.color}/30`)}>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-base font-bold text-foreground">{modeInfo.title}</h3>
              <p className="text-sm text-muted-foreground mt-1">{modeInfo.desc}</p>
              <p className={cn("text-xs font-semibold mt-2", `text-${modeInfo.color}`)}>{modeInfo.target}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <SuggestionSummaryCard mode={mode} form={form} suggestions={suggestions} aiMeta={aiMeta} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Crosshair className="w-4 h-4" />Position Sizing</CardTitle></CardHeader>
          <CardContent>
            <SettingField label={`${modeLabel} Capital`} description={`Starting capital for ${modeLabel} mode`} value={form[p("capital")] || d("capital")} onChange={(v) => update(p("capital"), v)} suffix="$" min={100} step={100} locked={isLocked("position")} onUnlock={() => handleUnlock("position")} aiSuggestion={suggestions[p("capital")]} onApplySuggestion={() => onApplySuggestion(p("capital"))} />
            <SettingField label="Equity % Per Trade" description={`Percentage of capital risked per trade`} value={form[p("equity_pct_per_trade")] || d("equity_pct_per_trade")} onChange={(v) => update(p("equity_pct_per_trade"), v)} suffix="%" min={1} max={50} step={1} locked={isLocked("position")} onUnlock={() => handleUnlock("position")} aiSuggestion={suggestions[p("equity_pct_per_trade")]} onApplySuggestion={() => onApplySuggestion(p("equity_pct_per_trade"))} />
            <SettingField label="Max Simultaneous Trades" description={`Maximum open positions`} value={form[p("max_open_trades")] || d("max_open_trades")} onChange={(v) => update(p("max_open_trades"), v)} step={1} min={1} max={10} locked={isLocked("position")} onUnlock={() => handleUnlock("position")} aiSuggestion={suggestions[p("max_open_trades")]} onApplySuggestion={() => onApplySuggestion(p("max_open_trades"))} />
            <SettingField label="Allocation Mode" description="How aggressively capital is deployed" value={form[p("allocation_mode")] || d("allocation_mode")} onChange={(v) => update(p("allocation_mode"), v)} type="select" options={[{ value: "conservative", label: "Conservative" }, { value: "balanced", label: "Balanced" }, { value: "aggressive", label: "Aggressive" }]} locked={isLocked("position")} onUnlock={() => handleUnlock("position")} aiSuggestion={suggestions[p("allocation_mode")]} onApplySuggestion={() => onApplySuggestion(p("allocation_mode"))} />
            {!isLocked("position") && <SectionSaveButton sectionKeys={[p("capital"), p("equity_pct_per_trade"), p("max_open_trades"), p("allocation_mode")]} form={form} saving={saving} onSave={onSaveSection} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Target className="w-4 h-4" />Signal Quality Thresholds</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">Minimum quality thresholds for trade entry. Higher = fewer but better trades.</p>
            <SettingField label="Min Composite Score" description="Minimum composite score to allow a trade" value={form[p("min_composite_score")] || d("min_composite_score")} onChange={(v) => update(p("min_composite_score"), v)} min={50} max={100} step={1} locked={isLocked("quality")} onUnlock={() => handleUnlock("quality")} aiSuggestion={suggestions[p("min_composite_score")]} onApplySuggestion={() => onApplySuggestion(p("min_composite_score"))} />
            <SettingField label="Min Expected Value" description="Minimum EV threshold for signal acceptance" value={form[p("min_ev_threshold")] || d("min_ev_threshold")} onChange={(v) => update(p("min_ev_threshold"), v)} min={0.001} max={0.05} step={0.001} locked={isLocked("quality")} onUnlock={() => handleUnlock("quality")} aiSuggestion={suggestions[p("min_ev_threshold")]} onApplySuggestion={() => onApplySuggestion(p("min_ev_threshold"))} />
            <SettingField label="Min R:R Ratio" description="Minimum reward-to-risk ratio" value={form[p("min_rr_ratio")] || d("min_rr_ratio")} onChange={(v) => update(p("min_rr_ratio"), v)} suffix="x" min={1} max={10} step={0.5} locked={isLocked("quality")} onUnlock={() => handleUnlock("quality")} aiSuggestion={suggestions[p("min_rr_ratio")]} onApplySuggestion={() => onApplySuggestion(p("min_rr_ratio"))} />
            {!isLocked("quality") && <SectionSaveButton sectionKeys={[p("min_composite_score"), p("min_ev_threshold"), p("min_rr_ratio")]} form={form} saving={saving} onSave={onSaveSection} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="w-4 h-4" />Trade Management (V2)</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p><strong>TP/SL:</strong> Dynamically calculated using S/R levels + Fibonacci confluence (not configurable — adapts to market structure).</p>
              <p><strong>Trailing Stop:</strong> 30% drawdown from peak unrealized profit. Activates only when trade is in profit.</p>
              <p><strong>Time Exits:</strong> 72h profitable = close. 168h hard cap. Negative trades wait for first profit after 72h.</p>
              <p><strong>Entry:</strong> One position per symbol. No multi-stage building.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Shield className="w-4 h-4" />Risk Controls</CardTitle></CardHeader>
          <CardContent>
            <SettingField label="Max Daily Loss" description={`Trading halts for the day`} value={form[p("max_daily_loss_pct")] || d("max_daily_loss_pct")} onChange={(v) => update(p("max_daily_loss_pct"), v)} suffix="%" min={0.5} max={25} step={0.5} locked={isLocked("risk")} onUnlock={() => handleUnlock("risk")} aiSuggestion={suggestions[p("max_daily_loss_pct")]} onApplySuggestion={() => onApplySuggestion(p("max_daily_loss_pct"))} />
            <SettingField label="Max Weekly Loss" description={`Trading halts for the week`} value={form[p("max_weekly_loss_pct")] || d("max_weekly_loss_pct")} onChange={(v) => update(p("max_weekly_loss_pct"), v)} suffix="%" min={1} max={50} step={0.5} locked={isLocked("risk")} onUnlock={() => handleUnlock("risk")} aiSuggestion={suggestions[p("max_weekly_loss_pct")]} onApplySuggestion={() => onApplySuggestion(p("max_weekly_loss_pct"))} />
            <SettingField label="Max Drawdown" description={`Kill switch triggers at this drawdown`} value={form[p("max_drawdown_pct")] || d("max_drawdown_pct")} onChange={(v) => update(p("max_drawdown_pct"), v)} suffix="%" min={1} max={50} step={1} locked={isLocked("risk")} onUnlock={() => handleUnlock("risk")} aiSuggestion={suggestions[p("max_drawdown_pct")]} onApplySuggestion={() => onApplySuggestion(p("max_drawdown_pct"))} />
            {!isLocked("risk") && <SectionSaveButton sectionKeys={[p("max_daily_loss_pct"), p("max_weekly_loss_pct"), p("max_drawdown_pct")]} form={form} saving={saving} onSave={onSaveSection} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Download className="w-4 h-4" />Capital Extraction</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">When capital grows by the target %, extract profits and reset to starting capital.</p>
            <SettingField label="Extraction Target" description="Extract profits when capital grows by this %" value={form[p("extraction_target_pct")] || d("extraction_target_pct")} onChange={(v) => update(p("extraction_target_pct"), v)} suffix="%" min={10} max={200} step={5} locked={isLocked("extraction")} onUnlock={() => handleUnlock("extraction")} aiSuggestion={suggestions[p("extraction_target_pct")]} onApplySuggestion={() => onApplySuggestion(p("extraction_target_pct"))} />
            <SettingField label="Auto-Extract" description="Automatically extract when target is reached" value={form[p("auto_extraction")] || d("auto_extraction")} onChange={(v) => update(p("auto_extraction"), v)} type="toggle" locked={isLocked("extraction")} onUnlock={() => handleUnlock("extraction")} aiSuggestion={suggestions[p("auto_extraction")]} onApplySuggestion={() => onApplySuggestion(p("auto_extraction"))} />
            {!isLocked("extraction") && <SectionSaveButton sectionKeys={[p("extraction_target_pct"), p("auto_extraction")]} form={form} saving={saving} onSave={onSaveSection} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Shield className="w-4 h-4" />Correlation Controls</CardTitle></CardHeader>
          <CardContent>
            <SettingField label="Correlated Family Cap" description="Max simultaneous trades in the same instrument family" value={form[p("correlated_family_cap")] || d("correlated_family_cap")} onChange={(v) => update(p("correlated_family_cap"), v)} min={1} max={6} step={1} locked={isLocked("correlation")} onUnlock={() => handleUnlock("correlation")} aiSuggestion={suggestions[p("correlated_family_cap")]} onApplySuggestion={() => onApplySuggestion(p("correlated_family_cap"))} />
            {!isLocked("correlation") && <SectionSaveButton sectionKeys={[p("correlated_family_cap")]} form={form} saving={saving} onSave={onSaveSection} />}
          </CardContent>
        </Card>
      </div>


      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Crosshair className="w-4 h-4" />Instruments</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">Select which synthetic indices {modeLabel} mode will scan and trade.</p>
          {isLocked("instruments") ? (
            <div>
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-muted/10">
                <span className="text-sm text-muted-foreground">{(form[p("enabled_symbols")] || form.enabled_symbols || "").split(",").filter(Boolean).length} instruments enabled</span>
                <button onClick={() => handleUnlock("instruments")} className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors" title="Unlock to edit">
                  <Lock className="w-3.5 h-3.5" />
                </button>
              </div>
              {suggestions[p("enabled_symbols")] && suggestions[p("enabled_symbols")] !== (form[p("enabled_symbols")] || form.enabled_symbols || "") && (
                <div data-ai-suggestion className="flex items-center justify-end gap-2 mt-1.5">
                  <span className="text-xs text-emerald-500">AI suggests different instrument selection</span>
                  <button onClick={() => handleUnlock("instruments")} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors">Unlock to Apply</button>
                </div>
              )}
            </div>
          ) : (
            <>
              <InstrumentsPicker enabledSymbols={form[p("enabled_symbols")] || form.enabled_symbols || ""} onChange={(v) => update(p("enabled_symbols"), v)} aiSuggestion={suggestions[p("enabled_symbols")]} onApplySuggestion={() => onApplySuggestion(p("enabled_symbols"))} />
              <SectionSaveButton sectionKeys={[p("enabled_symbols")]} form={form} saving={saving} onSave={onSaveSection} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="w-4 h-4" />Strategies</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">Enable or disable strategies for {modeLabel} mode.</p>
          {isLocked("strategies") ? (
            <div>
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-muted/10">
                <span className="text-sm text-muted-foreground">{(form[p("enabled_strategies")] ?? STRATEGY_FAMILIES.map(f => f.key).join(",")).split(",").filter(Boolean).length} strategy families enabled</span>
                <button onClick={() => handleUnlock("strategies")} className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors" title="Unlock to edit">
                  <Lock className="w-3.5 h-3.5" />
                </button>
              </div>
              {suggestions[p("enabled_strategies")] && suggestions[p("enabled_strategies")] !== (form[p("enabled_strategies")] ?? STRATEGY_FAMILIES.map(f => f.key).join(",")) && (
                <div data-ai-suggestion className="flex items-center justify-end gap-2 mt-1.5">
                  <span className="text-xs text-emerald-500">AI suggests different strategy selection</span>
                  <button onClick={() => handleUnlock("strategies")} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors">Unlock to Apply</button>
                </div>
              )}
            </div>
          ) : (
            <>
              <StrategyFamilySelector enabledStrategies={form[p("enabled_strategies")] ?? STRATEGY_FAMILIES.map(f => f.key).join(",")} onChange={(v) => update(p("enabled_strategies"), v)} aiSuggestion={suggestions[p("enabled_strategies")]} onApplySuggestion={() => onApplySuggestion(p("enabled_strategies"))} />
              <SectionSaveButton sectionKeys={[p("enabled_strategies")]} form={form} saving={saving} onSave={onSaveSection} />
            </>
          )}
        </CardContent>
      </Card>

      {mode === "paper" && onPaperReset && (
        <Card className="border-warning/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Reset Paper Trading</p>
                <p className="text-xs text-muted-foreground mt-0.5">Delete all paper trades and reset capital to configured starting amount</p>
              </div>
              <button onClick={onPaperReset} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-warning/50 text-warning text-sm font-medium hover:bg-warning/10 transition-all">
                <Trash2 className="w-4 h-4" />Reset Paper
              </button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetSettings({ query: { staleTime: 0 } });
  const { data: accountInfo } = useGetAccountInfo({ query: { refetchInterval: 30000 } });

  const [form, setForm] = useState<Record<string, string>>({});
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [showPaperReset, setShowPaperReset] = useState(false);
  const [showFactoryReset, setShowFactoryReset] = useState(false);
  const [factoryResetting, setFactoryResetting] = useState(false);
  const [aiHealth, setAiHealth] = useState<{ configured: boolean; working: boolean; error?: string } | null>(null);
  const [aiHealthLoading, setAiHealthLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("general");
  const [saving, setSaving] = useState(false);

  const [suggestions, setSuggestions] = useState<AiSuggestions>({});
  const [aiMeta, setAiMeta] = useState<{
    weeklyAnalysisAt: string | null;
    suggestionTrend: string;
    tradesAnalyzed: number;
    observedWinRate: number;
    nextWeeklyAnalysis: string | null;
    optimisedAt: string | null;
    modeSuggestionCounts: Record<string, number>;
  }>({ weeklyAnalysisAt: null, suggestionTrend: "neutral", tradesAnalyzed: 0, observedWinRate: 0, nextWeeklyAnalysis: null, optimisedAt: null, modeSuggestionCounts: {} });
  const [unlockedSections, setUnlockedSections] = useState<Set<string>>(new Set());
  const [unlockTarget, setUnlockTarget] = useState<string | null>(null);

  const base = import.meta.env.BASE_URL || "/";

  const fetchSuggestions = useCallback(async () => {
    try {
      const resp = await fetch(`${base}api/settings/ai-status`);
      if (resp.ok) {
        const data = await resp.json();
        setSuggestions(data.aiSuggestions || {});
        setAiMeta({
          weeklyAnalysisAt: data.weeklyAnalysisAt || null,
          suggestionTrend: data.suggestionTrend || "neutral",
          tradesAnalyzed: data.tradesAnalyzed || 0,
          observedWinRate: data.observedWinRate || 0,
          nextWeeklyAnalysis: data.nextWeeklyAnalysis || null,
          optimisedAt: data.optimisedAt || null,
          modeSuggestionCounts: data.modeSuggestionCounts || {},
        });
      }
    } catch {}
  }, [base]);

  useEffect(() => {
    if (settings) {
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(settings)) {
        if (v != null) mapped[k] = String(v);
      }
      setForm(mapped);
    }
  }, [settings]);

  useEffect(() => { fetchSuggestions(); }, [fetchSuggestions]);

  const handleUnlockSection = (section: string) => {
    setUnlockTarget(section);
  };

  const confirmUnlock = () => {
    if (unlockTarget) {
      setUnlockedSections(prev => new Set([...prev, unlockTarget]));
      setUnlockTarget(null);
    }
  };

  const handleApplySuggestion = async (key: string) => {
    try {
      const resp = await fetch(`${base}api/settings/ai-apply-suggestion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setForm(prev => ({ ...prev, [key]: data.value }));
        toast({ title: "Suggestion applied", description: `${key.replace(/_/g, " ")} updated to ${data.value}` });
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        fetchSuggestions();
      }
    } catch {
      toast({ title: "Failed to apply suggestion", variant: "destructive" });
    }
  };

  const handleSaveSection = async (keys: string[], overrides?: Record<string, string>) => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const key of keys) {
        if (overrides && key in overrides) { payload[key] = overrides[key]; }
        else if (form[key] !== undefined) { payload[key] = form[key]; }
      }
      const resp = await fetch(`${base}api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Section saved", description: `${keys.length} setting${keys.length > 1 ? "s" : ""} updated.` });
      } else {
        toast({ title: "Save failed", variant: "destructive" });
      }
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    }
    setSaving(false);
  };

  const update = (key: string, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const { mutate: toggleMode } = useToggleTradingMode({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        const resp = data as ActionResponse;
        toast({ title: "Mode toggled", description: resp.message || "Trading mode updated." });
      },
      onError: () => { toast({ title: "Toggle failed", variant: "destructive" }); },
    },
  });

  const handleToggleMode = (mode: "paper" | "demo" | "real", currentlyActive: boolean) => {
    if (mode === "real" && !currentlyActive) { setShowLiveConfirm(true); return; }
    toggleMode({ data: { mode: mode as ToggleTradingModeRequestMode, active: !currentlyActive } });
  };

  const confirmRealToggle = () => {
    setShowLiveConfirm(false);
    toggleMode({ data: { mode: "real" as ToggleTradingModeRequestMode, active: true, confirmed: true } });
  };

  const handlePaperReset = async () => {
    setShowPaperReset(false);
    try {
      const resp = await fetch(`${base}api/settings/paper-reset`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await resp.json();
      if (data.success) { toast({ title: "Paper Reset Complete", description: data.message }); queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() }); }
      else { toast({ title: "Reset failed", description: data.message, variant: "destructive" }); }
    } catch { toast({ title: "Reset failed", variant: "destructive" }); }
  };

  const handleFactoryReset = async () => {
    setFactoryResetting(true);
    try {
      const resp = await fetch(`${base}api/setup/reset`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await resp.json();
      if (data.success) { toast({ title: "Factory Reset Complete", description: "Redirecting to setup wizard..." }); setTimeout(() => { window.location.reload(); }, 1500); }
      else { toast({ title: "Reset failed", description: data.message, variant: "destructive" }); }
    } catch { toast({ title: "Reset failed", variant: "destructive" }); }
    finally { setFactoryResetting(false); setShowFactoryReset(false); }
  };

  const paperActive = form.paper_mode_active === "true";
  const demoActive = form.demo_mode_active === "true";
  const realActive = form.real_mode_active === "true";

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <AnimatePresence>
        {showLiveConfirm && <LiveModeConfirmDialog onConfirm={confirmRealToggle} onCancel={() => setShowLiveConfirm(false)} />}
        {showPaperReset && <PaperResetConfirmDialog onConfirm={handlePaperReset} onCancel={() => setShowPaperReset(false)} />}
        {showFactoryReset && <FactoryResetConfirmDialog onConfirm={handleFactoryReset} onCancel={() => setShowFactoryReset(false)} resetting={factoryResetting} />}
        {unlockTarget && <UnlockWarningDialog settingLabel={unlockTarget.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())} onConfirm={confirmUnlock} onCancel={() => setUnlockTarget(null)} />}
      </AnimatePresence>

      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Configure trading parameters, API keys, and risk controls</p>
      </div>

      <div className="flex border-b border-border/50 gap-0">
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          let indicator = null;
          if (tab.key === "paper" && paperActive) indicator = "warning";
          if (tab.key === "demo" && demoActive) indicator = "primary";
          if (tab.key === "real" && realActive) indicator = "destructive";
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={cn("relative px-5 py-3 text-sm font-medium transition-colors", isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              <div className="flex items-center gap-2">
                {indicator && <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: `hsl(var(--${indicator}))` }} />}
                {tab.label}
              </div>
              {isActive && <motion.div layoutId="settings-tab-indicator" className="absolute bottom-0 left-0 right-0 h-0.5" style={{ backgroundColor: `hsl(var(--${tab.color}))` }} transition={{ type: "spring", stiffness: 400, damping: 30 }} />}
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
          {activeTab === "general" && (
            <div className="space-y-6">
              <AnimatePresence>
                <InitialSetupWizard openAiKeySet={form.openai_api_key_set === "true"} onComplete={() => { queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() }); fetchSuggestions(); }} />
              </AnimatePresence>

              <Card className={cn("border-2", realActive ? "border-destructive/30" : (paperActive || demoActive) ? "border-warning/30" : "border-border/50")}>
                <CardHeader><CardTitle className="flex items-center gap-2"><Zap className="w-4 h-4" />Trading Modes</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-xs text-muted-foreground">Enable any combination of modes. Each runs independently with its own capital, positions, and risk limits.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {([
                      { key: "paper" as const, label: "Paper", desc: "Aggressive learner · ~120%/mo", active: paperActive, color: "warning" },
                      { key: "demo" as const, label: "Demo", desc: "Balanced performer · ~80%/mo", active: demoActive, color: "primary" },
                      { key: "real" as const, label: "Real", desc: "Conservative fortress · ~50%/mo", active: realActive, color: "destructive" },
                    ]).map(({ key, label, desc, active, color }) => (
                      <button key={key} onClick={() => handleToggleMode(key, active)}
                        className={cn("flex flex-col items-start gap-1 p-4 rounded-xl border-2 text-left transition-all", active ? "" : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground")}
                        style={active ? { backgroundColor: `hsl(var(--${color}) / 0.1)`, borderColor: `hsl(var(--${color}))`, color: `hsl(var(--${color}))` } : undefined}
                      >
                        <div className="flex items-center gap-2">
                          <div className={cn("w-2.5 h-2.5 rounded-full", active ? "animate-pulse" : "bg-muted-foreground/30")} style={active ? { backgroundColor: `hsl(var(--${color}))` } : undefined} />
                          <span className="text-sm font-bold uppercase tracking-wider">{label}</span>
                        </div>
                        <span className="text-xs opacity-70">{desc}</span>
                        <span className="text-[10px] font-semibold uppercase mt-1">{active ? "Active" : "Inactive"}</span>
                      </button>
                    ))}
                  </div>
                  {realActive && (
                    <div className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg flex items-center gap-2 text-destructive text-sm">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      <span className="font-medium">REAL MODE ACTIVE — Real trades will execute on your Deriv account</span>
                    </div>
                  )}
                  {accountInfo?.connected && accountInfo.balance != null && (
                    <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Deriv Account Balance</span>
                        <span className="font-mono font-bold text-foreground">{accountInfo.currency} {accountInfo.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><Key className="w-4 h-4" />API Keys</CardTitle></CardHeader>
                <CardContent>
                  <SettingField label="Deriv Demo Token" description={form.deriv_api_token_demo_set === "true" ? "Demo token is configured" : "API token for your Deriv demo account"} value={form.deriv_api_token_demo || ""} onChange={(v) => update("deriv_api_token_demo", v)} type="password" placeholder={form.deriv_api_token_demo_set === "true" ? "****configured****" : "Enter Deriv demo API token"} locked={!unlockedSections.has("apikeys")} onUnlock={() => handleUnlockSection("apikeys")} />
                  <SettingField label="Deriv Real Token" description={form.deriv_api_token_real_set === "true" ? "Real token is configured" : "API token for your Deriv real account"} value={form.deriv_api_token_real || ""} onChange={(v) => update("deriv_api_token_real", v)} type="password" placeholder={form.deriv_api_token_real_set === "true" ? "****configured****" : "Enter Deriv real API token"} locked={!unlockedSections.has("apikeys")} onUnlock={() => handleUnlockSection("apikeys")} />
                  <SettingField label="OpenAI API Key" description={form.openai_api_key_set === "true" ? "Key is configured" : "Required for AI signal verification"} value={form.openai_api_key || ""} onChange={(v) => update("openai_api_key", v)} type="password" placeholder={form.openai_api_key_set === "true" ? "****configured****" : "Enter OpenAI API key (sk-...)"} locked={!unlockedSections.has("apikeys")} onUnlock={() => handleUnlockSection("apikeys")} />
                  <SettingField label="AI Signal Verification" description={form.openai_api_key_set === "true" ? "AI will review signals before trades" : "Requires OpenAI API key above"} value={form.ai_verification_enabled || "false"} onChange={(v) => update("ai_verification_enabled", v)} type="toggle" locked={!unlockedSections.has("apikeys")} onUnlock={() => handleUnlockSection("apikeys")} aiSuggestion={suggestions.ai_verification_enabled} onApplySuggestion={() => handleApplySuggestion("ai_verification_enabled")} />
                  {form.openai_api_key_set === "true" && (
                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border/30">
                      <button onClick={async () => { setAiHealthLoading(true); try { const resp = await fetch(`${base}api/settings/openai-health`); setAiHealth(await resp.json()); } catch { setAiHealth({ configured: false, working: false, error: "Request failed" }); } finally { setAiHealthLoading(false); } }} disabled={aiHealthLoading} className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50">
                        {aiHealthLoading ? "Testing..." : "Test Connection"}
                      </button>
                      {aiHealth && <span className={cn("text-xs font-medium", aiHealth.working ? "text-green-600" : "text-red-500")}>{aiHealth.working ? "Connected and working" : aiHealth.error || "Connection failed"}</span>}
                    </div>
                  )}
                  {unlockedSections.has("apikeys") && (
                    <SectionSaveButton sectionKeys={["deriv_api_token_demo", "deriv_api_token_real", "openai_api_key", "ai_verification_enabled"]} form={form} saving={saving} onSave={handleSaveSection} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><Crosshair className="w-4 h-4 text-primary" />Signal Scoring Thresholds</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground mb-3">These thresholds apply uniformly across all trading modes. Signals must pass all thresholds to be traded.</p>
                  <SettingField label="Minimum Composite Score" description="Signals must score at least this high (0-100)" value={form.min_composite_score || "80"} onChange={(v) => update("min_composite_score", v)} min={50} max={100} step={1} locked={!unlockedSections.has("scoring")} onUnlock={() => handleUnlockSection("scoring")} aiSuggestion={suggestions.min_composite_score} onApplySuggestion={() => handleApplySuggestion("min_composite_score")} />
                  <SettingField label="Minimum Expected Value" description="Minimum expected value required" value={form.min_ev_threshold || "0.003"} onChange={(v) => update("min_ev_threshold", v)} min={0} max={0.1} step={0.001} locked={!unlockedSections.has("scoring")} onUnlock={() => handleUnlockSection("scoring")} aiSuggestion={suggestions.min_ev_threshold} onApplySuggestion={() => handleApplySuggestion("min_ev_threshold")} />
                  <SettingField label="Minimum Reward/Risk Ratio" description="Minimum TP/SL ratio" value={form.min_rr_ratio || "3.0"} onChange={(v) => update("min_rr_ratio", v)} suffix="x" min={0.5} max={5} step={0.1} locked={!unlockedSections.has("scoring")} onUnlock={() => handleUnlockSection("scoring")} aiSuggestion={suggestions.min_rr_ratio} onApplySuggestion={() => handleApplySuggestion("min_rr_ratio")} />
                  <div className="border-t border-border/30 my-4" />
                  <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Dimension Weights (%)</p>
                  {[
                    { key: "scoring_weight_regime_fit", label: "Regime Fit", desc: "How well the market regime matches" },
                    { key: "scoring_weight_setup_quality", label: "Setup Quality", desc: "How cleanly entry conditions are met" },
                    { key: "scoring_weight_trend_alignment", label: "Trend Alignment", desc: "Higher-timeframe trend support" },
                    { key: "scoring_weight_volatility_condition", label: "Volatility Condition", desc: "Volatility in ideal range" },
                    { key: "scoring_weight_reward_risk", label: "Reward/Risk", desc: "R:R normalized score" },
                    { key: "scoring_weight_probability_of_success", label: "Probability of Success", desc: "Estimated probability of profit" },
                  ].map(w => (
                    <SettingField key={w.key} label={w.label} description={w.desc} value={form[w.key] || "16.67"} onChange={(v) => update(w.key, v)} suffix="%" min={0} max={100} step={1} locked={!unlockedSections.has("scoring")} onUnlock={() => handleUnlockSection("scoring")} aiSuggestion={suggestions[w.key]} onApplySuggestion={() => handleApplySuggestion(w.key)} />
                  ))}
                  {unlockedSections.has("scoring") && <SectionSaveButton sectionKeys={["min_composite_score", "min_ev_threshold", "min_rr_ratio", "scoring_weight_regime_fit", "scoring_weight_setup_quality", "scoring_weight_trend_alignment", "scoring_weight_volatility_condition", "scoring_weight_reward_risk", "scoring_weight_probability_of_success"]} form={form} saving={saving} onSave={handleSaveSection} />}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><Clock className="w-4 h-4" />Scan Timing</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground mb-3">Global scan timing — applies to all modes.</p>
                  <SettingField label="Scan Interval" description="How often the system scans for new signals" value={form.scan_interval_seconds || "30"} onChange={(v) => update("scan_interval_seconds", v)} suffix="sec" min={5} max={300} step={5} locked={!unlockedSections.has("scan")} onUnlock={() => handleUnlockSection("scan")} aiSuggestion={suggestions.scan_interval_seconds} onApplySuggestion={() => handleApplySuggestion("scan_interval_seconds")} />
                  <SettingField label="Symbol Scan Stagger" description="Delay between scanning each symbol" value={form.scan_stagger_seconds || "10"} onChange={(v) => update("scan_stagger_seconds", v)} suffix="sec" min={1} max={60} step={1} locked={!unlockedSections.has("scan")} onUnlock={() => handleUnlockSection("scan")} aiSuggestion={suggestions.scan_stagger_seconds} onApplySuggestion={() => handleApplySuggestion("scan_stagger_seconds")} />
                  {unlockedSections.has("scan") && <SectionSaveButton sectionKeys={["scan_interval_seconds", "scan_stagger_seconds"]} form={form} saving={saving} onSave={handleSaveSection} />}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><Shield className="w-4 h-4" />Global Controls</CardTitle></CardHeader>
                <CardContent>
                  <SettingField label="Kill Switch" description="Emergency stop — halts all trading across all modes" value={form.kill_switch || "false"} onChange={(v) => { update("kill_switch", v); handleSaveSection(["kill_switch"], { kill_switch: v }); }} type="toggle" locked={!unlockedSections.has("killswitch")} onUnlock={() => handleUnlockSection("killswitch")} />
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "paper" && (
            <ModeSettingsTab mode="paper" form={form} update={update} suggestions={suggestions} onApplySuggestion={handleApplySuggestion} unlockedSections={unlockedSections} onUnlockSection={handleUnlockSection} onSaveSection={handleSaveSection} saving={saving} onPaperReset={() => setShowPaperReset(true)} aiMeta={aiMeta} />
          )}

          {activeTab === "demo" && (
            <ModeSettingsTab mode="demo" form={form} update={update} suggestions={suggestions} onApplySuggestion={handleApplySuggestion} unlockedSections={unlockedSections} onUnlockSection={handleUnlockSection} onSaveSection={handleSaveSection} saving={saving} aiMeta={aiMeta} />
          )}

          {activeTab === "real" && (
            <ModeSettingsTab mode="real" form={form} update={update} suggestions={suggestions} onApplySuggestion={handleApplySuggestion} unlockedSections={unlockedSections} onUnlockSection={handleUnlockSection} onSaveSection={handleSaveSection} saving={saving} aiMeta={aiMeta} />
          )}

          {activeTab === "diagnostics" && <SymbolDiagnosticsPanel />}
        </motion.div>
      </AnimatePresence>

      <div className="mt-8 border border-destructive/20 rounded-xl p-6 bg-destructive/5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-destructive">Factory Reset</h3>
            <p className="text-xs text-muted-foreground mt-1">Clear all data, backtests, and settings. API keys are preserved. Re-runs the setup wizard from scratch.</p>
          </div>
          <button onClick={() => setShowFactoryReset(true)} className="px-4 py-2 rounded-lg border border-destructive/30 text-sm font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground transition-all">
            Factory Reset
          </button>
        </div>
      </div>
    </div>
  );
}
