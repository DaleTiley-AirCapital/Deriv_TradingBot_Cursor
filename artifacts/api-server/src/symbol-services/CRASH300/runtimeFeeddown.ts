import { getPromotedSymbolRuntimeModel, getStagedSymbolRuntimeModel } from "../../core/calibration/promotedSymbolModel.js";
import type { PromotedSymbolRuntimeModel } from "../../core/calibration/promotedSymbolModel.js";

const SYMBOL = "CRASH300";
const FORBIDDEN_FAMILY_TOKENS = [
  "boom_expansion",
  "boom",
  "breakout",
  "continuation",
];

export interface Crash300RuntimeValidationResult {
  valid: boolean;
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readTargetPct(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function deepContainsForbiddenToken(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    const found = FORBIDDEN_FAMILY_TOKENS.find((token) => lower.includes(token));
    return found ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepContainsForbiddenToken(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = deepContainsForbiddenToken(v);
      if (found) return found;
    }
  }
  return null;
}

function validateBucketKey(key: string): boolean {
  const parts = key.split("|");
  if (parts.length !== 3) return false;
  const [direction, leadIn, quality] = parts;
  const validDirection = direction === "up" || direction === "down" || direction === "all";
  const validLeadIn = leadIn === "expanding" || leadIn === "compressing" || leadIn === "ranging" || leadIn === "trending" || leadIn === "all";
  const validQuality = quality === "A" || quality === "B" || quality === "C" || quality === "all";
  return validDirection && validLeadIn && validQuality;
}

export function validateCrash300RuntimeModel(
  model: PromotedSymbolRuntimeModel | null,
): Crash300RuntimeValidationResult {
  const errors: string[] = [];
  if (!model) {
    errors.push("runtime_model_missing");
    return { valid: false, errors };
  }

  if (String(model.symbol).toUpperCase() !== SYMBOL) {
    errors.push(`symbol_mismatch:${model.symbol}`);
  }
  if (!Number.isFinite(Number(model.sourceRunId)) || Number(model.sourceRunId) <= 0) {
    errors.push("source_run_id_missing");
  }
  if (!model.entryModel || String(model.entryModel).trim().length === 0) {
    errors.push("entry_model_missing");
  }

  const forbidden = deepContainsForbiddenToken({
    entryModel: model.entryModel,
    holdProfile: model.holdProfile,
    tpModel: model.tpModel,
    slModel: model.slModel,
    trailingModel: model.trailingModel,
    formulaOverride: model.formulaOverride,
  });
  if (forbidden) {
    errors.push(`invalid_family_token:${forbidden}`);
  }

  const tpModel = asRecord(model.tpModel);
  const buckets = asRecord(tpModel["buckets"]);
  const bucketEntries = Object.entries(buckets);
  if (bucketEntries.length === 0) {
    errors.push("tp_buckets_missing");
  }
  for (const [key, value] of bucketEntries) {
    if (!validateBucketKey(key)) {
      errors.push(`invalid_bucket_key:${key}`);
      continue;
    }
    const bucket = asRecord(value);
    if (readTargetPct(bucket["targetPct"]) == null) {
      errors.push(`bucket_target_missing:${key}`);
    }
  }

  const slModel = asRecord(model.slModel);
  const slRisk = Number(slModel["maxInitialRiskPct"]);
  if (!Number.isFinite(slRisk) || slRisk <= 0) {
    errors.push("sl_policy_missing");
  }

  const trailingModel = asRecord(model.trailingModel);
  const trailingActivation = Number(trailingModel["activationProfitPct"]);
  const trailingDistance = Number(trailingModel["trailingDistancePct"]);
  if (!Number.isFinite(trailingActivation) || trailingActivation <= 0) {
    errors.push("trailing_activation_missing");
  }
  if (!Number.isFinite(trailingDistance) || trailingDistance <= 0) {
    errors.push("trailing_distance_missing");
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidCrash300RuntimeModel(
  model: PromotedSymbolRuntimeModel | null,
): PromotedSymbolRuntimeModel {
  const validation = validateCrash300RuntimeModel(model);
  if (!validation.valid || !model) {
    throw new Error(
      `CRASH300 runtime model missing/invalid. Cannot evaluate symbol service. ${validation.errors.join(",")}`,
    );
  }
  return model;
}

export async function getCrash300RuntimeFeeddown() {
  const [stagedModel, promotedModel] = await Promise.all([
    getStagedSymbolRuntimeModel(SYMBOL),
    getPromotedSymbolRuntimeModel(SYMBOL),
  ]);
  const stagedValidation = validateCrash300RuntimeModel(stagedModel);
  const promotedValidation = validateCrash300RuntimeModel(promotedModel);
  return {
    symbol: SYMBOL,
    stagedModel,
    promotedModel,
    hasPromotedModel: Boolean(promotedModel),
    stagedValidation,
    promotedValidation,
  };
}
