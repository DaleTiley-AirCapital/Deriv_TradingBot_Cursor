import { Router } from "express";
import { APP_VERSION } from "../version.js";

const router = Router();

const PROCESS_STARTED_AT_MS = Date.now();

router.get("/deploy-status", (_req, res) => {
  const nowMs = Date.now();
  const startedAtIso = new Date(PROCESS_STARTED_AT_MS).toISOString();
  const uptimeSeconds = Math.max(0, Math.floor((nowMs - PROCESS_STARTED_AT_MS) / 1000));

  res.json({
    provider: "railway",
    appVersion: APP_VERSION,
    status: "running",
    lastRebuildAt: startedAtIso,
    processStartedAt: startedAtIso,
    uptimeSeconds,
    commitSha: process.env["RAILWAY_GIT_COMMIT_SHA"] || process.env["SOURCE_COMMIT"] || null,
    deploymentId: process.env["RAILWAY_DEPLOYMENT_ID"] || null,
    environmentName: process.env["RAILWAY_ENVIRONMENT_NAME"] || null,
    serviceName: process.env["RAILWAY_SERVICE_NAME"] || null,
  });
});

export default router;

