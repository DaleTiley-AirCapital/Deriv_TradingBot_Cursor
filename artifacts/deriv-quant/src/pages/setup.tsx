import { useState, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, Circle, Loader2, AlertCircle, Database, BarChart3, Zap, ArrowRight } from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";
const api = (path: string) => `${BASE}api${path}`;

type Step = "welcome" | "preflight" | "backfill" | "analyse" | "complete";

async function consumeSSE(
  url: string,
  onEvent: (evt: Record<string, unknown>) => void,
  signal?: AbortSignal,
  method = "POST",
) {
  const res = await fetch(url, { method, signal });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No stream");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {}
    }
  }
}

export default function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [preflightResult, setPreflightResult] = useState<{ deriv: boolean; openai: boolean } | null>(null);
  const [backfillProgress, setBackfillProgress] = useState(0);
  const [backfillStatus, setBackfillStatus] = useState("");
  const [analyseProgress, setAnalyseProgress] = useState(0);
  const [analyseStatus, setAnalyseStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const completedRef = useRef(false);
  const queryClient = useQueryClient();

  const runPreflight = useCallback(async () => {
    setStep("preflight");
    setError(null);
    try {
      const res = await fetch(api("/setup/preflight"), { method: "POST" });
      const data = await res.json();
      setPreflightResult({ deriv: data.deriv?.ok ?? false, openai: data.openai?.ok ?? false });
      setStep("backfill");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight check failed");
      setStep("welcome");
    }
  }, []);

  const runBackfill = useCallback(async () => {
    setError(null);
    setBackfillProgress(1);
    setBackfillStatus("Starting data backfill...");
    abortRef.current = new AbortController();
    completedRef.current = false;
    try {
      await consumeSSE(api("/setup/backfill"), (evt) => {
        const phase = evt.phase as string;
        if (phase === "start") {
          setBackfillStatus(evt.message as string);
        } else if (phase === "symbol_start" || phase === "symbol_progress") {
          const pct = Math.round(((evt.symbolIndex as number) / (evt.totalSymbols as number)) * 100);
          setBackfillProgress(Math.max(pct, 1));
          setBackfillStatus(evt.message as string);
        } else if (phase === "symbol_done") {
          const pct = Math.round((((evt.symbolIndex as number) + 1) / (evt.totalSymbols as number)) * 100);
          setBackfillProgress(pct);
          setBackfillStatus(evt.message as string);
        } else if (phase === "backfill_complete") {
          completedRef.current = true;
          setBackfillProgress(100);
          setBackfillStatus(evt.message as string);
          setStep("analyse");
        } else if (phase === "error") {
          setError(evt.message as string);
        }
      }, abortRef.current.signal);
      if (!completedRef.current && !error) {
        setBackfillProgress(100);
        setStep("analyse");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Backfill failed");
      }
    }
  }, [error]);

  const runAnalyse = useCallback(async () => {
    setError(null);
    setAnalyseProgress(1);
    setAnalyseStatus("Starting AI analysis & optimisation...");
    abortRef.current = new AbortController();
    completedRef.current = false;
    try {
      await consumeSSE(api("/setup/initial-analyse"), (evt) => {
        const phase = evt.phase as string;
        if (phase === "start") {
          setAnalyseStatus(evt.message as string);
        } else if (phase === "progress") {
          const pct = Math.round(((evt.completed as number) / (evt.total as number)) * 90);
          setAnalyseProgress(Math.max(pct, 1));
          setAnalyseStatus(evt.message as string);
        } else if (phase === "complete") {
          completedRef.current = true;
          setAnalyseProgress(100);
          setAnalyseStatus("Setup complete!");
          queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
          queryClient.invalidateQueries({ queryKey: ["/api/setup/status"] });
          setStep("complete");
        } else if (phase === "error") {
          setError(evt.message as string);
        }
      }, abortRef.current.signal);
      if (!completedRef.current && !error) {
        setAnalyseProgress(100);
        setStep("complete");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Analysis failed");
      }
    }
  }, [queryClient, error]);

  const stepIndex = { welcome: 0, preflight: 1, backfill: 2, analyse: 3, complete: 4 }[step];

  const steps = [
    { label: "Welcome" },
    { label: "Preflight" },
    { label: "Data Backfill" },
    { label: "AI Analysis" },
    { label: "Ready" },
  ];

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Zap className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Deriv Capital Extraction App</h1>
          <p className="text-muted-foreground mt-2">Initial Setup</p>
        </div>

        <div className="flex items-center justify-center gap-2 mb-8">
          {steps.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                i < stepIndex ? "bg-green-500/10 text-green-400" :
                i === stepIndex ? "bg-primary/10 text-primary" :
                "bg-muted/30 text-muted-foreground"
              }`}>
                {i < stepIndex ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                 i === stepIndex && step !== "welcome" && step !== "complete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                 i === stepIndex && step === "complete" ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                 <Circle className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{s.label}</span>
              </div>
              {i < steps.length - 1 && <ArrowRight className="w-3 h-3 text-muted-foreground/40" />}
            </div>
          ))}
        </div>

        <Card className="border-border/50 bg-card">
          <CardContent className="p-8">
            {error && (
              <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-destructive">Error</p>
                  <p className="text-sm text-destructive/80 mt-1">{error}</p>
                </div>
              </div>
            )}

            {step === "welcome" && (
              <div className="text-center space-y-6">
                <div className="space-y-3">
                  <h2 className="text-xl font-semibold text-foreground">Welcome</h2>
                  <p className="text-muted-foreground leading-relaxed max-w-md mx-auto">
                    This wizard will configure your platform by fetching historical market data,
                    running backtests across all strategies, and optimising your trading parameters using AI.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-4 max-w-lg mx-auto">
                  <div className="p-4 rounded-lg bg-muted/20 text-center">
                    <Database className="w-6 h-6 text-blue-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Fetch 24 months of data</p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/20 text-center">
                    <BarChart3 className="w-6 h-6 text-green-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Run strategy backtests</p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/20 text-center">
                    <Zap className="w-6 h-6 text-yellow-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">AI-optimise settings</p>
                  </div>
                </div>
                <Button size="lg" onClick={runPreflight} className="px-8">
                  Begin Setup <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {step === "preflight" && (
              <div className="text-center space-y-4">
                <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
                <h2 className="text-lg font-semibold">Running Preflight Checks...</h2>
                <p className="text-muted-foreground text-sm">Verifying API connections</p>
              </div>
            )}

            {step === "backfill" && (
              <div className="space-y-6">
                {preflightResult && (
                  <div className="flex gap-4 justify-center mb-4">
                    <div className={`flex items-center gap-2 text-sm ${preflightResult.deriv ? "text-green-400" : "text-yellow-400"}`}>
                      {preflightResult.deriv ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                      Deriv API {preflightResult.deriv ? "Connected" : "Not configured"}
                    </div>
                    <div className={`flex items-center gap-2 text-sm ${preflightResult.openai ? "text-green-400" : "text-yellow-400"}`}>
                      {preflightResult.openai ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                      OpenAI {preflightResult.openai ? "Connected" : "Not configured"}
                    </div>
                  </div>
                )}

                {backfillProgress > 0 ? (
                  <div className="space-y-3">
                    <h2 className="text-lg font-semibold text-center">Fetching Historical Data</h2>
                    <Progress value={backfillProgress} className="h-2" />
                    <p className="text-sm text-muted-foreground text-center">{backfillStatus}</p>
                  </div>
                ) : (
                  <div className="text-center space-y-4">
                    <Database className="w-10 h-10 text-blue-400 mx-auto" />
                    <h2 className="text-lg font-semibold">Data Backfill</h2>
                    <p className="text-muted-foreground text-sm max-w-md mx-auto">
                      Fetch 24 months of historical candle data for all supported instruments.
                      This may take a few minutes.
                    </p>
                    <Button onClick={runBackfill}>
                      Start Backfill <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                )}
              </div>
            )}

            {step === "analyse" && (
              <div className="space-y-6">
                {analyseProgress > 0 ? (
                  <div className="space-y-3">
                    <h2 className="text-lg font-semibold text-center">AI Analysis & Optimisation</h2>
                    <Progress value={analyseProgress} className="h-2" />
                    <p className="text-sm text-muted-foreground text-center">{analyseStatus}</p>
                  </div>
                ) : (
                  <div className="text-center space-y-4">
                    <BarChart3 className="w-10 h-10 text-green-400 mx-auto" />
                    <h2 className="text-lg font-semibold">AI Analysis</h2>
                    <p className="text-muted-foreground text-sm max-w-md mx-auto">
                      Run backtests across all strategy/instrument combinations and let AI
                      optimise your TP, SL, position sizing, and trailing stop parameters.
                    </p>
                    <Button onClick={runAnalyse}>
                      Start Analysis <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                )}
              </div>
            )}

            {step === "complete" && (
              <div className="text-center space-y-6">
                <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-8 h-8 text-green-400" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-semibold">Setup Complete</h2>
                  <p className="text-muted-foreground text-sm max-w-md mx-auto">
                    Your platform is configured and ready. All strategies have been backtested
                    and settings have been AI-optimised for each trading mode.
                  </p>
                </div>
                <Button size="lg" onClick={onComplete} className="px-8">
                  Enter Platform <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
