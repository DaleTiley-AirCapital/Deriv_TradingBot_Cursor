export type WorkerTaskType =
  | "elite_synthesis"
  | "full_calibration"
  | "calibration_passes"
  | "runtime_backtest"
  | "parity_run"
  | "runtime_trigger_validation";

export type WorkerJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkerTaskState = Record<string, unknown>;

export type WorkerJobRow = {
  id: number;
  taskType: WorkerTaskType;
  serviceId: string;
  symbol: string;
  status: WorkerJobStatus;
  stage: string;
  params: Record<string, unknown> | null;
  taskState: WorkerTaskState | null;
  progressPct: number;
  message: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: Record<string, unknown> | null;
  resultSummary: Record<string, unknown> | null;
  resultArtifact: unknown;
  createdAt: string | null;
  updatedAt: string | null;
};
