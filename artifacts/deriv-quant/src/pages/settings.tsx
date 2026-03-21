import React, { useEffect, useState } from "react";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  useGetAccountInfo,
  useSetTradingMode,
  useToggleTradingMode,
  getGetAccountInfoQueryKey,
} from "@workspace/api-client-react";
import type { PlatformSettings, SetTradingModeRequestMode, ToggleTradingModeRequestMode, ActionResponse } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui-elements";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Shield, TrendingUp, Clock, Crosshair, Save, RotateCcw, CheckCircle2, Key, Eye, EyeOff, AlertTriangle, Zap, Bot, Lock, Unlock, Database, Download, FlaskConical, Sparkles, ChevronRight, XCircle, Wifi, Loader2 } from "lucide-react";
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
  aiLocked?: boolean;
  aiValue?: string;
  aiSuggestion?: string;
  onOverride?: () => void;
  onRevert?: () => void;
}

function AiBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
      <Bot className="w-2.5 h-2.5" />
      AI SET
    </span>
  );
}

function SettingField({ label, description, value, onChange, type = "number", options, suffix, min, max, step, placeholder, aiLocked, aiValue, aiSuggestion, onOverride, onRevert }: SettingFieldProps) {
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

  if (aiLocked) {
    return (
      <div className="flex items-center justify-between py-4 border-b border-border/30 last:border-0">
        <div className="flex-1 pr-4">
          <div className="flex items-center gap-2 mb-0.5">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <AiBadge />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 h-9 rounded-md border border-emerald-500/30 bg-emerald-500/5">
            <Lock className="w-3 h-3 text-emerald-500" />
            <span className="text-sm font-mono text-foreground">{aiValue ?? value}</span>
            {suffix && <span className="text-xs text-muted-foreground font-mono">{suffix}</span>}
          </div>
          <button
            onClick={onOverride}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
          >
            Override
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="py-4 border-b border-border/30 last:border-0">
      <div className="flex items-center justify-between">
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
            className="w-24 h-9 rounded-md border border-primary/40 bg-background/50 px-3 text-sm font-mono text-right text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
          />
          {suffix && <span className="text-xs text-muted-foreground font-mono w-6">{suffix}</span>}
        </div>
      </div>
      {onRevert && aiSuggestion !== undefined && (
        <div className="flex items-center justify-end gap-2 mt-1.5">
          <span className="text-xs text-muted-foreground">AI suggestion: <span className="font-mono text-emerald-500">{aiSuggestion}</span></span>
          <button
            onClick={onRevert}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Revert to AI
          </button>
        </div>
      )}
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
  { symbol: "BOOM300", label: "Boom 300", category: "Boom/Crash" },
  { symbol: "CRASH300", label: "Crash 300", category: "Boom/Crash" },
  { symbol: "BOOM200", label: "Boom 200", category: "Boom/Crash" },
  { symbol: "CRASH200", label: "Crash 200", category: "Boom/Crash" },
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

const AI_LOCKABLE_KEYS_UI = [
  "equity_pct_per_trade",
  "paper_equity_pct_per_trade",
  "live_equity_pct_per_trade",
  "tp_multiplier_strong",
  "tp_multiplier_medium",
  "tp_multiplier_weak",
  "sl_ratio",
  "time_exit_window_hours",
];

interface AiStatus {
  locked: boolean;
  optimisedAt: string | null;
  aiValues: Record<string, string>;
  aiSuggestions: Record<string, string>;
  lockedKeys: string[];
  overriddenKeys: string[];
  lastMonthlyOptimise: string | null;
  nextScheduled: string;
}


function OverrideConfirmDialog({
  settingLabel,
  totalBacktests,
  monthsOfData,
  onConfirm,
  onCancel,
}: {
  settingLabel: string;
  totalBacktests: number;
  monthsOfData: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
            <h3 className="text-lg font-bold text-foreground">Override AI Setting</h3>
            <p className="text-sm text-muted-foreground">{settingLabel}</p>
          </div>
        </div>
        <div className="space-y-3 mb-6 text-sm text-muted-foreground">
          <p>Changing AI-optimised settings carries increased risk. The AI calculated this value based on <span className="text-foreground font-semibold">{monthsOfData} months</span> of backtesting across <span className="text-foreground font-semibold">{totalBacktests} symbol/strategy combinations</span>.</p>
          <p>Are you sure you want to override this value?</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
          >
            Keep AI Value
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2.5 rounded-lg bg-warning/80 text-warning-foreground text-sm font-bold uppercase tracking-wider hover:bg-warning transition-all"
          >
            Override
          </button>
        </div>
      </motion.div>
    </div>
  );
}

interface SetupStatus {
  hasToken: boolean;
  totalCandles: number;
  hasEnoughData: boolean;
  hasInitialBacktests: boolean;
  backtestCount: number;
  expectedBacktests: number;
  setupComplete: boolean;
}

interface SetupProgress {
  phase: string;
  message?: string;
  symbol?: string;
  symbolIndex?: number;
  totalSymbols?: number;
  candlesForSymbol?: number;
  grandTotal?: number;
  completed?: number;
  total?: number;
  estimatedSecondsRemaining?: number;
  settings?: Record<string, number>;
  backtestsCreated?: number;
}

interface PreflightResult {
  deriv: { ok: boolean; error?: string };
  openai: { ok: boolean; error?: string };
}

function InitialSetupWizard({ onComplete, openAiKeySet }: { onComplete: () => void; openAiKeySet: boolean }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<"idle" | "preflight" | "backfill" | "analyse" | "done">("idle");
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const base = import.meta.env.BASE_URL || "/";

  const fetchStatus = async () => {
    try {
      const r = await fetch(`${base}api/setup/status`);
      if (r.ok) setStatus(await r.json());
    } catch { /* ignore */ }
  };

  useEffect(() => { fetchStatus(); }, []);

  const streamPhase = async (url: string): Promise<boolean> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
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
        }
      }
    }
    return true;
  };

  const handleRunPreflight = async () => {
    if (preflightRunning) return;
    setPreflightRunning(true);
    setPreflight(null);
    try {
      const r = await fetch(`${base}api/setup/preflight`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: PreflightResult = await r.json();
      setPreflight(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Preflight request failed.";
      setPreflight({ deriv: { ok: false, error: msg }, openai: { ok: false, error: msg } });
    } finally {
      setPreflightRunning(false);
    }
  };

  const handleStartSetup = async () => {
    if (running) return;
    setRunning(true);

    try {
      setCurrentStep("preflight");
      setPreflightRunning(true);
      setPreflight(null);
      const preflightResp = await fetch(`${base}api/setup/preflight`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!preflightResp.ok) {
        throw new Error(`Connection check request failed (HTTP ${preflightResp.status}). Please try again.`);
      }
      const preflightData: PreflightResult = await preflightResp.json();
      setPreflight(preflightData);
      setPreflightRunning(false);

      if (!preflightData.deriv.ok || !preflightData.openai.ok) {
        const failedChecks = [];
        if (!preflightData.deriv.ok) failedChecks.push("Deriv API");
        if (!preflightData.openai.ok) failedChecks.push("OpenAI API");
        throw new Error(`Connection check failed for: ${failedChecks.join(", ")}. Fix your API keys in Settings → API Keys and retry.`);
      }

      await new Promise(r => setTimeout(r, 1500));

      setCurrentStep("backfill");
      setProgress({ phase: "start", message: "Connecting to Deriv API..." });
      await streamPhase(`${base}api/setup/backfill`);

      setCurrentStep("analyse");
      setProgress({ phase: "start", message: "Starting strategy analysis..." });
      await streamPhase(`${base}api/setup/initial-analyse`);

      setCurrentStep("done");
      setProgress(null);
      toast({ title: "Initial Setup Complete", description: "24 months of data downloaded, all strategies backtested, and settings optimised." });
      fetchStatus();
      onComplete();
    } catch (err) {
      setProgress({ phase: "error", message: err instanceof Error ? err.message : "Setup failed" });
      setRunning(false);
      setCurrentStep("idle");
    }
  };

  if (dismissed || status?.setupComplete) return null;
  if (!status) return null;

  const bothKeysConfigured = status.hasToken && openAiKeySet;

  const STEP_LABELS = [
    { key: "backfill", icon: Download, label: "Download 24 months of trading history" },
    { key: "analyse", icon: FlaskConical, label: "Run all strategies as backtests" },
    { key: "done", icon: Sparkles, label: "AI optimises your settings" },
  ] as const;

  const backfillPct = progress?.phase === "symbol_progress" || progress?.phase === "symbol_done"
    ? Math.round(((progress.symbolIndex ?? 0) / (progress.totalSymbols ?? 13)) * 100)
    : progress?.phase === "backfill_complete" ? 100 : 0;

  const analysePct = progress?.completed && progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  const progressPct = currentStep === "backfill" ? backfillPct : currentStep === "analyse" ? analysePct : currentStep === "done" ? 100 : 0;

  const isRunningPost = running && currentStep !== "preflight";
  const isPreflightPhase = running && currentStep === "preflight";

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
      <Card className="border-2 border-primary/40 bg-primary/5">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="w-4 h-4 text-primary" />
              {currentStep === "done" ? "Initial Setup Complete" : "Initial Setup Required"}
            </CardTitle>
            {!running && (
              <button
                onClick={() => setDismissed(true)}
                className="text-muted-foreground hover:text-foreground transition-colors mt-0.5"
                title="Dismiss"
              >
                <XCircle className="w-4 h-4" />
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!running && currentStep === "idle" && (
            <>
              {!status.hasToken ? (
                <p className="text-sm text-muted-foreground">
                  Enter your <span className="text-primary font-medium">Deriv API token</span> in the API Keys section below, then return here to run initial setup.
                </p>
              ) : !openAiKeySet ? (
                <p className="text-sm text-muted-foreground">
                  Enter your <span className="text-primary font-medium">OpenAI API key</span> in the API Keys section below. Both keys are required before running initial setup.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Before trading, the system needs to download 24 months of price history and run all strategies as backtests across every index. The AI will then recommend your optimal starting settings.
                  </p>
                  <div className="flex flex-col gap-2 pl-1">
                    {STEP_LABELS.map(({ key, icon: Icon, label }) => (
                      <div key={key} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Icon className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                        {label}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <p className="text-xs text-muted-foreground">
                      {status.totalCandles > 0
                        ? `${status.totalCandles.toLocaleString()} candles already stored · ${status.backtestCount} of ${status.expectedBacktests} backtests complete`
                        : "No historical data yet"}
                    </p>
                  </div>

                  {preflight && (
                    <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/50 bg-background/50">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Connection Check Results</p>
                      <div className="flex items-center gap-2 text-sm">
                        {preflight.deriv.ok
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                          : <XCircle className="w-4 h-4 text-destructive shrink-0" />}
                        <span className={preflight.deriv.ok ? "text-emerald-500 font-medium" : "text-destructive font-medium"}>
                          Deriv API: {preflight.deriv.ok ? "Connected" : preflight.deriv.error}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        {preflight.openai.ok
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                          : <XCircle className="w-4 h-4 text-destructive shrink-0" />}
                        <span className={preflight.openai.ok ? "text-emerald-500 font-medium" : "text-destructive font-medium"}>
                          OpenAI API: {preflight.openai.ok ? "Connected" : preflight.openai.error}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3 flex-wrap">
                    {bothKeysConfigured && (
                      <button
                        onClick={handleRunPreflight}
                        disabled={preflightRunning}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all disabled:opacity-50"
                        title="Test both API connections before starting setup"
                      >
                        {preflightRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                        {preflightRunning ? "Checking..." : "Check Connections"}
                      </button>
                    )}
                    <button
                      onClick={handleStartSetup}
                      disabled={!bothKeysConfigured}
                      title={!bothKeysConfigured ? "Both Deriv API token and OpenAI API key must be configured before running setup" : undefined}
                      className={cn(
                        "flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all",
                        bothKeysConfigured
                          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-primary/40"
                          : "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
                      )}
                    >
                      <Zap className="w-4 h-4" />
                      Run Initial Setup
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {(isPreflightPhase || (running && preflight && currentStep !== "idle")) && !isRunningPost && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {preflightRunning
                  ? <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
                  : <Wifi className="w-4 h-4 text-primary shrink-0" />}
                <span className="text-sm font-medium text-foreground">
                  {preflightRunning ? "Checking API connections..." : "Connection Check"}
                </span>
              </div>
              {preflight && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    {preflight.deriv.ok
                      ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                      : <XCircle className="w-4 h-4 text-destructive shrink-0" />}
                    <span className={preflight.deriv.ok ? "text-emerald-500" : "text-destructive"}>
                      Deriv API: {preflight.deriv.ok ? "Connected" : preflight.deriv.error}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    {preflight.openai.ok
                      ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                      : <XCircle className="w-4 h-4 text-destructive shrink-0" />}
                    <span className={preflight.openai.ok ? "text-emerald-500" : "text-destructive"}>
                      OpenAI API: {preflight.openai.ok ? "Connected" : preflight.openai.error}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {isRunningPost && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {STEP_LABELS.map(({ key, icon: Icon, label }, i) => {
                  const isDone = currentStep === "done" || (key === "backfill" && currentStep === "analyse");
                  const isActive = currentStep === key;
                  return (
                    <React.Fragment key={key}>
                      <div className={cn(
                        "flex items-center gap-1.5 text-xs font-medium transition-colors",
                        isDone ? "text-emerald-500" : isActive ? "text-primary" : "text-muted-foreground/40"
                      )}>
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="hidden sm:inline">{label.split(" ").slice(0, 3).join(" ")}</span>
                      </div>
                      {i < STEP_LABELS.length - 1 && (
                        <div className={cn("flex-1 h-px", isDone ? "bg-emerald-500/40" : "bg-border/50")} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                <div className="w-full h-2 bg-border/40 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-primary rounded-full"
                    initial={{ width: "0%" }}
                    animate={{ width: `${progressPct}%` }}
                    transition={{ ease: "easeOut" }}
                  />
                </div>
                <p className="text-xs text-muted-foreground min-h-[1.25rem]">
                  {progress?.message ?? "Working..."}
                  {progress?.estimatedSecondsRemaining && progress.estimatedSecondsRemaining > 5
                    ? ` · ~${Math.ceil(progress.estimatedSecondsRemaining / 60)} min remaining`
                    : ""}
                </p>
              </div>

              {progress?.phase === "error" && (
                <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{progress.message}</span>
                </div>
              )}
            </div>
          )}

          {!running && progress?.phase === "error" && currentStep === "idle" && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{progress.message}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
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

  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [overrideLabel, setOverrideLabel] = useState<string>("");

  const fetchAiStatus = async () => {
    try {
      const base = import.meta.env.BASE_URL || "/";
      const resp = await fetch(`${base}api/settings/ai-status`);
      if (resp.ok) {
        const data = await resp.json();
        setAiStatus(data);
      }
    } catch {
      // ignore
    }
  };

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

  useEffect(() => {
    fetchAiStatus();
  }, []);

  const handleRevertToAi = async (key: string) => {
    try {
      const base = import.meta.env.BASE_URL || "/";
      await fetch(`${base}api/settings/ai-revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      await fetchAiStatus();
      queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      toast({ title: "Reverted to AI suggestion", description: `${key.replace(/_/g, " ")} restored.` });
    } catch {
      toast({ title: "Revert failed", variant: "destructive" });
    }
  };

  const isAiLocked = (key: string): boolean => {
    if (!aiStatus?.locked) return false;
    return aiStatus.aiValues[key] !== undefined;
  };

  const getAiValue = (key: string): string | undefined => {
    return aiStatus?.aiValues[key];
  };

  const handleOverride = (key: string, label: string) => {
    setOverrideKey(key);
    setOverrideLabel(label);
  };

  const confirmOverride = async () => {
    if (!overrideKey) return;
    const key = overrideKey;
    setOverrideKey(null);

    try {
      const base = import.meta.env.BASE_URL || "/";
      await fetch(`${base}api/settings/ai-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      await fetchAiStatus();
      toast({ title: "Override applied", description: `You can now edit ${overrideLabel}.` });
    } catch {
      toast({ title: "Override failed", variant: "destructive" });
    }
  };

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

  const { mutate: toggleMode } = useToggleTradingMode({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        const resp = data as ActionResponse;
        toast({ title: "Mode toggled", description: resp.message || "Trading mode updated." });
      },
      onError: () => {
        toast({ title: "Toggle failed", variant: "destructive" });
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

  const handleToggleMode = (mode: "paper" | "demo" | "real", currentlyActive: boolean) => {
    if (mode === "real" && !currentlyActive) {
      setShowLiveConfirm(true);
      return;
    }
    toggleMode({ data: { mode: mode as ToggleTradingModeRequestMode, active: !currentlyActive } });
  };

  const confirmRealToggle = () => {
    setShowLiveConfirm(false);
    toggleMode({ data: { mode: "real" as ToggleTradingModeRequestMode, active: true, confirmed: true } });
  };

  const currentMode = form.trading_mode || "idle";
  const paperActive = form.paper_mode_active === "true";
  const demoActive = form.demo_mode_active === "true";
  const realActive = form.real_mode_active === "true";
  const anyModeActive = paperActive || demoActive || realActive;

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
            onConfirm={realActive ? confirmLiveMode : confirmRealToggle}
            onCancel={() => setShowLiveConfirm(false)}
          />
        )}
        {overrideKey && (
          <OverrideConfirmDialog
            settingLabel={overrideLabel}
            totalBacktests={52}
            monthsOfData={24}
            onConfirm={confirmOverride}
            onCancel={() => setOverrideKey(null)}
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

      <AnimatePresence>
        <InitialSetupWizard
          openAiKeySet={form.openai_api_key_set === "true"}
          onComplete={() => {
            queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
            fetchAiStatus();
          }}
        />
      </AnimatePresence>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
        <Card className={cn("border-2", aiStatus?.locked ? "border-emerald-500/30" : "border-border/50")}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-emerald-500" />
              AI Parameter Status
              {aiStatus?.locked && (
                <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/30">
                  <Lock className="w-3 h-3" />
                  AI ACTIVE
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
                <p className="text-xs text-muted-foreground mb-1">Last Optimised</p>
                <p className="text-sm font-semibold text-foreground">
                  {aiStatus?.optimisedAt
                    ? new Date(aiStatus.optimisedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                    : "—"}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
                <p className="text-xs text-muted-foreground mb-1">Next Scheduled</p>
                <p className="text-sm font-semibold text-foreground">
                  {aiStatus?.nextScheduled
                    ? new Date(aiStatus.nextScheduled).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                    : "1st of next month"}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                <p className="text-xs text-muted-foreground mb-1">AI Locked</p>
                <p className="text-sm font-semibold text-emerald-500">{aiStatus ? Object.keys(aiStatus.aiValues).length : 0} params</p>
              </div>
              <div className="p-3 rounded-lg bg-warning/5 border border-warning/20">
                <p className="text-xs text-muted-foreground mb-1">Overridden</p>
                <p className="text-sm font-semibold text-warning">{aiStatus?.overriddenKeys?.length ?? 0} params</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              AI parameters are re-optimised automatically on the 1st of each month using the last 24 months of candle data across all enabled symbols and strategies.
            </p>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
        <Card className={cn(
          "border-2",
          realActive ? "border-destructive/30" :
          anyModeActive ? "border-warning/30" : "border-border/50"
        )}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-4 h-4" />
              Trading Modes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">Enable any combination of modes. Each runs independently with its own capital, positions, and risk limits.</p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {([
                { key: "paper" as const, label: "Paper", desc: "Simulated trades", active: paperActive, color: "warning" },
                { key: "demo" as const,  label: "Demo",  desc: "Deriv demo account", active: demoActive,  color: "primary" },
                { key: "real" as const,  label: "Real",  desc: "Deriv real account", active: realActive,  color: "destructive" },
              ]).map(({ key, label, desc, active, color }) => (
                <button
                  key={key}
                  onClick={() => handleToggleMode(key, active)}
                  className={cn(
                    "flex flex-col items-start gap-1 p-4 rounded-xl border-2 text-left transition-all",
                    active
                      ? `bg-${color}/10 border-${color} text-${color}`
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  )}
                  style={active ? {
                    backgroundColor: `hsl(var(--${color}) / 0.1)`,
                    borderColor: `hsl(var(--${color}))`,
                    color: `hsl(var(--${color}))`,
                  } : undefined}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn("w-2.5 h-2.5 rounded-full", active ? "animate-pulse" : "bg-muted-foreground/30")}
                      style={active ? { backgroundColor: `hsl(var(--${color}))` } : undefined}
                    />
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
              label="Deriv API Token (Legacy)"
              description={form.deriv_api_token_set === "true" ? "Token is configured" : "Legacy token — use Demo/Real tokens below instead"}
              value={form.deriv_api_token || ""}
              onChange={(v) => update("deriv_api_token", v)}
              type="password"
              placeholder={form.deriv_api_token_set === "true" ? "****configured****" : "Enter Deriv API token"}
            />
            <SettingField
              label="Deriv Demo Token"
              description={form.deriv_api_token_demo_set === "true" ? "Demo token is configured" : "API token for your Deriv demo account"}
              value={form.deriv_api_token_demo || ""}
              onChange={(v) => update("deriv_api_token_demo", v)}
              type="password"
              placeholder={form.deriv_api_token_demo_set === "true" ? "****configured****" : "Enter Deriv demo API token"}
            />
            <SettingField
              label="Deriv Real Token"
              description={form.deriv_api_token_real_set === "true" ? "Real token is configured" : "API token for your Deriv real account"}
              value={form.deriv_api_token_real || ""}
              onChange={(v) => update("deriv_api_token_real", v)}
              type="password"
              placeholder={form.deriv_api_token_real_set === "true" ? "****configured****" : "Enter Deriv real API token"}
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

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-primary" />
              Signal Scoring Thresholds
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Every signal candidate is scored on six dimensions (0–100 each) and combined into a composite score. Only signals meeting all thresholds below are allowed to trade.
            </p>
            <SettingField
              label="Minimum Composite Score"
              description="Signals must score at least this high on the 0–100 composite scale to be approved"
              value={form.min_composite_score || "85"}
              onChange={(v) => update("min_composite_score", v)}
              min={50}
              max={100}
              step={1}
            />
            <SettingField
              label="Minimum Expected Value"
              description="Minimum expected value (probability * win – (1-prob) * loss) required"
              value={form.min_ev_threshold || "0.003"}
              onChange={(v) => update("min_ev_threshold", v)}
              min={0}
              max={0.1}
              step={0.001}
            />
            <SettingField
              label="Minimum Reward/Risk Ratio"
              description="Minimum ratio of take profit distance to stop loss distance"
              value={form.min_rr_ratio || "1.5"}
              onChange={(v) => update("min_rr_ratio", v)}
              suffix="x"
              min={0.5}
              max={5}
              step={0.1}
            />
            <div className="border-t border-border/30 my-4" />
            <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Dimension Weights (%)</p>
            <p className="text-xs text-muted-foreground mb-3">Adjust how much each scoring dimension contributes to the composite score. Values are relative weights (will be normalized).</p>
            <SettingField
              label="Regime Fit"
              description="How well the market regime matches the strategy's ideal conditions"
              value={form.scoring_weight_regime_fit || "16.67"}
              onChange={(v) => update("scoring_weight_regime_fit", v)}
              suffix="%"
              min={0}
              max={100}
              step={1}
            />
            <SettingField
              label="Setup Quality"
              description="How cleanly the strategy's entry conditions are met"
              value={form.scoring_weight_setup_quality || "16.67"}
              onChange={(v) => update("scoring_weight_setup_quality", v)}
              suffix="%"
              min={0}
              max={100}
              step={1}
            />
            <SettingField
              label="Trend Alignment"
              description="Whether higher-timeframe structure supports the trade direction"
              value={form.scoring_weight_trend_alignment || "16.67"}
              onChange={(v) => update("scoring_weight_trend_alignment", v)}
              suffix="%"
              min={0}
              max={100}
              step={1}
            />
            <SettingField
              label="Volatility Condition"
              description="Whether current volatility is in the ideal range for the strategy"
              value={form.scoring_weight_volatility_condition || "16.67"}
              onChange={(v) => update("scoring_weight_volatility_condition", v)}
              suffix="%"
              min={0}
              max={100}
              step={1}
            />
            <SettingField
              label="Reward/Risk"
              description="Expected reward-to-risk ratio normalized score"
              value={form.scoring_weight_reward_risk || "16.67"}
              onChange={(v) => update("scoring_weight_reward_risk", v)}
              suffix="%"
              min={0}
              max={100}
              step={1}
            />
            <SettingField
              label="Probability of Success"
              description="ML model's estimated probability of a profitable trade"
              value={form.scoring_weight_probability_of_success || "16.67"}
              onChange={(v) => update("scoring_weight_probability_of_success", v)}
              suffix="%"
              min={0}
              max={100}
              step={1}
            />
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
                value={form.equity_pct_per_trade || "22"}
                onChange={(v) => update("equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
                aiLocked={isAiLocked("equity_pct_per_trade")}
                aiValue={getAiValue("equity_pct_per_trade")}
                aiSuggestion={aiStatus?.aiSuggestions?.["equity_pct_per_trade"]}
                onOverride={() => handleOverride("equity_pct_per_trade", "Equity % Per Trade")}
                onRevert={aiStatus?.aiSuggestions?.["equity_pct_per_trade"] !== undefined ? () => handleRevertToAi("equity_pct_per_trade") : undefined}
              />
              <SettingField
                label="Paper Mode — Equity %"
                description="Position size when trading in paper mode (simulated)"
                value={form.paper_equity_pct_per_trade || "13"}
                onChange={(v) => update("paper_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
                aiLocked={isAiLocked("paper_equity_pct_per_trade")}
                aiValue={getAiValue("paper_equity_pct_per_trade")}
                aiSuggestion={aiStatus?.aiSuggestions?.["paper_equity_pct_per_trade"]}
                onOverride={() => handleOverride("paper_equity_pct_per_trade", "Paper Mode — Equity %")}
                onRevert={aiStatus?.aiSuggestions?.["paper_equity_pct_per_trade"] !== undefined ? () => handleRevertToAi("paper_equity_pct_per_trade") : undefined}
              />
              <SettingField
                label="Live Mode — Equity %"
                description="Position size when trading in live mode (real money)"
                value={form.live_equity_pct_per_trade || "22"}
                onChange={(v) => update("live_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
                aiLocked={isAiLocked("live_equity_pct_per_trade")}
                aiValue={getAiValue("live_equity_pct_per_trade")}
                aiSuggestion={aiStatus?.aiSuggestions?.["live_equity_pct_per_trade"]}
                onOverride={() => handleOverride("live_equity_pct_per_trade", "Live Mode — Equity %")}
                onRevert={aiStatus?.aiSuggestions?.["live_equity_pct_per_trade"] !== undefined ? () => handleRevertToAi("live_equity_pct_per_trade") : undefined}
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
                label="Total Capital (Legacy)"
                description="Overall capital base. Per-mode capitals below take priority."
                value={form.total_capital || "10000"}
                onChange={(v) => update("total_capital", v)}
                suffix="$"
                min={100}
                step={100}
              />
              <div className="border-t border-border/30 my-4" />
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Per-Mode Capital</p>
              <SettingField
                label="Paper Capital"
                description="Simulated capital for paper trading"
                value={form.paper_capital || "10000"}
                onChange={(v) => update("paper_capital", v)}
                suffix="$"
                min={100}
                step={100}
              />
              <SettingField
                label="Demo Capital"
                description="Capital for Deriv demo account trading"
                value={form.demo_capital || "600"}
                onChange={(v) => update("demo_capital", v)}
                suffix="$"
                min={100}
                step={100}
              />
              <SettingField
                label="Real Capital"
                description="Capital for Deriv real account trading"
                value={form.real_capital || "600"}
                onChange={(v) => update("real_capital", v)}
                suffix="$"
                min={100}
                step={100}
              />
              <div className="border-t border-border/30 my-4" />
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Demo Mode Position Sizing</p>
              <SettingField
                label="Demo — Equity %"
                description="Position size when trading in demo mode"
                value={form.demo_equity_pct_per_trade || "22"}
                onChange={(v) => update("demo_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Demo — Max Trades"
                description="Max open positions in demo mode"
                value={form.demo_max_open_trades || "3"}
                onChange={(v) => update("demo_max_open_trades", v)}
                step={1}
                min={1}
                max={20}
              />
              <p className="text-xs font-semibold text-muted-foreground mb-2 mt-4 uppercase tracking-wider">Real Mode Position Sizing</p>
              <SettingField
                label="Real — Equity %"
                description="Position size when trading in real mode"
                value={form.real_equity_pct_per_trade || "22"}
                onChange={(v) => update("real_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Real — Max Trades"
                description="Max open positions in real mode"
                value={form.real_max_open_trades || "3"}
                onChange={(v) => update("real_max_open_trades", v)}
                step={1}
                min={1}
                max={20}
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
                description="Take profit multiplier for high-confidence signals (composite >= 92)"
                value={form.tp_multiplier_strong || "2.5"}
                onChange={(v) => update("tp_multiplier_strong", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
                aiLocked={isAiLocked("tp_multiplier_strong")}
                aiValue={getAiValue("tp_multiplier_strong")}
                aiSuggestion={aiStatus?.aiSuggestions?.["tp_multiplier_strong"]}
                onOverride={() => handleOverride("tp_multiplier_strong", "TP Multiplier — Strong Signal")}
                onRevert={aiStatus?.aiSuggestions?.["tp_multiplier_strong"] !== undefined ? () => handleRevertToAi("tp_multiplier_strong") : undefined}
              />
              <SettingField
                label="TP Multiplier — Medium Signal"
                description="Take profit multiplier for medium-confidence signals (composite 85-92)"
                value={form.tp_multiplier_medium || "2.0"}
                onChange={(v) => update("tp_multiplier_medium", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
                aiLocked={isAiLocked("tp_multiplier_medium")}
                aiValue={getAiValue("tp_multiplier_medium")}
                aiSuggestion={aiStatus?.aiSuggestions?.["tp_multiplier_medium"]}
                onOverride={() => handleOverride("tp_multiplier_medium", "TP Multiplier — Medium Signal")}
                onRevert={aiStatus?.aiSuggestions?.["tp_multiplier_medium"] !== undefined ? () => handleRevertToAi("tp_multiplier_medium") : undefined}
              />
              <SettingField
                label="TP Multiplier — Weak Signal"
                description="Take profit multiplier for weaker signals (composite < 85)"
                value={form.tp_multiplier_weak || "1.5"}
                onChange={(v) => update("tp_multiplier_weak", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
                aiLocked={isAiLocked("tp_multiplier_weak")}
                aiValue={getAiValue("tp_multiplier_weak")}
                aiSuggestion={aiStatus?.aiSuggestions?.["tp_multiplier_weak"]}
                onOverride={() => handleOverride("tp_multiplier_weak", "TP Multiplier — Weak Signal")}
                onRevert={aiStatus?.aiSuggestions?.["tp_multiplier_weak"] !== undefined ? () => handleRevertToAi("tp_multiplier_weak") : undefined}
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
                aiLocked={isAiLocked("sl_ratio")}
                aiValue={getAiValue("sl_ratio")}
                aiSuggestion={aiStatus?.aiSuggestions?.["sl_ratio"]}
                onOverride={() => handleOverride("sl_ratio", "Stop Loss Ratio")}
                onRevert={aiStatus?.aiSuggestions?.["sl_ratio"] !== undefined ? () => handleRevertToAi("sl_ratio") : undefined}
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
              <p className="text-xs font-semibold text-primary/70 mb-2 uppercase tracking-wider">Demo Mode Limits</p>
              <SettingField
                label="Demo — Max Daily Loss"
                description="Trading halts for the day in demo mode"
                value={form.demo_max_daily_loss_pct || "5"}
                onChange={(v) => update("demo_max_daily_loss_pct", v)}
                suffix="%"
                min={0.5}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Demo — Max Weekly Loss"
                description="Trading halts for the week in demo mode"
                value={form.demo_max_weekly_loss_pct || "12"}
                onChange={(v) => update("demo_max_weekly_loss_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={0.5}
              />
              <SettingField
                label="Demo — Max Drawdown"
                description="Kill switch triggers at this drawdown in demo mode"
                value={form.demo_max_drawdown_pct || "20"}
                onChange={(v) => update("demo_max_drawdown_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={1}
              />
              <div className="border-t border-border/30 my-4" />
              <p className="text-xs font-semibold text-destructive/70 mb-2 uppercase tracking-wider">Real Mode Limits</p>
              <SettingField
                label="Real — Max Daily Loss"
                description="Trading halts for the day in real mode"
                value={form.real_max_daily_loss_pct || "3"}
                onChange={(v) => update("real_max_daily_loss_pct", v)}
                suffix="%"
                min={0.5}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Real — Max Weekly Loss"
                description="Trading halts for the week in real mode"
                value={form.real_max_weekly_loss_pct || "8"}
                onChange={(v) => update("real_max_weekly_loss_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={0.5}
              />
              <SettingField
                label="Real — Max Drawdown"
                description="Kill switch triggers at this drawdown in real mode"
                value={form.real_max_drawdown_pct || "15"}
                onChange={(v) => update("real_max_drawdown_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={1}
              />
              <div className="border-t border-border/30 my-4" />
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Legacy Live Mode Limits</p>
              <SettingField
                label="Live — Max Daily Loss"
                description="Trading halts for the day in live mode (legacy)"
                value={form.live_max_daily_loss_pct || "3"}
                onChange={(v) => update("live_max_daily_loss_pct", v)}
                suffix="%"
                min={0.5}
                max={25}
                step={0.5}
              />
              <SettingField
                label="Live — Max Weekly Loss"
                description="Trading halts for the week in live mode (legacy)"
                value={form.live_max_weekly_loss_pct || "8"}
                onChange={(v) => update("live_max_weekly_loss_pct", v)}
                suffix="%"
                min={1}
                max={50}
                step={0.5}
              />
              <SettingField
                label="Live — Max Drawdown"
                description="Kill switch triggers at this drawdown in live mode (legacy)"
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
                value={form.time_exit_window_hours || "72"}
                onChange={(v) => update("time_exit_window_hours", v)}
                suffix="hrs"
                min={1}
                max={120}
                step={0.5}
                aiLocked={isAiLocked("time_exit_window_hours")}
                aiValue={getAiValue("time_exit_window_hours")}
                aiSuggestion={aiStatus?.aiSuggestions?.["time_exit_window_hours"]}
                onOverride={() => handleOverride("time_exit_window_hours", "Time Exit Window")}
                onRevert={aiStatus?.aiSuggestions?.["time_exit_window_hours"] !== undefined ? () => handleRevertToAi("time_exit_window_hours") : undefined}
              />
              <SettingField
                label="Scan Interval"
                description="How often the scheduler cycle fires (controls config refresh frequency)"
                value={form.scan_interval_seconds || "30"}
                onChange={(v) => update("scan_interval_seconds", v)}
                suffix="sec"
                min={5}
                max={300}
                step={5}
              />
              <SettingField
                label="Symbol Scan Stagger"
                description="Delay between scanning each symbol — symbols are cycled one at a time to avoid rate limits"
                value={form.scan_stagger_seconds || "10"}
                onChange={(v) => update("scan_stagger_seconds", v)}
                suffix="sec"
                min={1}
                max={60}
                step={1}
              />
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
