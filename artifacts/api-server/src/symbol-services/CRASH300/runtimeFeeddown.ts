import { getPromotedSymbolRuntimeModel, getStagedSymbolRuntimeModel } from "../../core/calibration/promotedSymbolModel.js";

const SYMBOL = "CRASH300";

export async function getCrash300RuntimeFeeddown() {
  const [stagedModel, promotedModel] = await Promise.all([
    getStagedSymbolRuntimeModel(SYMBOL),
    getPromotedSymbolRuntimeModel(SYMBOL),
  ]);
  return {
    symbol: SYMBOL,
    stagedModel,
    promotedModel,
    hasPromotedModel: Boolean(promotedModel),
  };
}
