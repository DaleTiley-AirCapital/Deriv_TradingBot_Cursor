import { useState, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Circle, Loader2, AlertCircle, Database, BarChart3, Zap, ArrowRight, ArrowLeft, Key, Eye, EyeOff, Brain, Radio, RefreshCw, RotateCcw, Wifi, WifiOff, AlertTriangle, ChevronDown, ChevronUp, XCircle } from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";
const api = (path: string) => `${BASE}api${path}`;

type Step = "welcome" | "apikeys" | "testing" | "initialise" | "complete";

async function pollProgress(
  onEvent: (evt: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  let since = 0;
  while (!signal?.aborted) {
    try {
      const res = await fetch(api(`/setup/progress?since=${since}`), { signal });
      if (!res.ok) throw new Error(`Progress poll failed: ${res.status}`);
      const data = await res.json();
      const events = data.events as Array<Record<string, unknown>>;
      for (const evt of events) {
        onEvent(evt);
      }
      since = data.totalEvents as number;
      if (!data.running && since > 0) return;
      if (!data.running && data.error) {
        onEvent({ phase: "error", message: data.error });
        return;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

function formatTime(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  return `${seconds}s`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface SymbolBackfillInfo {
  status: "probing" | "waiting" | "downloading" | "done" | "error" | "retrying";
  candles: number;
  oldestDate: string | null;
  pct: number;
  error?: string;
  errorCode?: string;
  connected: boolean;
  expected: number;
  apiSymbol?: string;
  timeframe?: string;
  retryAttempt?: number;
  retryMax?: number;
}

export default function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [derivTokenDemo, setDerivTokenDemo] = useState("");
  const [derivTokenReal, setDerivTokenReal] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [showDerivDemo, setShowDerivDemo] = useState(false);
  const [showDerivReal, setShowDerivReal] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);
  const [testResult, setTestResult] = useState<{ derivDemo: { ok: boolean; error?: string }; derivReal: { ok: boolean; error?: string }; openai: { ok: boolean; error?: string } } | null>(null);

  const [initProgress, setInitProgress] = useState(0);
  const [initStage, setInitStage] = useState<"backfill" | "backtest" | "ai_review" | "optimise" | "streaming" | "complete" | "error">("backfill");
  const [initStatus, setInitStatus] = useState("");
  const [candleTotal, setCandleTotal] = useState(0);
  const [btCompleted, setBtCompleted] = useState(0);
  const [btTotal, setBtTotal] = useState(0);
  const [estRemainingSec, setEstRemainingSec] = useState(0);
  const [symbolProgress, setSymbolProgress] = useState<Record<string, SymbolBackfillInfo>>({});
  const [btSymbolResults, setBtSymbolResults] = useState<Record<string, { strategy: string; winRate: number; profitFactor: number; score: number; tradeCount: number; avgHoldHours: number }>>({});
  const [aiReviews, setAiReviews] = useState<Record<string, { summary: string | null; suggestions: string[] | null; bestStrategy: string; winRate: number; profitFactor: number }>>({});
  const [failedSymbols, setFailedSymbols] = useState<{ symbol: string; error: string; timeframe: string }[]>([]);
  const [grandTotalExpected, setGrandTotalExpected] = useState(0);
  const [backfillExpanded, setBackfillExpanded] = useState(true);
  const [resetting, setResetting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const completedRef = useRef(false);
  const queryClient = useQueryClient();

  const saveKeysAndTest = useCallback(async () => {
    if (!derivTokenDemo.trim() && !derivTokenReal.trim()) {
      setError("Please enter at least one Deriv API token (Demo or Real).");
      return;
    }
    setError(null);
    setSaving(true);
    setStep("testing");
    setTestResult(null);

    try {
      const keysToSave: Record<string, string> = {};
      if (derivTokenDemo.trim()) {
        keysToSave.deriv_api_token_demo = derivTokenDemo.trim();
        keysToSave.deriv_api_token = derivTokenDemo.trim();
      }
      if (derivTokenReal.trim()) {
        keysToSave.deriv_api_token_real = derivTokenReal.trim();
        if (!derivTokenDemo.trim()) {
          keysToSave.deriv_api_token = derivTokenReal.trim();
        }
      }
      if (openaiKey.trim()) {
        keysToSave.openai_api_key = openaiKey.trim();
      }

      const saveRes = await fetch(api("/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(keysToSave),
      });
      if (!saveRes.ok) throw new Error("Failed to save API keys");

      const testRes = await fetch(api("/setup/preflight"), { method: "POST" });
      const data = await testRes.json();

      const result = {
        derivDemo: data.derivDemo || { ok: false, error: "Not configured" },
        derivReal: data.derivReal || { ok: false, error: "Not configured" },
        openai: data.openai || { ok: false, error: "Not configured" },
      };
      setTestResult(result);

      const anyDerivOk = result.derivDemo.ok || result.derivReal.ok;
      if (anyDerivOk) {
        setStep("initialise");
      } else {
        setError("No Deriv API connection succeeded. Please check your tokens.");
        setStep("apikeys");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save keys");
      setStep("apikeys");
    } finally {
      setSaving(false);
    }
  }, [derivTokenDemo, derivTokenReal, openaiKey]);

  const runInitialise = useCallback(async () => {
    setError(null);
    setInitProgress(1);
    setInitStage("backfill");
    setInitStatus("Probing Deriv API for available data ranges...");
    setCandleTotal(0);
    setBtCompleted(0);
    setBtTotal(0);
    setEstRemainingSec(0);
    setSymbolProgress({});
    setBtSymbolResults({});
    setAiReviews({});
    setFailedSymbols([]);
    setGrandTotalExpected(0);
    setBackfillExpanded(true);
    abortRef.current = new AbortController();
    completedRef.current = false;

    try {
      const startRes = await fetch(api("/setup/initialise"), { method: "POST" });
      const startData = await startRes.json();
      if (!startData.started && !startData.message?.includes("already running")) {
        setError(startData.message || "Failed to start setup");
        return;
      }

      await pollProgress((evt) => {
        const phase = evt.phase as string;
        const pct = (evt.overallPct as number) || 0;

        if (phase === "backfill_probing") {
          setInitStage("backfill");
          setInitStatus(evt.message as string);
        } else if (phase === "backfill_probe_result") {
          const sym = evt.symbol as string;
          const connected = evt.connected as boolean;
          setSymbolProgress(prev => ({
            ...prev,
            [sym]: {
              status: connected ? "probing" : "error",
              candles: 0,
              oldestDate: (evt.oldestAvailableDate as string) || null,
              pct: 0,
              connected,
              expected: (evt.totalExpected as number) || 0,
              error: connected ? undefined : "Connection failed — unable to reach Deriv API for this symbol",
              errorCode: connected ? undefined : "CONNECTION_FAILED",
            },
          }));
          setInitStatus(evt.message as string);
        } else if (phase === "backfill_start") {
          setInitStage("backfill");
          setInitStatus(evt.message as string);
          setGrandTotalExpected((evt.grandTotalExpected as number) || 0);
          const syms = evt.symbols as Array<{ symbol: string; status: string; candles: number; oldestDate: string | null; expected: number; connected: boolean; error: string | null }>;
          if (syms) {
            const map: Record<string, SymbolBackfillInfo> = {};
            for (const s of syms) {
              map[s.symbol] = {
                status: s.connected ? "waiting" : "error",
                candles: s.candles,
                oldestDate: s.oldestDate,
                pct: 0,
                connected: s.connected,
                expected: s.expected || 0,
                error: s.error || undefined,
                errorCode: s.connected ? undefined : "CONNECTION_FAILED",
              };
            }
            setSymbolProgress(map);
          }
        } else if (phase === "backfill_symbol_start") {
          const sym = evt.symbol as string;
          setSymbolProgress(prev => ({
            ...prev,
            [sym]: {
              ...prev[sym],
              status: "downloading",
              candles: 0,
              pct: 0,
              apiSymbol: (evt.apiSymbol as string) || undefined,
              expected: (evt.totalExpected as number) || prev[sym]?.expected || 0,
            },
          }));
          setInitStatus(evt.message as string);
        } else if (phase === "backfill_progress") {
          setInitStage("backfill");
          setInitProgress(Math.max(pct, 1));
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
          const sym = evt.symbol as string;
          if (sym) {
            setSymbolProgress(prev => ({
              ...prev,
              [sym]: {
                ...prev[sym],
                status: "downloading",
                candles: evt.candlesForSymbol as number || 0,
                oldestDate: evt.oldestDate as string || prev[sym]?.oldestDate || null,
                pct: evt.symbolPct as number || prev[sym]?.pct || 0,
                expected: evt.totalExpected as number || prev[sym]?.expected || 0,
                connected: true,
                timeframe: evt.timeframe as string || undefined,
              },
            }));
          }
        } else if (phase === "backfill_retry") {
          const sym = evt.symbol as string;
          if (sym) {
            setSymbolProgress(prev => ({
              ...prev,
              [sym]: {
                ...prev[sym],
                status: "retrying",
                retryAttempt: evt.attempt as number || 0,
                retryMax: evt.maxAttempts as number || 5,
                error: evt.error as string || "Retrying...",
                errorCode: evt.errorCode as string || "RETRYING",
              },
            }));
          }
          setInitStatus(evt.message as string);
        } else if (phase === "backfill_symbol_error") {
          const sym = evt.symbol as string;
          if (sym) {
            setSymbolProgress(prev => ({
              ...prev,
              [sym]: {
                ...prev[sym],
                status: "error",
                error: evt.error as string || "Failed",
                errorCode: evt.errorCode as string || "UNKNOWN",
                candles: evt.candlesForSymbol as number || prev[sym]?.candles || 0,
              },
            }));
            setFailedSymbols(prev => [...prev, {
              symbol: sym,
              error: evt.error as string || "Unknown error",
              timeframe: evt.timeframe as string || "unknown",
            }]);
          }
          setInitStatus(evt.message as string);
        } else if (phase === "backfill_symbol_failed") {
          const sym = evt.symbol as string;
          if (sym) {
            setSymbolProgress(prev => ({
              ...prev,
              [sym]: {
                ...prev[sym],
                status: "error",
                candles: evt.candlesForSymbol as number || prev[sym]?.candles || 0,
              },
            }));
          }
          setInitStatus(evt.message as string);
        } else if (phase === "backfill_symbol_done") {
          setInitProgress(Math.max(pct, 1));
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
          const sym = evt.symbol as string;
          if (sym) {
            setSymbolProgress(prev => ({
              ...prev,
              [sym]: {
                ...prev[sym],
                status: "done",
                candles: evt.candlesForSymbol as number || 0,
                pct: 100,
                connected: true,
                expected: evt.totalExpected as number || prev[sym]?.expected || 0,
              },
            }));
          }
        } else if (phase === "backfill_partial_warning") {
          setInitStatus(evt.message as string);
          const failed = evt.failedSymbols as Array<{ symbol: string; error: string; timeframe: string }>;
          if (failed && failed.length > 0) {
            setFailedSymbols(failed);
          }
        } else if (phase === "backfill_complete") {
          setInitProgress(40);
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
          setEstRemainingSec(0);
          const failed = evt.failedSymbols as Array<{ symbol: string; error: string; timeframe: string }>;
          if (failed && failed.length > 0) {
            setFailedSymbols(failed);
          }
        } else if (phase === "backtest_start") {
          setInitStage("backtest");
          setBtTotal(evt.btTotal as number || 0);
          setInitStatus(evt.message as string);
        } else if (phase === "backtest_progress") {
          setInitStage("backtest");
          setInitProgress(Math.max(pct, 40));
          setBtCompleted(evt.btCompleted as number || 0);
          setBtTotal(evt.btTotal as number || 0);
          setCandleTotal(evt.candleTotal as number || 0);
          setEstRemainingSec(evt.estRemainingSec as number || 0);
          setInitStatus(evt.message as string);
          const sym = evt.symbol as string;
          const strat = evt.strategy as string;
          if (sym && strat) {
            setBtSymbolResults(prev => {
              const existing = prev[sym];
              if (!existing) return { ...prev, [sym]: { strategy: strat, winRate: 0, profitFactor: 0, score: 0, tradeCount: 0, avgHoldHours: 0 } };
              return prev;
            });
          }
        } else if (phase === "backtest_symbol_summary") {
          const sym = evt.symbol as string;
          if (sym) {
            setBtSymbolResults(prev => ({
              ...prev,
              [sym]: {
                strategy: (evt.bestStrategy as string) || prev[sym]?.strategy || "",
                winRate: (evt.avgWinRate as number) || 0,
                profitFactor: (evt.avgProfitFactor as number) || 0,
                score: (evt.bestScore as number) || 0,
                tradeCount: (evt.tradeCount as number) || 0,
                avgHoldHours: (evt.avgHoldHours as number) || 0,
              },
            }));
          }
        } else if (phase === "ai_review_start") {
          setInitStage("ai_review");
          setInitProgress(Math.max(pct, 70));
          setInitStatus(evt.message as string);
          setEstRemainingSec(0);
        } else if (phase === "ai_review_symbol") {
          setInitStage("ai_review");
          setInitProgress(Math.max(pct, 70));
          setInitStatus(evt.message as string);
          setEstRemainingSec(0);
          const sym = evt.symbol as string;
          if (sym) {
            setAiReviews(prev => ({
              ...prev,
              [sym]: {
                summary: (evt.aiSummary as string) || null,
                suggestions: (evt.aiSuggestions as string[]) || null,
                bestStrategy: (evt.bestStrategy as string) || "none",
                winRate: (evt.winRate as number) || 0,
                profitFactor: (evt.profitFactor as number) || 0,
              },
            }));
          }
        } else if (phase === "ai_review_complete") {
          setInitStage("ai_review");
          setInitProgress(80);
          setInitStatus(evt.message as string);
        } else if (phase === "optimising" || phase === "optimise_complete") {
          setInitStage("optimise");
          setInitProgress(Math.max(pct, 80));
          setInitStatus(evt.message as string);
          setEstRemainingSec(0);
        } else if (phase === "streaming_start" || phase === "streaming_complete") {
          setInitStage("streaming");
          setInitProgress(Math.max(pct, 90));
          setInitStatus(evt.message as string);
        } else if (phase === "complete") {
          completedRef.current = true;
          setInitStage("complete");
          setInitProgress(100);
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
          setBtCompleted(evt.btCompleted as number || 0);
          setEstRemainingSec(0);
          const failed = evt.failedSymbols as Array<{ symbol: string; error: string; timeframe: string }>;
          if (failed && failed.length > 0) setFailedSymbols(failed);
          queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
          queryClient.invalidateQueries({ queryKey: ["/api/setup/status"] });
          setStep("complete");
        } else if (phase === "error") {
          completedRef.current = true;
          setError(evt.message as string);
          setInitStage("error");
          const failed = evt.failedSymbols as Array<{ symbol: string; error: string; timeframe: string }>;
          if (failed && failed.length > 0) setFailedSymbols(failed);
        }
      }, abortRef.current.signal);

      if (!completedRef.current) {
        setError("Setup process ended without completing. Click 'Retry Setup' to check progress or restart.");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Initialisation failed");
      }
    }
  }, [queryClient]);

  const handleResetSetup = useCallback(async () => {
    setResetting(true);
    try {
      const res = await fetch(api("/setup/reset"), { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setError(null);
        setInitProgress(0);
        setInitStage("backfill");
        setInitStatus("");
        setCandleTotal(0);
        setBtCompleted(0);
        setBtTotal(0);
        setSymbolProgress({});
        setBtSymbolResults({});
        setAiReviews({});
        setFailedSymbols([]);
        setGrandTotalExpected(0);
        completedRef.current = false;
        queryClient.invalidateQueries({ queryKey: ["/api/setup/status"] });
      } else {
        setError(data.message || "Reset failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }, [queryClient]);

  const stepDefs = [
    { label: "Welcome" },
    { label: "API Keys" },
    { label: "Backfill \u2192 Backtest \u2192 AI" },
    { label: "Ready" },
  ];

  const stepToIndex: Record<Step, number> = { welcome: 0, apikeys: 1, testing: 1, initialise: 2, complete: 3 };
  const indexToStep: Step[] = ["welcome", "apikeys", "initialise", "complete"];
  const stepIndex = stepToIndex[step];

  const goBack = () => {
    setError(null);
    if (abortRef.current) abortRef.current.abort();
    const prevIndex = Math.max(0, stepIndex - 1);
    setStep(indexToStep[prevIndex]);
  };

  const goToStep = (targetIndex: number) => {
    if (targetIndex >= stepIndex) return;
    setError(null);
    if (abortRef.current) abortRef.current.abort();
    setStep(indexToStep[targetIndex]);
  };

  const connectedCount = Object.values(symbolProgress).filter(s => s.connected).length;
  const doneCount = Object.values(symbolProgress).filter(s => s.status === "done").length;
  const errorCount = Object.values(symbolProgress).filter(s => s.status === "error").length;
  const downloadingCount = Object.values(symbolProgress).filter(s => s.status === "downloading" || s.status === "retrying").length;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Zap className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Deriv Trading - Long Hold</h1>
          <p className="text-muted-foreground mt-2">Initial Setup</p>
        </div>

        <div className="flex items-center justify-center gap-2 mb-8">
          {stepDefs.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2">
              <button
                type="button"
                disabled={i >= stepIndex}
                onClick={() => goToStep(i)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  i < stepIndex ? "bg-green-500/10 text-green-400 cursor-pointer hover:bg-green-500/20" :
                  i === stepIndex ? "bg-primary/10 text-primary" :
                  "bg-muted/30 text-muted-foreground"
                }`}
              >
                {i < stepIndex ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                 i === stepIndex && step !== "welcome" && step !== "complete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                 i === stepIndex && step === "complete" ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                 <Circle className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < stepDefs.length - 1 && <ArrowRight className="w-3 h-3 text-muted-foreground/40" />}
            </div>
          ))}
        </div>

        <Card className="border-border/50 bg-card">
          <CardContent className="p-8">
            {error && (
              <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/20">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-destructive">Error</p>
                    <p className="text-sm text-destructive/80 mt-1">{error}</p>
                  </div>
                </div>
                {(initStage === "error" || (failedSymbols.length > 0 && initProgress > 0)) && (
                  <div className="flex gap-2 mt-4 ml-8">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={runInitialise}
                      className="text-xs border-primary/30 text-primary hover:bg-primary/10"
                    >
                      <RefreshCw className="w-3 h-3 mr-1.5" /> Retry Setup
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleResetSetup}
                      disabled={resetting}
                      className="text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                    >
                      <RotateCcw className="w-3 h-3 mr-1.5" /> {resetting ? "Resetting..." : "Reset & Start Over"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {step === "welcome" && (
              <div className="text-center space-y-6">
                <div className="space-y-3">
                  <h2 className="text-xl font-semibold text-foreground">Welcome</h2>
                  <p className="text-muted-foreground leading-relaxed max-w-md mx-auto">
                    Before trading, the system downloads ALL available 1m & 5m price history,
                    runs every strategy as backtests across every symbol, and has AI
                    recommend your optimal starting settings.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2 max-w-lg mx-auto">
                  <div className="p-3 rounded-lg bg-muted/20 text-center">
                    <Key className="w-5 h-5 text-yellow-400 mx-auto mb-1.5" />
                    <p className="text-[10px] text-muted-foreground">API Keys</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/20 text-center">
                    <Database className="w-5 h-5 text-blue-400 mx-auto mb-1.5" />
                    <p className="text-[10px] text-muted-foreground">Backfill</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/20 text-center">
                    <BarChart3 className="w-5 h-5 text-purple-400 mx-auto mb-1.5" />
                    <p className="text-[10px] text-muted-foreground">Strategy Replay</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/20 text-center">
                    <Brain className="w-5 h-5 text-amber-400 mx-auto mb-1.5" />
                    <p className="text-[10px] text-muted-foreground">AI Review</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/20 text-center">
                    <Zap className="w-5 h-5 text-emerald-400 mx-auto mb-1.5" />
                    <p className="text-[10px] text-muted-foreground">AI Optimise</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/20 text-center">
                    <Radio className="w-5 h-5 text-cyan-400 mx-auto mb-1.5" />
                    <p className="text-[10px] text-muted-foreground">Start Streaming</p>
                  </div>
                </div>
                <Button size="lg" onClick={() => { setError(null); setStep("apikeys"); }} className="px-8">
                  Begin Setup <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {(step === "apikeys" || step === "testing") && (
              <div className="space-y-6">
                <div className="text-center space-y-2">
                  <Key className="w-10 h-10 text-yellow-400 mx-auto" />
                  <h2 className="text-lg font-semibold">Connect Your API Keys</h2>
                  <p className="text-muted-foreground text-sm max-w-md mx-auto">
                    Enter your Deriv API token and OpenAI key. We'll verify the connections before proceeding.
                  </p>
                </div>

                <div className="space-y-4 max-w-md mx-auto">
                  <p className="text-xs text-muted-foreground">
                    Get your tokens from{" "}
                    <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noreferrer" className="text-primary underline">
                      Deriv API Token Settings
                    </a>. Enable Read, Trade, and Admin scopes. You need at least one token.
                  </p>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground flex items-center gap-2">
                      Deriv Demo API Token
                    </label>
                    <div className="relative">
                      <Input
                        type={showDerivDemo ? "text" : "password"}
                        placeholder="Enter your Demo account API token"
                        value={derivTokenDemo}
                        onChange={(e) => setDerivTokenDemo(e.target.value)}
                        className="pr-10 bg-background/50"
                        disabled={step === "testing"}
                      />
                      <button
                        type="button"
                        onClick={() => setShowDerivDemo(!showDerivDemo)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showDerivDemo ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground flex items-center gap-2">
                      Deriv Real API Token
                    </label>
                    <div className="relative">
                      <Input
                        type={showDerivReal ? "text" : "password"}
                        placeholder="Enter your Real account API token"
                        value={derivTokenReal}
                        onChange={(e) => setDerivTokenReal(e.target.value)}
                        className="pr-10 bg-background/50"
                        disabled={step === "testing"}
                      />
                      <button
                        type="button"
                        onClick={() => setShowDerivReal(!showDerivReal)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showDerivReal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground flex items-center gap-2">
                      OpenAI API Key <span className="text-muted-foreground text-xs">(optional)</span>
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Required for AI chat assistant and AI-powered analysis. You can add it later in Settings.
                    </p>
                    <div className="relative">
                      <Input
                        type={showOpenai ? "text" : "password"}
                        placeholder="sk-..."
                        value={openaiKey}
                        onChange={(e) => setOpenaiKey(e.target.value)}
                        className="pr-10 bg-background/50"
                        disabled={step === "testing"}
                      />
                      <button
                        type="button"
                        onClick={() => setShowOpenai(!showOpenai)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showOpenai ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {testResult && (
                    <div className="space-y-2 pt-2">
                      {derivTokenDemo.trim() && (
                        <div className={`flex items-center gap-2 text-sm ${testResult.derivDemo.ok ? "text-green-400" : "text-destructive"}`}>
                          {testResult.derivDemo.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                          Deriv Demo: {testResult.derivDemo.ok ? "Connected" : (testResult.derivDemo.error || "Failed")}
                        </div>
                      )}
                      {derivTokenReal.trim() && (
                        <div className={`flex items-center gap-2 text-sm ${testResult.derivReal.ok ? "text-green-400" : "text-destructive"}`}>
                          {testResult.derivReal.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                          Deriv Real: {testResult.derivReal.ok ? "Connected" : (testResult.derivReal.error || "Failed")}
                        </div>
                      )}
                      <div className={`flex items-center gap-2 text-sm ${testResult.openai.ok ? "text-green-400" : "text-yellow-400"}`}>
                        {testResult.openai.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                        OpenAI: {testResult.openai.ok ? "Connected" : (openaiKey.trim() ? (testResult.openai.error || "Failed") : "Not configured (optional)")}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex justify-center gap-3">
                  <Button variant="outline" onClick={goBack} disabled={saving} className="px-6">
                    <ArrowLeft className="w-4 h-4 mr-2" /> Back
                  </Button>
                  <Button onClick={saveKeysAndTest} disabled={saving || (!derivTokenDemo.trim() && !derivTokenReal.trim())} className="px-8">
                    {saving ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Testing Connections...</>
                    ) : (
                      <>Save & Test Connections <ArrowRight className="w-4 h-4 ml-2" /></>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {step === "initialise" && (
              <div className="space-y-6">
                {testResult && (
                  <div className="flex gap-4 justify-center mb-4 flex-wrap">
                    {testResult.derivDemo.ok && (
                      <div className="flex items-center gap-2 text-sm text-green-400">
                        <CheckCircle2 className="w-4 h-4" />
                        Demo Connected
                      </div>
                    )}
                    {testResult.derivReal.ok && (
                      <div className="flex items-center gap-2 text-sm text-green-400">
                        <CheckCircle2 className="w-4 h-4" />
                        Real Connected
                      </div>
                    )}
                    <div className={`flex items-center gap-2 text-sm ${testResult.openai.ok ? "text-green-400" : "text-yellow-400"}`}>
                      {testResult.openai.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                      OpenAI {testResult.openai.ok ? "Connected" : "Skipped"}
                    </div>
                  </div>
                )}

                {initProgress > 0 ? (
                  <div className="space-y-5">
                    <div className="text-center space-y-1">
                      <h2 className="text-lg font-semibold">
                        {initStage === "backfill" && "Step 1 of 6: Downloading Historical Data"}
                        {initStage === "backtest" && "Step 2 of 6: Running Strategy Replay"}
                        {initStage === "ai_review" && "Step 3 of 6: AI Review Per Symbol"}
                        {initStage === "optimise" && "Step 4 of 6: AI-Optimised Settings"}
                        {initStage === "streaming" && "Step 5 of 6: Starting Live Stream"}
                        {initStage === "complete" && "Step 6 of 6: Complete"}
                        {initStage === "error" && "Setup Failed"}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {initStage === "backfill" && (grandTotalExpected > 0
                          ? `Fetching ~${formatNumber(grandTotalExpected)} total records (1m & 5m candles) from Deriv`
                          : "Fetching all available 1m & 5m candle data from Deriv")}
                        {initStage === "backtest" && "Testing all strategies across every symbol"}
                        {initStage === "ai_review" && "Analysing each symbol's best strategy and performance"}
                        {initStage === "optimise" && "Computing optimal parameters from backtest results"}
                        {initStage === "streaming" && "Connecting to live market data feeds"}
                        {initStage === "complete" && "Your platform is ready"}
                        {initStage === "error" && "An error occurred during setup"}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                        <span>{initProgress}%{candleTotal > 0 && initStage === "backfill" ? ` \u2022 ${formatNumber(candleTotal)} records` : ""}</span>
                        {estRemainingSec > 0 && (
                          <span>~{formatTime(estRemainingSec)} remaining</span>
                        )}
                      </div>
                      <Progress value={initProgress} className="h-3" />
                    </div>

                    {initStage === "backfill" && (
                      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                        <div className="flex gap-3">
                          <span className="flex items-center gap-1">
                            <Wifi className="w-3 h-3 text-green-400" /> {connectedCount} connected
                          </span>
                          <span className="flex items-center gap-1">
                            <Database className="w-3 h-3 text-blue-400" /> {downloadingCount} downloading
                          </span>
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3 text-green-400" /> {doneCount} done
                          </span>
                          {errorCount > 0 && (
                            <span className="flex items-center gap-1 text-red-400">
                              <XCircle className="w-3 h-3" /> {errorCount} failed
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-6 gap-1.5">
                      {([
                        { key: "backfill", icon: Database, label: "Backfill", activeBg: "bg-blue-500/10 border-blue-500/30", activeIcon: "text-blue-400", value: candleTotal > 0 ? formatNumber(candleTotal) : "\u2014" },
                        { key: "backtest", icon: BarChart3, label: "Replay", activeBg: "bg-purple-500/10 border-purple-500/30", activeIcon: "text-purple-400", value: btTotal > 0 ? `${btCompleted}/${btTotal}` : "\u2014" },
                        { key: "ai_review", icon: Brain, label: "Review", activeBg: "bg-amber-500/10 border-amber-500/30", activeIcon: "text-amber-400 animate-pulse", value: null },
                        { key: "optimise", icon: Zap, label: "Optimise", activeBg: "bg-emerald-500/10 border-emerald-500/30", activeIcon: "text-emerald-400 animate-pulse", value: null },
                        { key: "streaming", icon: Radio, label: "Stream", activeBg: "bg-cyan-500/10 border-cyan-500/30", activeIcon: "text-cyan-400", value: null },
                        { key: "complete", icon: CheckCircle2, label: "Ready", activeBg: "bg-green-500/10 border-green-500/30", activeIcon: "text-green-400", value: null },
                      ] as const).map((s) => {
                        const stageOrder = ["backfill", "backtest", "ai_review", "optimise", "streaming", "complete"];
                        const currentIdx = stageOrder.indexOf(initStage);
                        const thisIdx = stageOrder.indexOf(s.key);
                        const isDone = thisIdx < currentIdx || initStage === "complete";
                        const isActive = s.key === initStage && initStage !== "complete";
                        const Icon = s.icon;
                        return (
                          <div key={s.key} className={`p-2 rounded-lg border text-center transition-colors ${
                            isActive ? s.activeBg :
                            isDone ? "bg-green-500/5 border-green-500/20" :
                            "bg-muted/20 border-border/40"
                          }`}>
                            <Icon className={`w-3.5 h-3.5 mx-auto mb-0.5 ${
                              isActive ? s.activeIcon :
                              isDone ? "text-green-400" : "text-muted-foreground"
                            }`} />
                            <p className="text-[9px] font-medium leading-tight">{s.label}</p>
                            <p className="text-[10px] font-bold tabular-nums mt-0.5">
                              {s.value ? s.value : isDone ? <CheckCircle2 className="w-3 h-3 text-green-400 mx-auto" /> : isActive ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : "\u2014"}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    {initStage === "backfill" && Object.keys(symbolProgress).length > 0 && (
                      <div className="rounded-lg border border-border/30 overflow-hidden">
                        <button
                          onClick={() => setBackfillExpanded(!backfillExpanded)}
                          className="w-full flex items-center justify-between px-3 py-2 bg-muted/10 hover:bg-muted/20 transition-colors"
                        >
                          <span className="text-xs font-medium text-muted-foreground">
                            Per-Symbol Status ({doneCount}/{Object.keys(symbolProgress).length} complete)
                          </span>
                          {backfillExpanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                        </button>
                        {backfillExpanded && (
                          <div className="p-3 space-y-2 max-h-[400px] overflow-y-auto">
                            {Object.entries(symbolProgress).map(([sym, info]) => {
                              const progressPct = info.status === "done" ? 100 : info.pct || 0;
                              return (
                                <div key={sym} className={`rounded-lg border p-2.5 transition-colors ${
                                  info.status === "done" ? "border-green-500/20 bg-green-500/5" :
                                  info.status === "error" ? "border-red-500/20 bg-red-500/5" :
                                  info.status === "downloading" ? "border-blue-500/20 bg-blue-500/5" :
                                  info.status === "retrying" ? "border-amber-500/20 bg-amber-500/5" :
                                  "border-border/20 bg-muted/5"
                                }`}>
                                  <div className="flex items-center justify-between mb-1.5">
                                    <div className="flex items-center gap-2">
                                      {info.status === "done" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> :
                                       info.status === "error" ? <XCircle className="w-3.5 h-3.5 text-red-400" /> :
                                       info.status === "downloading" ? <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" /> :
                                       info.status === "retrying" ? <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" /> :
                                       info.status === "probing" ? <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" /> :
                                       <Circle className="w-3.5 h-3.5 text-muted-foreground" />}
                                      <span className="text-xs font-semibold text-foreground">{sym}</span>
                                      {info.connected ? (
                                        <span className="flex items-center gap-0.5 text-[9px] text-green-400/80">
                                          <Wifi className="w-2.5 h-2.5" /> API OK
                                        </span>
                                      ) : (
                                        <span className="flex items-center gap-0.5 text-[9px] text-red-400/80">
                                          <WifiOff className="w-2.5 h-2.5" /> No Connection
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] tabular-nums">
                                      {info.status === "done" && (
                                        <span className="text-green-400 font-semibold">{formatNumber(info.candles)} records</span>
                                      )}
                                      {info.status === "downloading" && info.expected > 0 && (
                                        <span className="text-blue-400">
                                          {formatNumber(info.candles)} / {formatNumber(info.expected)}
                                          <span className="text-muted-foreground ml-1">({progressPct}%)</span>
                                        </span>
                                      )}
                                      {info.status === "downloading" && info.expected === 0 && info.candles > 0 && (
                                        <span className="text-blue-400">{formatNumber(info.candles)} records</span>
                                      )}
                                      {info.status === "retrying" && (
                                        <span className="text-amber-400">
                                          Retry {info.retryAttempt}/{info.retryMax}
                                        </span>
                                      )}
                                      {info.status === "error" && info.candles > 0 && (
                                        <span className="text-muted-foreground">{formatNumber(info.candles)} partial</span>
                                      )}
                                      {info.timeframe && info.status === "downloading" && (
                                        <span className="text-muted-foreground/60">{info.timeframe}</span>
                                      )}
                                    </div>
                                  </div>

                                  {(info.status === "downloading" || info.status === "done" || info.status === "retrying") && (
                                    <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                                      <div
                                        className={`h-full rounded-full transition-all duration-500 ${
                                          info.status === "done" ? "bg-green-500" :
                                          info.status === "retrying" ? "bg-amber-500" :
                                          "bg-blue-500"
                                        }`}
                                        style={{ width: `${Math.max(progressPct, info.status === "downloading" ? 1 : 0)}%` }}
                                      />
                                    </div>
                                  )}

                                  {info.oldestDate && (
                                    <div className="mt-1 text-[9px] text-muted-foreground/60">
                                      Data available from: {info.oldestDate}
                                      {info.expected > 0 && ` \u2022 ~${formatNumber(info.expected)} total expected`}
                                    </div>
                                  )}

                                  {info.status === "error" && info.error && (
                                    <div className="mt-1.5 p-2 rounded bg-red-500/5 border border-red-500/10">
                                      <div className="flex items-start gap-1.5">
                                        <AlertTriangle className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />
                                        <div>
                                          {info.errorCode && (
                                            <span className="text-[9px] font-mono text-red-400/80 block mb-0.5">
                                              {info.errorCode}
                                            </span>
                                          )}
                                          <p className="text-[10px] text-red-400/70 leading-snug">{info.error}</p>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {initStage === "backtest" && Object.keys(btSymbolResults).length > 0 && (
                      <div className="space-y-1.5 max-h-56 overflow-y-auto rounded-lg border border-border/30 p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-2">Per-Symbol Backtest Results</p>
                        {Object.entries(btSymbolResults).map(([sym, info]) => (
                          <div key={sym} className="flex items-center gap-2 text-xs py-1 border-b border-border/10 last:border-0">
                            <span className="w-20 font-medium truncate">{sym}</span>
                            <span className="flex-1 text-muted-foreground truncate text-[10px]">{info.strategy.replace(/-/g, " ")}</span>
                            {info.tradeCount > 0 && (
                              <>
                                <span className="text-[10px] tabular-nums text-muted-foreground">{info.tradeCount} combos</span>
                                <span className="text-[10px] tabular-nums text-blue-400">WR {(info.winRate * 100).toFixed(0)}%</span>
                                <span className="text-[10px] tabular-nums text-purple-400">PF {info.profitFactor.toFixed(2)}</span>
                                <span className="text-[10px] tabular-nums text-muted-foreground">{info.avgHoldHours.toFixed(0)}h avg</span>
                              </>
                            )}
                            {info.tradeCount === 0 && <BarChart3 className="w-3 h-3 text-purple-400 animate-pulse" />}
                          </div>
                        ))}
                      </div>
                    )}

                    {(initStage === "ai_review" || initStage === "optimise" || initStage === "streaming" || initStage === "complete") && Object.keys(aiReviews).length > 0 && (
                      <div className="space-y-2 max-h-64 overflow-y-auto rounded-lg border border-border/30 p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-2">AI Review Per Symbol</p>
                        {Object.entries(aiReviews).map(([sym, review]) => (
                          <div key={sym} className="p-2 rounded-md bg-muted/10 border border-border/20 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium">{sym}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {review.bestStrategy} — WR {(review.winRate * 100).toFixed(0)}% / PF {review.profitFactor.toFixed(2)}
                              </span>
                            </div>
                            {review.summary && (
                              <p className="text-[11px] text-muted-foreground leading-snug">{review.summary}</p>
                            )}
                            {review.suggestions && review.suggestions.length > 0 && (
                              <ul className="text-[10px] text-muted-foreground/80 list-disc list-inside">
                                {review.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <p className="text-sm text-muted-foreground text-center">{initStatus}</p>

                    {initStage === "error" && (
                      <div className="flex justify-center gap-3 mt-2">
                        <Button variant="outline" onClick={runInitialise} className="px-6">
                          <RefreshCw className="w-4 h-4 mr-2" /> Retry Setup
                        </Button>
                        <Button
                          variant="outline"
                          onClick={handleResetSetup}
                          disabled={resetting}
                          className="px-6 border-destructive/30 text-destructive hover:bg-destructive/10"
                        >
                          <RotateCcw className="w-4 h-4 mr-2" /> {resetting ? "Resetting..." : "Reset & Start Over"}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center space-y-4">
                    <Database className="w-10 h-10 text-blue-400 mx-auto" />
                    <h2 className="text-lg font-semibold">System Initialisation</h2>
                    <p className="text-muted-foreground text-sm max-w-md mx-auto">
                      Download all available 1m & 5m price history, run all 4 strategies per symbol
                      as backtests, and AI-optimise your settings. This may take a while.
                    </p>
                    <div className="flex justify-center gap-3">
                      <Button variant="outline" onClick={goBack} className="px-6">
                        <ArrowLeft className="w-4 h-4 mr-2" /> Back
                      </Button>
                      <Button onClick={runInitialise}>
                        Start Initialisation <ArrowRight className="w-4 h-4 ml-2" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === "complete" && (
              <div className="text-center space-y-6">
                <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-8 h-8 text-green-500" />
                </div>
                <div className="space-y-3">
                  <h2 className="text-xl font-semibold text-foreground">You're All Set!</h2>
                  <p className="text-muted-foreground text-sm max-w-md mx-auto">
                    Your platform has been configured with AI-optimised parameters based on
                    full historical backtested data.
                  </p>
                  <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm">
                    <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                      <p className="text-xs text-muted-foreground">Candles Loaded</p>
                      <p className="font-bold tabular-nums">{candleTotal > 0 ? candleTotal.toLocaleString() : "\u2014"}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                      <p className="text-xs text-muted-foreground">Backtests Run</p>
                      <p className="font-bold tabular-nums">{btCompleted > 0 ? btCompleted : "\u2014"}</p>
                    </div>
                  </div>
                  {failedSymbols.length > 0 && (
                    <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 max-w-sm mx-auto">
                      <p className="text-xs text-amber-400 font-medium mb-1">
                        {[...new Set(failedSymbols.map(f => f.symbol))].length} symbol(s) had download issues
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {[...new Set(failedSymbols.map(f => f.symbol))].join(", ")} — re-download from Research &gt; Data Status.
                      </p>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground max-w-md mx-auto">
                  All modes start inactive. Enable Paper, Demo, or Real trading from the Settings page
                  when you're ready.
                </p>
                <Button size="lg" onClick={onComplete} className="px-8">
                  Go to Dashboard <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
