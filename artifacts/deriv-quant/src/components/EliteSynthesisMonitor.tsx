import { useEffect, useMemo, useState } from "react";
import { CheckCircle, ChevronDown, ChevronRight, FlaskConical, Loader2, Minimize2, Square, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ELITE_SYNTHESIS_STORAGE_KEY,
  type EliteSynthesisActiveJob,
  type EliteSynthesisJobProgress,
  readActiveEliteSynthesisJob,
  writeActiveEliteSynthesisJob,
} from "@/lib/eliteSynthesis";

const BASE = import.meta.env.BASE_URL || "/";

async function apiFetch(path: string, opts?: RequestInit) {
  const response = await fetch(`${BASE}api/${path.replace(/^\//, "")}`, opts);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      message = data.error ?? data.message ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return response.json();
}

function elapsedLabel(startedAt: string | null) {
  if (!startedAt) return "n/a";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins <= 0) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function heartbeatAgeLabel(heartbeatAt: string | null) {
  if (!heartbeatAt) return "n/a";
  const ms = Date.now() - new Date(heartbeatAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  return `${Math.floor(ms / 1000)}s ago`;
}

type EliteSynthesisMonitorProps = {
  variant?: "sidebar" | "floating";
  className?: string;
};

export function EliteSynthesisMonitor({ variant = "sidebar", className }: EliteSynthesisMonitorProps) {
  const [activeJob, setActiveJob] = useState<EliteSynthesisActiveJob | null>(() => readActiveEliteSynthesisJob());
  const [progress, setProgress] = useState<EliteSynthesisJobProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const sync = () => setActiveJob(readActiveEliteSynthesisJob());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(ELITE_SYNTHESIS_STORAGE_KEY, sync as EventListener);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(ELITE_SYNTHESIS_STORAGE_KEY, sync as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!activeJob) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await apiFetch(`research/${activeJob.serviceId}/elite-synthesis/jobs/${activeJob.jobId}`) as {
          job?: EliteSynthesisJobProgress;
        };
        if (cancelled) return;
        const job = data.job ?? null;
        setProgress(job);
        setErr(null);
        if (!job) return;
        if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
          writeActiveEliteSynthesisJob(null);
          window.dispatchEvent(new Event(ELITE_SYNTHESIS_STORAGE_KEY));
        }
      } catch (error) {
        if (!cancelled) setErr(error instanceof Error ? error.message : "Elite synthesis monitor failed");
      }
    };
    void tick();
    const handle = window.setInterval(() => { void tick(); }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [activeJob]);

  useEffect(() => {
    if (progress && (progress.status === "running" || progress.status === "queued")) {
      setExpanded(true);
    }
  }, [progress]);

  const visible = Boolean(activeJob || progress || err);
  const stageLabel = useMemo(() => (progress?.stage ?? "queued").replace(/_/g, " "), [progress?.stage]);
  const progressPct = Math.max(0, Math.min(100, progress?.progressPct ?? 0));

  const cancelJob = async () => {
    if (!activeJob) return;
    try {
      await apiFetch(`research/${activeJob.serviceId}/elite-synthesis/jobs/${activeJob.jobId}/cancel`, {
        method: "POST",
      });
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Failed to cancel elite synthesis job");
    }
  };

  if (!visible) return null;

  const summary = (
    <button
      type="button"
      onClick={() => setExpanded((value) => !value)}
      className={cn(
        "w-full rounded-xl border border-cyan-500/25 bg-slate-950/95 px-3 py-3 text-left shadow-lg transition-colors hover:bg-slate-950",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-cyan-100 flex items-center gap-1.5">
            <FlaskConical className="w-3.5 h-3.5" />
            Integrated Elite Synthesis
          </p>
          <p className="text-[11px] text-muted-foreground mt-1 truncate">
            {activeJob?.serviceId ?? progress?.serviceId ?? "service"} {progress ? `#${progress.jobId}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {progress?.status === "running" || progress?.status === "queued" ? (
            <span className="inline-flex items-center gap-1 rounded border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[10px] text-cyan-100">
              <Loader2 className="w-3 h-3 animate-spin" />
              {progressPct}%
            </span>
          ) : progress?.status === "completed" ? (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200">
              <CheckCircle className="w-3 h-3" />
              Done
            </span>
          ) : progress?.status === "failed" ? (
            <span className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
              <XCircle className="w-3 h-3" />
              Failed
            </span>
          ) : null}
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      <div className="mt-2 space-y-1">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="truncate">{progress?.message ?? err ?? "Waiting for progress..."}</span>
          <span className="font-mono text-cyan-200">{progressPct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-background/80">
          <div className="h-full bg-cyan-400 transition-all duration-300" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </button>
  );

  if (variant === "sidebar") {
    return (
      <div className="px-4 pt-3 relative">
        {summary}
        {expanded && (
          <div className="absolute left-[calc(100%-8px)] top-3 z-[70] w-[340px] rounded-xl border border-cyan-500/25 bg-slate-950/95 p-3 shadow-2xl space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-cyan-100">Integrated Elite Synthesis</p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {activeJob?.serviceId ?? progress?.serviceId ?? "service"} {progress ? `#${progress.jobId}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {(progress?.status === "running" || progress?.status === "queued") && (
                  <button
                    type="button"
                    onClick={() => void cancelJob()}
                    className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/20"
                  >
                    <Square className="w-3 h-3" />
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="inline-flex items-center gap-1 rounded border border-border/40 bg-background/40 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Minimize2 className="w-3 h-3" />
                  Minimise
                </button>
              </div>
            </div>

            {progress && (
              <>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded border border-border/30 bg-background/40 p-2">
                    <p className="text-muted-foreground">Pass</p>
                    <p className="font-mono text-foreground">{progress.currentPass}/{progress.maxPasses}</p>
                  </div>
                  <div className="rounded border border-border/30 bg-background/40 p-2">
                    <p className="text-muted-foreground">Best WR</p>
                    <p className="font-mono text-foreground">{progress.bestWinRate == null ? "n/a" : `${(progress.bestWinRate * 100).toFixed(2)}%`}</p>
                  </div>
                  <div className="rounded border border-border/30 bg-background/40 p-2">
                    <p className="text-muted-foreground">Best SL</p>
                    <p className="font-mono text-foreground">{progress.bestSlRate == null ? "n/a" : `${(progress.bestSlRate * 100).toFixed(2)}%`}</p>
                  </div>
                  <div className="rounded border border-border/30 bg-background/40 p-2">
                    <p className="text-muted-foreground">PF / Trades</p>
                    <p className="font-mono text-foreground">
                      {progress.bestProfitFactor == null ? "n/a" : progress.bestProfitFactor.toFixed(2)} / {progress.bestTradeCount ?? "n/a"}
                    </p>
                  </div>
                </div>
                <div className="space-y-1 text-[11px] text-muted-foreground">
                  <p>Stage: <span className="text-foreground">{stageLabel}</span></p>
                  <p>Message: <span className="text-foreground">{progress.message || "Processing"}</span></p>
                  <p>Heartbeat: <span className="text-foreground">{heartbeatAgeLabel(progress.heartbeatAt)}</span></p>
                  <p>Elapsed: <span className="text-foreground">{elapsedLabel(progress.startedAt)}</span></p>
                </div>
              </>
            )}

            {err && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-[11px] text-amber-100">
                {err}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-[340px]">
      {summary}
    </div>
  );
}
