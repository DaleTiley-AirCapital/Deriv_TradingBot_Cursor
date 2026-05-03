export const ELITE_SYNTHESIS_STORAGE_KEY = "deriv_elite_synthesis_active_job";

export type EliteSynthesisActiveJob = {
  jobId: number;
  serviceId: string;
  symbol: string;
};

export type EliteSynthesisJobProgress = {
  jobId: number;
  serviceId: string;
  symbol: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  progressPct: number;
  currentPass: number;
  maxPasses: number;
  currentPolicyCount: number;
  evaluatedPolicyCount: number;
  bestWinRate: number | null;
  bestSlRate: number | null;
  bestProfitFactor: number | null;
  bestTradeCount: number | null;
  bestObjectiveScore: number | null;
  bestPolicyId: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: Record<string, unknown> | null;
  message: string;
};

export function readActiveEliteSynthesisJob(): EliteSynthesisActiveJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ELITE_SYNTHESIS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EliteSynthesisActiveJob;
    if (!Number.isInteger(parsed.jobId) || parsed.jobId <= 0 || !parsed.serviceId || !parsed.symbol) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeActiveEliteSynthesisJob(job: EliteSynthesisActiveJob | null) {
  if (typeof window === "undefined") return;
  try {
    if (!job) {
      window.localStorage.removeItem(ELITE_SYNTHESIS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(ELITE_SYNTHESIS_STORAGE_KEY, JSON.stringify(job));
  } catch {
    // ignore storage errors
  }
}
