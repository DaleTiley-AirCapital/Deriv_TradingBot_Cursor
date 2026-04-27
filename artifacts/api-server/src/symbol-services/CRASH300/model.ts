import { db, platformStateTable } from "@workspace/db";
import { getPromotedSymbolRuntimeModel, getStagedSymbolRuntimeModel, promoteStagedSymbolRuntimeModel, stageLatestSymbolResearchProfile } from "../../core/calibration/promotedSymbolModel.js";

const SYMBOL = "CRASH300";

function asMap(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

export async function loadCrash300RuntimeEnvelope() {
  const [stagedModel, promotedModel] = await Promise.all([
    getStagedSymbolRuntimeModel(SYMBOL),
    getPromotedSymbolRuntimeModel(SYMBOL),
  ]);
  return {
    symbol: SYMBOL,
    stagedModel,
    promotedModel,
  };
}

export async function stageCrash300RuntimeModel() {
  const stateMap = asMap(await db.select().from(platformStateTable));
  const staged = await stageLatestSymbolResearchProfile(SYMBOL, stateMap);
  if (!staged) {
    throw new Error("CRASH300 runtime model missing: no research profile to stage.");
  }
  return loadCrash300RuntimeEnvelope();
}

export async function promoteCrash300StagedRuntimeModel() {
  const promoted = await promoteStagedSymbolRuntimeModel(SYMBOL);
  if (!promoted) {
    throw new Error("CRASH300 runtime model missing/invalid. Cannot evaluate symbol service.");
  }
  return loadCrash300RuntimeEnvelope();
}
