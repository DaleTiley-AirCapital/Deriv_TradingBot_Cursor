import { ensureWorkerJobsTable } from "../core/worker/jobs.js";
import { runWorkerLoop } from "../core/worker/runner.js";

async function main() {
  console.log("[worker] booting generic worker service...");
  await ensureWorkerJobsTable();
  console.log("[worker] worker_jobs schema ready");
  await runWorkerLoop();
}

main().catch((error) => {
  console.error("[worker] fatal startup error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
