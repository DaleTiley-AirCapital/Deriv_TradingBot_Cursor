/**
 * Debug: run AI precursor pass for one detected_moves.id (writes precursor row on success).
 *
 * Prerequisites: DATABASE_URL, OpenAI key in platform_state (same as API server).
 *
 *   CALIBRATION_AI_DEBUG=1 pnpm --filter @workspace/api-server exec tsx scripts/debug-precursor-move.ts 396
 *
 * Or from artifacts/api-server with env loaded:
 *
 *   CALIBRATION_AI_DEBUG=1 npx tsx scripts/debug-precursor-move.ts 396
 */

import { db } from "@workspace/db";
import { detectedMovesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runPrecursorPass } from "../src/core/calibration/passes/precursorPass.js";

const id = Number(process.argv[2]);
if (!Number.isFinite(id)) {
  console.error("Usage: tsx scripts/debug-precursor-move.ts <detected_move_id>");
  process.exit(1);
}

process.env.CALIBRATION_AI_DEBUG = "1";

const rows = await db.select().from(detectedMovesTable).where(eq(detectedMovesTable.id, id)).limit(1);
const move = rows[0];
if (!move) {
  console.error(`detected_moves id=${id} not found`);
  process.exit(1);
}

console.log("[debug] move", {
  id: move.id,
  symbol: move.symbol,
  moveType: move.moveType,
  startTs: move.startTs,
});

try {
  await runPrecursorPass(move, 0);
  console.log("[debug] OK — precursor row inserted (passRunId omitted for debug)");
} catch (e) {
  console.error("[debug] FAILED", e);
  process.exit(1);
}
