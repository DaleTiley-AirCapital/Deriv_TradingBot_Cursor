import React, { useEffect, useState } from "react";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  useGetAccountInfo,
  useSetTradingMode,
  getGetAccountInfoQueryKey,
} from "@workspace/api-client-react";
import type { PlatformSettings, SetTradingModeRequestMode, ActionResponse } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui-elements";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Settings as SettingsIcon, Shield, TrendingUp, Clock, Crosshair, Save, RotateCcw, CheckCircle2, Key, Eye, EyeOff, AlertTriangle, Zap } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

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
}

function SettingField({ label, description, value, onChange, type = "number", options, suffix, min, max, step, placeholder }: SettingFieldProps) {
  const [showPassword, setShowPassword] = useState(false);

  if (type === "toggle") {
    const isOn = value === "true";
    return (
      <div className="flex items-center justify-between py-4 border-b border-border/30 last:border-0">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <button
          onClick={() => onChange(isOn ? "false" : "true")}
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
            isOn ? "bg-destructive" : "bg-muted"
          )}
        >
          <span className={cn(
            "inline-block h-4 w-4 rounded-full bg-white transition-transform shadow-sm",
            isOn ? "translate-x-6" : "translate-x-1"
          )} />
        </button>
      </div>
    );
  }

  if (type === "select" && options) {
    return (
      <div className="flex items-center justify-between py-4 border-b border-border/30 last:border-0">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex gap-1.5">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium uppercase tracking-wider transition-all border",
                value === opt.value
                  ? "bg-primary/10 border-primary text-primary"
                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (type === "password") {
    return (
      <div className="flex items-center justify-between py-4 border-b border-border/30 last:border-0">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type={showPassword ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-56 h-9 rounded-md border border-border bg-background/50 px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
          />
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-4 border-b border-border/30 last:border-0">
      <div className="flex-1 pr-4">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={min}
          max={max}
          step={step ?? 0.1}
          className="w-24 h-9 rounded-md border border-border bg-background/50 px-3 text-sm font-mono text-right text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
        />
        {suffix && <span className="text-xs text-muted-foreground font-mono w-6">{suffix}</span>}
      </div>
    </div>
  );
}

function LiveModeConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-card border border-destructive/30 rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-destructive" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-foreground">Switch to LIVE Trading</h3>
            <p className="text-sm text-muted-foreground">This will use real money</p>
          </div>
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
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-bold uppercase tracking-wider hover:bg-destructive/90 transition-all shadow-lg shadow-destructive/20"
          >
            Confirm LIVE
          </button>
        </div>
      </motion.div>
    </div>
  );
}

const ALL_INSTRUMENTS = [
  { symbol: "BOOM1000", label: "Boom 1000", category: "Boom/Crash" },
  { symbol: "CRASH1000", label: "Crash 1000", category: "Boom/Crash" },
  { symbol: "BOOM500", label: "Boom 500", category: "Boom/Crash" },
  { symbol: "CRASH500", label: "Crash 500", category: "Boom/Crash" },
  { symbol: "R_75", label: "Volatility 75", category: "Volatility" },
  { symbol: "R_100", label: "Volatility 100", category: "Volatility" },
  { symbol: "JD75", label: "Jump Diffusion 75", category: "Exotic" },
  { symbol: "STPIDX", label: "Step Index", category: "Exotic" },
  { symbol: "RDBEAR", label: "Bear Market", category: "Exotic" },
];

function InstrumentsPicker({ enabledSymbols, onChange }: { enabledSymbols: string; onChange: (v: string) => void }) {
  const enabled = new Set(enabledSymbols ? enabledSymbols.split(",").filter(Boolean) : ALL_INSTRUMENTS.map(i => i.symbol));
  const toggle = (sym: string) => {
    const next = new Set(enabled);
    if (next.has(sym)) next.delete(sym);
    else next.add(sym);
    onChange(Array.from(next).join(","));
  };
  const categories = [...new Set(ALL_INSTRUMENTS.map(i => i.category))];
  return (
    <div className="space-y-3">
      {categories.map(cat => (
        <div key={cat}>
          <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">{cat}</p>
          <div className="flex flex-wrap gap-2">
            {ALL_INSTRUMENTS.filter(i => i.category === cat).map(inst => (
              <button
                key={inst.symbol}
                onClick={() => toggle(inst.symbol)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium border transition-all",
                  enabled.has(inst.symbol)
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "bg-muted/30 border-border text-muted-foreground hover:border-primary/20"
                )}
              >
                {inst.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetSettings({ query: { staleTime: 0 } });
  const { data: accountInfo } = useGetAccountInfo({ query: { refetchInterval: 30000 } });

  const [form, setForm] = useState<Record<string, string>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [aiHealth, setAiHealth] = useState<{ configured: boolean; working: boolean; error?: string } | null>(null);
  const [aiHealthLoading, setAiHealthLoading] = useState(false);

  useEffect(() => {
    if (settings) {
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(settings)) {
        if (v != null) mapped[k] = String(v);
      }
      setForm(mapped);
      setHasChanges(false);
    }
  }, [settings]);

  const { mutate: save, isPending: saving } = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAccountInfoQueryKey() });
        setHasChanges(false);
        toast({ title: "Settings saved", description: "Changes will take effect on the next scheduler cycle." });
      },
      onError: () => {
        toast({ title: "Save failed", description: "Could not save settings. Please try again.", variant: "destructive" });
      },
    },
  });

  const { mutate: setMode } = useSetTradingMode({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        const resp = data as ActionResponse;
        toast({ title: "Mode changed", description: resp.message || "Trading mode updated." });
      },
      onError: () => {
        toast({ title: "Mode change failed", variant: "destructive" });
      },
    },
  });

  const update = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = () => {
    const payload: PlatformSettings = { ...form };
    save({ data: payload });
  };

  const handleReset = () => {
    if (settings) {
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(settings)) {
        if (v != null) mapped[k] = String(v);
      }
      setForm(mapped);
      setHasChanges(false);
    }
  };

  const handleModeSwitch = (newMode: string) => {
    if (newMode === "live") {
      setShowLiveConfirm(true);
      return;
    }
    setMode({ data: { mode: newMode as SetTradingModeRequestMode } });
  };

  const confirmLiveMode = () => {
    setShowLiveConfirm(false);
    setMode({ data: { mode: "live" as SetTradingModeRequestMode, confirmed: true } });
  };

  const currentMode = form.trading_mode || "idle";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <AnimatePresence>
        {showLiveConfirm && (
          <LiveModeConfirmDialog
            onConfirm={confirmLiveMode}
            onCancel={() => setShowLiveConfirm(false)}
          />
        )}
      </AnimatePresence>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Configure trading parameters, API keys, and risk controls</p>
        </div>
        <div className="flex items-center gap-3">
          {hasChanges && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
            >
              <RotateCcw className="w-4 h-4" />
              Discard
            </motion.button>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={cn(
              "flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all",
              hasChanges
                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-primary/40"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            )}
          >
            {saving ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
            ) : hasChanges ? (
              <Save className="w-4 h-4" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            {saving ? "Saving..." : hasChanges ? "Save Changes" : "Saved"}
          </button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
        <Card className={cn(
          "border-2",
          currentMode === "live" ? "border-destructive/30" :
          currentMode === "paper" ? "border-warning/30" : "border-border/50"
        )}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-4 h-4" />
              Trading Mode
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-foreground">Current Mode</p>
                <p className="text-xs text-muted-foreground mt-0.5">Switch between paper trading (simulated) and live trading (real money)</p>
              </div>
              <div className="flex gap-2">
                {["idle", "paper", "live"].map((m) => (
                  <button
                    key={m}
                    onClick={() => handleModeSwitch(m)}
                    className={cn(
                      "px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all border-2",
                      currentMode === m
                        ? m === "live"
                          ? "bg-destructive/10 border-destructive text-destructive"
                          : m === "paper"
                            ? "bg-warning/10 border-warning text-warning"
                            : "bg-muted border-border text-muted-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {currentMode === "live" && (
              <div className="mt-3 p-3 bg-destructive/5 border border-destructive/20 rounded-lg flex items-center gap-2 text-destructive text-sm">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span className="font-medium">LIVE MODE ACTIVE — Real trades will execute on your Deriv account</span>
              </div>
            )}
            {accountInfo?.connected && accountInfo.balance != null && (
              <div className="mt-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Deriv Account Balance</span>
                  <span className="font-mono font-bold text-foreground">
                    {accountInfo.currency} {accountInfo.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="w-4 h-4" />
              API Keys
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SettingField
              label="Deriv API Token"
              description={form.deriv_api_token_set === "true" ? "Token is configured" : "Enter your Deriv API token for live trading and account data"}
              value={form.deriv_api_token || ""}
              onChange={(v) => update("deriv_api_token", v)}
              type="password"
              placeholder={form.deriv_api_token_set === "true" ? "****configured****" : "Enter Deriv API token"}
            />
            <SettingField
              label="OpenAI API Key"
              description={form.openai_api_key_set === "true" ? "Key is configured" : "Required for AI signal verification (separate from ChatGPT Pro subscription)"}
              value={form.openai_api_key || ""}
              onChange={(v) => update("openai_api_key", v)}
              type="password"
              placeholder={form.openai_api_key_set === "true" ? "****configured****" : "Enter OpenAI API key (sk-...)"}
            />
            <SettingField
              label="AI Signal Verification"
              description={form.openai_api_key_set === "true" 
                ? "OpenAI key configured — AI will review signals before trades open"
                : "Requires OpenAI API key above — set it first to enable AI verification"}
              value={form.ai_verification_enabled || "false"}
              onChange={(v) => update("ai_verification_enabled", v)}
              type="toggle"
            />
            {form.openai_api_key_set === "true" && (
              <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border/30">
                <button
                  onClick={async () => {
                    setAiHealthLoading(true);
                    try {
                      const base = import.meta.env.BASE_URL || "/";
                      const resp = await fetch(`${base}api/settings/openai-health`);
                      const data = await resp.json();
                      setAiHealth(data);
                    } catch {
                      setAiHealth({ configured: false, working: false, error: "Request failed" });
                    } finally {
                      setAiHealthLoading(false);
                    }
                  }}
                  disabled={aiHealthLoading}
                  className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50"
                >
                  {aiHealthLoading ? "Testing..." : "Test Connection"}
                </button>
                {aiHealth && (
                  <span className={cn("text-xs font-medium", aiHealth.working ? "text-green-600" : "text-red-500")}>
                    {aiHealth.working ? "Connected and working" : aiHealth.error || "Connection failed"}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Crosshair className="w-4 h-4" />
                Position Sizing
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SettingField
                label="Max Simultaneous Trades"
                description="Maximum number of open positions at any time"
                value={form.max_open_trades || "4"}
                onChange={(v) => update("max_open_trades", v)}
                step={1}
                min={1}
                max={20}
              />
              <SettingField
                label="Equity % Per Trade"
                description="Default percentage of total capital risked on each trade"
                value={form.equity_pct_per_trade || "2"}
                onChange={(v) => update("equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Paper Mode — Equity %"
                description="Position size when trading in paper mode (simulated)"
                value={form.paper_equity_pct_per_trade || "1"}
                onChange={(v) => update("paper_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Live Mode — Equity %"
                description="Position size when trading in live mode (real money)"
                value={form.live_equity_pct_per_trade || "2"}
                onChange={(v) => update("live_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Paper Mode — Max Trades"
                description="Max open positions in paper mode"
                value={form.paper_max_open_trades || "4"}
                onChange={(v) => update("paper_max_open_trades", v)}
                step={1}
                min={1}
                max={20}
              />
              <SettingField
                label="Live Mode — Max Trades"
                description="Max open positions in live mode"
                value={form.live_max_open_trades || "3"}
                onChange={(v) => update("live_max_open_trades", v)}
                step={1}
                min={1}
                max={20}
              />
              <SettingField
                label="Total Capital"
                description="The amount you plan to deposit and trade with (e.g. $600). This is used to calculate how much to risk per trade. Set it to your intended deposit — not your total net worth."
                value={form.total_capital || "10000"}
                onChange={(v) => update("total_capital", v)}
                suffix="$"
                min={100}
                step={100}
              />
              <SettingField
                label="Allocation Mode"
                description="Controls how aggressively capital is deployed on signals"
                value={form.allocation_mode || "balanced"}
                onChange={(v) => update("allocation_mode", v)}
                type="select"
                options={[
                  { value: "conservative", label: "Conservative" },
                  { value: "balanced", label: "Balanced" },
                  { value: "aggressive", label: "Aggressive" },
                ]}
              />
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Take Profit & Stop Loss
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SettingField
                label="TP Multiplier — Strong Signal"
                description="Take profit multiplier for high-confidence signals (score >= 0.75)"
                value={form.tp_multiplier_strong || "2.5"}
                onChange={(v) => update("tp_multiplier_strong", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="TP Multiplier — Medium Signal"
                description="Take profit multiplier for medium-confidence signals (score 0.65-0.75)"
                value={form.tp_multiplier_medium || "2.0"}
                onChange={(v) => update("tp_multiplier_medium", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="TP Multiplier — Weak Signal"
                description="Take profit multiplier for weaker signals (score 0.55-0.65)"
                value={form.tp_multiplier_weak || "1.5"}
                onChange={(v) => update("tp_multiplier_weak", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="Stop Loss Ratio"
                description="SL distance as a ratio of the TP distance (1.0 = symmetric risk/reward)"
                value={form.sl_ratio || "1.0"}
                onChange={(v) => update("sl_ratio", v)}
                suffix="x"
                min={0.1}
                max={5}
                step={0.1}
              />
              <SettingField
                label="Trailing Stop Buffer"
                description="Buffer percentage above break-even before trailing stop activates"
                value={form.trailing_stop_buffer_pct || "0.3"}
                onChange={(v) => update("trailing_stop_buffer_pct", v)}
                suffix="%"
                min={0}
                max={5}
                step={0.05}
              />
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-4 h-4" />
                Risk Controls
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Paper Mode Limits</p>
              <SettingField
                label="Paper — Max Daily Loss"
                description="Trading halts for the day in paper mode"
                value={form.paper_max_daily_loss_pct || "5"}
                onChange={(v) => update("paper_max_daily_loss_pct", v)}
                suffix="%"
                min={0.5}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Paper — Max Weekly Loss"
                description="Trading halts for the week in paper mode"
                value={form.paper_max_weekly_loss_pct || "12"}
                onChange={(v) => update("paper_max_weekly_loss_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={0.5}
              />
              <SettingField
                label="Paper — Max Drawdown"
                description="Kill switch triggers at this drawdown in paper mode"
                value={form.paper_max_drawdown_pct || "20"}
                onChange={(v) => update("paper_max_drawdown_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={1}
              />
              <div className="border-t border-border/30 my-4" />
              <p className="text-xs font-semibold text-destructive/70 mb-2 uppercase tracking-wider">Live Mode Limits</p>
              <SettingField
                label="Live — Max Daily Loss"
                description="Trading halts for the day in live mode"
                value={form.live_max_daily_loss_pct || "3"}
                onChange={(v) => update("live_max_daily_loss_pct", v)}
                suffix="%"
                min={0.5}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Live — Max Weekly Loss"
                description="Trading halts for the week in live mode"
                value={form.live_max_weekly_loss_pct || "8"}
                onChange={(v) => update("live_max_weekly_loss_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={0.5}
              />
              <SettingField
                label="Live — Max Drawdown"
                description="Kill switch triggers at this drawdown in live mode"
                value={form.live_max_drawdown_pct || "15"}
                onChange={(v) => update("live_max_drawdown_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={1}
              />
              <div className="border-t border-border/30 my-4" />
              <SettingField
                label="Kill Switch"
                description="Emergency stop — halts all trading and sets mode to idle"
                value={form.kill_switch || "false"}
                onChange={(v) => update("kill_switch", v)}
                type="toggle"
              />
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Crosshair className="w-4 h-4" />
                Instruments
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">Select which synthetic indices the platform will scan and trade.</p>
              <InstrumentsPicker
                enabledSymbols={form.enabled_symbols || ""}
                onChange={(v) => update("enabled_symbols", v)}
              />
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Timing & Execution
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SettingField
                label="Time Exit Window"
                description="Automatically close positions that have been open longer than this"
                value={form.time_exit_window_hours || "4"}
                onChange={(v) => update("time_exit_window_hours", v)}
                suffix="hrs"
                min={0.5}
                max={72}
                step={0.5}
              />
              <SettingField
                label="Scan Interval"
                description="How often the scheduler runs to scan for new signals"
                value={form.scan_interval_seconds || "30"}
                onChange={(v) => update("scan_interval_seconds", v)}
                suffix="sec"
                min={5}
                max={300}
                step={5}
              />
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
