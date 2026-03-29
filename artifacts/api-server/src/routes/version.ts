import { Router } from "express";
import { APP_VERSION, APP_NAME, LAST_UPDATED, RELEASES } from "../lib/version.js";

const router = Router();

router.get("/version", (_req, res) => {
  res.json({
    name: APP_NAME,
    version: APP_VERSION,
    lastUpdated: LAST_UPDATED,
    releases: RELEASES,
  });
});

export default router;
