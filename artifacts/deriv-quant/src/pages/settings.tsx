import React, { useEffect, useRef, useState } from "react";
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
import { Shield, TrendingUp, Clock, Crosshair, Save, RotateCcw, CheckCircle2, Key, Eye, EyeOff, AlertTriangle, Zap, Bot, Lock, Unlock, Database, Download, FlaskConical, Sparkles, ChevronRight, XCircle } from "lucide-react";
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
  onOverride?: () => void;
}

function AiBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
      <Bot className="w-2.5 h-2.5" />
      AI SET
    </span>
  );
}

function SettingField({ label, description, value, onChange, type = "number", options, suffix, min, max, step, placeholder, aiLocked, aiValue, onOverride }: SettingFieldProps) {
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
  lockedKeys: string[];
}

interface OptimisationProgress {
  type: "start" | "progress" | "complete" | "error";
  completed?: number;
  total?: number;
  message: string;
  estimatedSecondsRemaining?: number;
  paramCount?: number;
  settings?: Record<string, number>;
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

function InitialSetupWizard({ onComplete }: { onComplete: () => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<"idle" | "backfill" | "analyse" | "done">("idle");
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);
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

  const handleStartSetup = async () => {
    if (running) return;
    setRunning(true);

    try {
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
                  <button
                    onClick={handleStartSetup}
                    className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium shadow-lg shadow-primary/20 hover:shadow-primary/40 transition-all"
                  >
                    <Zap className="w-4 h-4" />
                    Run Initial Setup
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </>
              )}
            </>
          )}

          {running && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {STEP_LABELS.map(({ key, icon: Icon, label }, i) => {
                  const isDone = currentStep === "done" || (key === "backfill" && (currentStep === "analyse" || currentStep === "done"));
                  const isActive = currentStep === key;
                  return (
                    <React.Fragment key={key}>
                      <div className={cn(
                        "flex items-center gap-1.5 text-xs font-medium transition-colors",
                        isDone ? "text-success" : isActive ? "text-primary" : "text-muted-foreground/40"
                      )}>
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="hidden sm:inline">{label.split(" ").slice(0, 3).join(" ")}</span>
                      </div>
                      {i < STEP_LABELS.length - 1 && (
                        <div className={cn("flex-1 h-px", isDone ? "bg-success/40" : "bg-border/50")} />
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
        </CardContent>
      </Card>
    </motion.div>
function ResetPaperConfirmDialog({ onConfirm, onCancel, resetting }: { onConfirm: () => void; onCancel: () => void; resetting: boolean }) {
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
            <h3 className="text-lg font-bold text-foreground">Reset & Start Fresh</h3>
            <p className="text-sm text-muted-foreground">This action cannot be undone</p>
          </div>
        </div>
        <div className="space-y-3 mb-6 text-sm text-muted-foreground">
          <p>This will permanently delete <span className="text-foreground font-semibold">all paper trade history</span>, open paper positions, and reset paper P&amp;L to zero.</p>
          <p>Live trade records will not be affected. Your settings will remain unchanged.</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={resetting}
            className="flex-1 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={resetting}
            className="flex-1 px-4 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-bold uppercase tracking-wider hover:bg-destructive/90 transition-all disabled:opacity-50"
          >
            {resetting ? "Resetting..." : "Reset Paper Data"}
          </button>
        </div>
      </motion.div>
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
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [aiHealth, setAiHealth] = useState<{ configured: boolean; working: boolean; error?: string } | null>(null);
  const [aiHealthLoading, setAiHealthLoading] = useState(false);

  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [aiOptimising, setAiOptimising] = useState(false);
  const [aiProgress, setAiProgress] = useState<OptimisationProgress | null>(null);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [overrideLabel, setOverrideLabel] = useState<string>("");
  const eventSourceRef = useRef<EventSource | null>(null);

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

  const handleRunAiOptimise = () => {
    if (aiOptimising) return;
    setAiOptimising(true);
    setAiProgress({ type: "start", message: "Initialising optimisation..." });

    const base = import.meta.env.BASE_URL || "/";
    const es = new EventSource(`${base}api/settings/ai-optimise-stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: OptimisationProgress = JSON.parse(event.data);
        setAiProgress(data);
        if (data.type === "complete") {
          es.close();
          setAiOptimising(false);
          fetchAiStatus();
          queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
          toast({ title: "AI Optimisation Complete", description: data.message });
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      setAiOptimising(false);
      setAiProgress(prev => prev?.type === "complete" ? prev : { type: "error", message: "Optimisation failed or connection lost." });
    };
  };

  const handleRunAiOptimisePost = async () => {
    if (aiOptimising) return;
    setAiOptimising(true);
    setAiProgress({ type: "start", message: "Initialising optimisation..." });

    try {
      const base = import.meta.env.BASE_URL || "/";
      const response = await fetch(`${base}api/settings/ai-optimise`, {
        method: "POST",
        headers: { "Accept": "text/event-stream", "Content-Type": "application/json" },
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
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data: OptimisationProgress = JSON.parse(line.slice(6));
              setAiProgress(data);
              if (data.type === "complete") {
                setAiOptimising(false);
                fetchAiStatus();
                queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
                toast({ title: "AI Optimisation Complete", description: data.message });
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch (err) {
      setAiOptimising(false);
      setAiProgress({ type: "error", message: err instanceof Error ? err.message : "Optimisation failed" });
      toast({ title: "Optimisation failed", variant: "destructive" });
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

  const handleResetPaper = async () => {
    setResetting(true);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const resp = await fetch(`${base}api/settings/reset-paper`, { method: "POST" });
      const data = await resp.json();
      if (data.success) {
        toast({ title: "Paper data reset", description: data.message });
        queryClient.invalidateQueries();
      } else {
        toast({ title: "Reset failed", description: data.message, variant: "destructive" });
      }
    } catch {
      toast({ title: "Reset failed", description: "Could not reset paper data.", variant: "destructive" });
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
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
        {overrideKey && (
          <OverrideConfirmDialog
            settingLabel={overrideLabel}
            totalBacktests={aiProgress?.total ?? 36}
            monthsOfData={6}
            onConfirm={confirmOverride}
            onCancel={() => setOverrideKey(null)}
          />
        )}
        {showResetConfirm && (
          <ResetPaperConfirmDialog
            onConfirm={handleResetPaper}
            onCancel={() => setShowResetConfirm(false)}
            resetting={resetting}
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
              AI Parameter Optimisation
              {aiStatus?.locked && (
                <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/30">
                  <Lock className="w-3 h-3" />
                  AI LOCKED
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {aiStatus?.locked && aiStatus.optimisedAt && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20 text-sm text-emerald-600">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  <span>AI optimised on {new Date(aiStatus.optimisedAt).toLocaleString()} — {Object.keys(aiStatus.aiValues).length} parameters locked</span>
                </div>
              )}

              {aiProgress && (
                <div className="p-4 rounded-lg border border-border/50 bg-muted/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground">
                      {aiProgress.type === "complete" ? "Optimisation Complete" :
                       aiProgress.type === "error" ? "Optimisation Failed" :
                       "Running Optimisation..."}
                    </p>
                    {aiProgress.estimatedSecondsRemaining != null && aiProgress.type === "progress" && (
                      <span className="text-xs text-muted-foreground">
                        ~{aiProgress.estimatedSecondsRemaining}s remaining
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{aiProgress.message}</p>
                  {aiProgress.completed != null && aiProgress.total != null && (
                    <div className="space-y-1">
                      <div className="w-full bg-border/40 rounded-full h-1.5">
                        <div
                          className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${(aiProgress.completed / aiProgress.total) * 100}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground text-right">{aiProgress.completed} / {aiProgress.total}</p>
                    </div>
                  )}
                  {aiProgress.type === "complete" && aiProgress.settings && (
                    <div className="mt-3 grid grid-cols-2 gap-2 pt-3 border-t border-border/30">
                      {Object.entries(aiProgress.settings).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{k.replace(/_/g, " ")}</span>
                          <span className="font-mono text-emerald-500 font-bold">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={handleRunAiOptimisePost}
                  disabled={aiOptimising}
                  className={cn(
                    "flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all",
                    aiOptimising
                      ? "bg-muted text-muted-foreground cursor-not-allowed"
                      : "bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg shadow-emerald-500/20"
                  )}
                >
                  {aiOptimising ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                  ) : (
                    <Bot className="w-4 h-4" />
                  )}
                  {aiOptimising ? "Running..." : "Run AI Optimisation"}
                </button>
                {aiStatus?.locked && (
                  <button
                    onClick={async () => {
                      const base = import.meta.env.BASE_URL || "/";
                      for (const key of AI_LOCKABLE_KEYS_UI) {
                        await fetch(`${base}api/settings/ai-override`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ key }),
                        });
                      }
                      await fetchAiStatus();
                      toast({ title: "AI lock cleared", description: "All fields are now editable." });
                    }}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
                  >
                    <Unlock className="w-4 h-4" />
                    Clear All AI Locks
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Runs a backtest across all enabled symbol × strategy combinations using 6 months of stored candle data. AI-derived parameters will be applied and locked.
              </p>
            </div>
          </CardContent>
        </Card>
      </motion.div>

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
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Paper Mode</p>
              <SettingField
                label="Paper Capital"
                description="Starting capital for paper trading simulation"
                value={form.total_capital || "1000"}
                onChange={(v) => update("total_capital", v)}
                suffix="$"
                min={100}
                step={100}
              />
              <SettingField
                label="Paper — Equity %"
                description="Position size as a percentage of capital in paper mode (simulated)"
                value={form.paper_equity_pct_per_trade || "1"}
                onChange={(v) => update("paper_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
                aiLocked={isAiLocked("paper_equity_pct_per_trade")}
                aiValue={getAiValue("paper_equity_pct_per_trade")}
                onOverride={() => handleOverride("paper_equity_pct_per_trade", "Paper — Equity %")}
              />
              <SettingField
                label="Paper — Max Trades"
                description="Max open positions in paper mode"
                value={form.paper_max_open_trades || "4"}
                onChange={(v) => update("paper_max_open_trades", v)}
                step={1}
                min={1}
                max={20}
              />
              <div className="border-t border-border/30 my-4" />
              <p className="text-xs font-semibold text-destructive/70 mb-2 uppercase tracking-wider">Live Mode</p>
              <SettingField
                label="Live — Equity %"
                description="Position size as a percentage of live account balance"
                value={form.live_equity_pct_per_trade || "2"}
                onChange={(v) => update("live_equity_pct_per_trade", v)}
                suffix="%"
                min={0.1}
                max={25}
                step={0.5}
                aiLocked={isAiLocked("live_equity_pct_per_trade")}
                aiValue={getAiValue("live_equity_pct_per_trade")}
                onOverride={() => handleOverride("live_equity_pct_per_trade", "Live — Equity %")}
              />
              <SettingField
                label="Live — Max Trades"
                description="Max open positions in live mode"
                value={form.live_max_open_trades || "3"}
                onChange={(v) => update("live_max_open_trades", v)}
                step={1}
                min={1}
                max={20}
              />
              <div className="border-t border-border/30 my-4" />
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
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Paper Mode</p>
              <SettingField
                label="Paper TP — Strong Signal"
                description="Take profit multiplier for high-confidence signals in paper mode (score >= 0.75)"
                value={form.paper_tp_multiplier_strong || "2.5"}
                onChange={(v) => update("paper_tp_multiplier_strong", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="Paper TP — Medium Signal"
                description="Take profit multiplier for medium-confidence signals in paper mode (score 0.65-0.75)"
                value={form.paper_tp_multiplier_medium || "2.0"}
                onChange={(v) => update("paper_tp_multiplier_medium", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="Paper TP — Weak Signal"
                description="Take profit multiplier for weaker signals in paper mode (score 0.55-0.65)"
                value={form.paper_tp_multiplier_weak || "1.5"}
                onChange={(v) => update("paper_tp_multiplier_weak", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="Paper SL Ratio"
                description="Stop loss distance as a ratio of TP distance in paper mode"
                value={form.paper_sl_ratio || "1.0"}
                onChange={(v) => update("paper_sl_ratio", v)}
                suffix="x"
                min={0.1}
                max={5}
                step={0.1}
              />
              <div className="border-t border-border/30 my-4" />
              <p className="text-xs font-semibold text-destructive/70 mb-2 uppercase tracking-wider">Live Mode</p>
              <SettingField
                label="Live TP — Strong Signal"
                description="Take profit multiplier for high-confidence signals in live mode (score >= 0.75)"
                value={form.live_tp_multiplier_strong || "2.5"}
                onChange={(v) => update("live_tp_multiplier_strong", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="Live TP — Medium Signal"
                description="Take profit multiplier for medium-confidence signals in live mode (score 0.65-0.75)"
                value={form.live_tp_multiplier_medium || "2.0"}
                onChange={(v) => update("live_tp_multiplier_medium", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="Live TP — Weak Signal"
                description="Take profit multiplier for weaker signals in live mode (score 0.55-0.65)"
                value={form.live_tp_multiplier_weak || "1.5"}
                onChange={(v) => update("live_tp_multiplier_weak", v)}
                suffix="x"
                min={0.5}
                max={10}
                step={0.1}
              />
              <SettingField
                label="Live SL Ratio"
                description="Stop loss distance as a ratio of TP distance in live mode"
                value={form.live_sl_ratio || "1.0"}
                onChange={(v) => update("live_sl_ratio", v)}
                suffix="x"
                min={0.1}
                max={5}
                step={0.1}
              />
              <div className="border-t border-border/30 my-4" />
              <SettingField
                label="Trailing Stop Buffer"
                description="Buffer percentage above break-even before trailing stop activates (shared)"
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
                value={form.time_exit_window_hours || "72"}
                onChange={(v) => update("time_exit_window_hours", v)}
                suffix="hrs"
                min={0.5}
                max={72}
                step={0.5}
                aiLocked={isAiLocked("time_exit_window_hours")}
                aiValue={getAiValue("time_exit_window_hours")}
                onOverride={() => handleOverride("time_exit_window_hours", "Time Exit Window")}
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

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
        <Card className="border-2 border-destructive/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-4 h-4" />
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-foreground">Reset & Start Fresh</p>
                <p className="text-xs text-muted-foreground mt-0.5">Delete all paper trade history and reset P&amp;L to zero. Live trade records are not affected.</p>
              </div>
              <button
                onClick={() => setShowResetConfirm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border-2 border-destructive/50 text-destructive text-sm font-semibold hover:bg-destructive/5 hover:border-destructive transition-all"
              >
                <RotateCcw className="w-4 h-4" />
                Reset Paper Data
              </button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
