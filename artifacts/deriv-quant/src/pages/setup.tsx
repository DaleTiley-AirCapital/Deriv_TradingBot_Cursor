import { useState, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Circle, Loader2, AlertCircle, Database, BarChart3, Zap, ArrowRight, ArrowLeft, Key, Eye, EyeOff } from "lucide-react";

const BASE = import.meta.env.BASE_URL || "/";
const api = (path: string) => `${BASE}api${path}`;

type Step = "welcome" | "apikeys" | "testing" | "initialise" | "complete";

async function consumeSSE(
  url: string,
  onEvent: (evt: Record<string, unknown>) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(url, { method: "POST", signal });
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
  const [initStage, setInitStage] = useState<"backfill" | "backtest" | "optimise" | "complete">("backfill");
  const [initStatus, setInitStatus] = useState("");
  const [candleTotal, setCandleTotal] = useState(0);
  const [btCompleted, setBtCompleted] = useState(0);
  const [btTotal, setBtTotal] = useState(0);
  const [estRemainingSec, setEstRemainingSec] = useState(0);

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
    setInitStatus("Starting initialisation...");
    setCandleTotal(0);
    setBtCompleted(0);
    setBtTotal(0);
    setEstRemainingSec(0);
    abortRef.current = new AbortController();
    completedRef.current = false;

    try {
      await consumeSSE(api("/setup/initialise"), (evt) => {
        const phase = evt.phase as string;
        const pct = (evt.overallPct as number) || 0;

        if (phase === "backfill_start") {
          setInitStage("backfill");
          setInitStatus(evt.message as string);
        } else if (phase === "backfill_progress") {
          setInitStage("backfill");
          setInitProgress(Math.max(pct, 1));
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
          setEstRemainingSec(evt.estRemainingSec as number || 0);
        } else if (phase === "backfill_symbol_done") {
          setInitProgress(Math.max(pct, 1));
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
        } else if (phase === "backfill_complete") {
          setInitProgress(50);
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
          setEstRemainingSec(0);
        } else if (phase === "backtest_start") {
          setInitStage("backtest");
          setBtTotal(evt.btTotal as number || 0);
          setInitStatus(evt.message as string);
        } else if (phase === "backtest_progress") {
          setInitStage("backtest");
          setInitProgress(Math.max(pct, 50));
          setBtCompleted(evt.btCompleted as number || 0);
          setBtTotal(evt.btTotal as number || 0);
          setCandleTotal(evt.candleTotal as number || 0);
          setEstRemainingSec(evt.estRemainingSec as number || 0);
          setInitStatus(evt.message as string);
        } else if (phase === "optimising") {
          setInitStage("optimise");
          setInitProgress(95);
          setInitStatus(evt.message as string);
          setEstRemainingSec(0);
        } else if (phase === "complete") {
          completedRef.current = true;
          setInitStage("complete");
          setInitProgress(100);
          setInitStatus(evt.message as string);
          setCandleTotal(evt.candleTotal as number || 0);
          setBtCompleted(evt.btCompleted as number || 0);
          setEstRemainingSec(0);
          queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
          queryClient.invalidateQueries({ queryKey: ["/api/setup/status"] });
          setStep("complete");
        } else if (phase === "error") {
          setError(evt.message as string);
        }
      }, abortRef.current.signal);

      if (!completedRef.current) {
        setInitProgress(100);
        setStep("complete");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Initialisation failed");
      }
    }
  }, [queryClient]);

  const stepDefs = [
    { label: "Welcome" },
    { label: "API Keys" },
    { label: "Initialise" },
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
                    Before trading, the system needs to download 24 months of price history
                    and run all strategies as backtests across every index. The AI will then
                    recommend your optimal starting settings.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-4 max-w-lg mx-auto">
                  <div className="p-4 rounded-lg bg-muted/20 text-center">
                    <Key className="w-6 h-6 text-yellow-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Connect API keys</p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/20 text-center">
                    <Database className="w-6 h-6 text-blue-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Download 24 months of trading history</p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/20 text-center">
                    <BarChart3 className="w-6 h-6 text-green-400 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Run all strategies & AI optimise</p>
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
                        {initStage === "backfill" && "Downloading Price History"}
                        {initStage === "backtest" && "Running Strategy Backtests"}
                        {initStage === "optimise" && "AI Optimising Settings"}
                        {initStage === "complete" && "Setup Complete"}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {initStage === "backfill" && "Fetching 24 months of candle data from Deriv"}
                        {initStage === "backtest" && "Testing all strategies across every index"}
                        {initStage === "optimise" && "Calculating optimal parameters from backtest results"}
                        {initStage === "complete" && "Your platform is ready"}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                        <span>{initProgress}%</span>
                        {estRemainingSec > 0 && (
                          <span>~{formatTime(estRemainingSec)} remaining</span>
                        )}
                      </div>
                      <Progress value={initProgress} className="h-3" />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className={`p-3 rounded-lg border text-center transition-colors ${
                        initStage === "backfill" ? "bg-blue-500/10 border-blue-500/30" :
                        initProgress >= 50 ? "bg-green-500/5 border-green-500/20" :
                        "bg-muted/20 border-border/40"
                      }`}>
                        <Database className={`w-5 h-5 mx-auto mb-1 ${
                          initStage === "backfill" ? "text-blue-400" :
                          initProgress >= 50 ? "text-green-400" : "text-muted-foreground"
                        }`} />
                        <p className="text-xs font-medium">Candles</p>
                        <p className="text-sm font-bold tabular-nums mt-0.5">
                          {candleTotal > 0 ? candleTotal.toLocaleString() : "—"}
                        </p>
                      </div>
                      <div className={`p-3 rounded-lg border text-center transition-colors ${
                        initStage === "backtest" ? "bg-purple-500/10 border-purple-500/30" :
                        btCompleted > 0 && btCompleted >= btTotal ? "bg-green-500/5 border-green-500/20" :
                        "bg-muted/20 border-border/40"
                      }`}>
                        <BarChart3 className={`w-5 h-5 mx-auto mb-1 ${
                          initStage === "backtest" ? "text-purple-400" :
                          btCompleted > 0 && btCompleted >= btTotal ? "text-green-400" : "text-muted-foreground"
                        }`} />
                        <p className="text-xs font-medium">Backtests</p>
                        <p className="text-sm font-bold tabular-nums mt-0.5">
                          {btTotal > 0 ? `${btCompleted} / ${btTotal}` : "—"}
                        </p>
                      </div>
                      <div className={`p-3 rounded-lg border text-center transition-colors ${
                        initStage === "optimise" ? "bg-emerald-500/10 border-emerald-500/30" :
                        initStage === "complete" ? "bg-green-500/5 border-green-500/20" :
                        "bg-muted/20 border-border/40"
                      }`}>
                        <Zap className={`w-5 h-5 mx-auto mb-1 ${
                          initStage === "optimise" ? "text-emerald-400 animate-pulse" :
                          initStage === "complete" ? "text-green-400" : "text-muted-foreground"
                        }`} />
                        <p className="text-xs font-medium">AI Optimise</p>
                        <p className="text-sm font-bold tabular-nums mt-0.5">
                          {initStage === "complete" ? "Done" : initStage === "optimise" ? "Running" : "Pending"}
                        </p>
                      </div>
                    </div>

                    <p className="text-sm text-muted-foreground text-center">{initStatus}</p>
                  </div>
                ) : (
                  <div className="text-center space-y-4">
                    <Database className="w-10 h-10 text-blue-400 mx-auto" />
                    <h2 className="text-lg font-semibold">System Initialisation</h2>
                    <p className="text-muted-foreground text-sm max-w-md mx-auto">
                      Download 24 months of trading history, run all strategies as backtests
                      across every index, and AI-optimise your settings. This may take several minutes.
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
                    24 months of backtested data.
                  </p>
                  <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm">
                    <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                      <p className="text-xs text-muted-foreground">Candles Loaded</p>
                      <p className="font-bold tabular-nums">{candleTotal > 0 ? candleTotal.toLocaleString() : "—"}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                      <p className="text-xs text-muted-foreground">Backtests Run</p>
                      <p className="font-bold tabular-nums">{btCompleted > 0 ? btCompleted : "—"}</p>
                    </div>
                  </div>
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
