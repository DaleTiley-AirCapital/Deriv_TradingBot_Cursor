export type WorkerTaskTypeUi =
  | "elite_synthesis"
  | "full_calibration"
  | "calibration_passes"
  | "runtime_backtest"
  | "parity_run"
  | "runtime_trigger_validation";

export type WorkerJobUi = {
  id: number;
  taskType: WorkerTaskTypeUi;
  serviceId: string;
  symbol: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  progressPct: number;
  message: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  taskState: Record<string, unknown>;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: Record<string, unknown> | null;
};

export function formatWorkerTaskLabel(taskType: WorkerTaskTypeUi | string): string {
  switch (taskType) {
    case "elite_synthesis":
      return "Build Runtime Model";
    case "full_calibration":
      return "Full Calibration";
    case "calibration_passes":
      return "Calibration Passes";
    case "runtime_backtest":
      return "Validate Runtime";
    case "parity_run":
      return "Validate Runtime";
    case "runtime_trigger_validation":
      return "Validate Runtime";
    default:
      return taskType.replace(/_/g, " ");
  }
}
