import { Router } from "express";
import {
  APP_VERSION,
  APP_NAME,
  LAST_UPDATED,
  RELEASES,
  DEPLOYED_AT,
  DEPLOYMENT_ID,
  GIT_COMMIT_SHA,
  GIT_COMMIT_MESSAGE,
} from "../version.js";

const router = Router();

router.get("/version", (_req, res) => {
  res.json({
    name: APP_NAME,
    version: APP_VERSION,
    lastUpdated: LAST_UPDATED,
    deployedAt: DEPLOYED_AT,
    deploymentId: DEPLOYMENT_ID,
    gitCommitSha: GIT_COMMIT_SHA,
    gitCommitMessage: GIT_COMMIT_MESSAGE,
    releases: RELEASES,
  });
});

export default router;
