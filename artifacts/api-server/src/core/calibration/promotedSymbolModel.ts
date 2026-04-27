import { db, platformStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { SymbolResearchProfile } from "./symbolResearchProfile.js";
import { getLatestSymbolResearchProfile } from "./symbolResearchProfile.js";

export interface PromotedSymbolRuntimeModel {
  symbol: string;
  source: "promoted_symbol_model";
  sourceRunId: number;
  promotedAt: string;
  suggestedAt: string;
  recommendedScanIntervalSeconds: number;
  recommendedScoreGates: {
    paper: number;
    demo: number;
    real: number;
  };
  expectedTradesPerMonth: number;
  expectedCapitalUtilizationPct: number;
  confidenceMultiplier: number;
  projectedMoveMultiplier: number;
  holdProfile: Record<string, unknown>;
  tpModel: Record<string, unknown>;
  slModel: Record<string, unknown>;
  trailingModel: Record<string, unknown>;
  formulaOverride: Record<string, unknown> | null;
  entryModel: string;
  confirmationWindow: string;
  buildPriority: "high" | "medium" | "low";
  researchStatus: string;
  optimisationRunId?: number | null;
  optimisationCandidateId?: number | null;
  optimisationParams?: Record<string, unknown> | null;
}

type SymbolModelStage = "staged" | "promoted";

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function stageKey(stage: SymbolModelStage, symbol: string): string {
  return `${stage}_symbol_model_${symbol}`;
}

export function compileRuntimeModelFromResearchProfile(
  profile: SymbolResearchProfile,
  stateMap: Record<string, string> = {},
  promotedAt = new Date().toISOString(),
): PromotedSymbolRuntimeModel {
  const gates = profile.recommendedScoreGates ?? {};
  const paperGate = asNumber(gates.paper, 60);
  const demoGate = asNumber(gates.demo, 65);
  const realGate = asNumber(gates.real, 70);

  const confidenceMultiplier = Math.max(0.85, Math.min(1.15, paperGate / 60));
  const projectedMoveMultiplier = Math.max(
    0.9,
    Math.min(1.25, asNumber(profile.estimatedFitAdjustedMonthlyReturnPct, 0) / 12 || 1),
  );

  const profileRaw = asRecord(profile);
  const profileOverride = asRecord(
    profileRaw.recommendedFormulaOverride ?? profileRaw.formulaOverride,
  );
  const stateOverride = parseJsonRecord(
    stateMap[`calibration_formula_override_${profile.symbol}`] ??
      stateMap[`${profile.symbol}_formula_override`],
  );
  const formulaOverride =
    Object.keys(stateOverride).length > 0
      ? stateOverride
      : Object.keys(profileOverride).length > 0
        ? profileOverride
        : null;

  return {
    symbol: profile.symbol,
    source: "promoted_symbol_model",
    sourceRunId: profile.lastRunId,
    promotedAt,
    suggestedAt: profile.generatedAt,
    recommendedScanIntervalSeconds: asNumber(profile.recommendedScanIntervalSeconds, 60),
    recommendedScoreGates: {
      paper: paperGate,
      demo: demoGate,
      real: realGate,
    },
    expectedTradesPerMonth: asNumber(profile.estimatedTradesPerMonth, 0),
    expectedCapitalUtilizationPct: asNumber(profile.estimatedCapitalUtilizationPct, 0),
    confidenceMultiplier,
    projectedMoveMultiplier,
    holdProfile: asRecord(profile.recommendedHoldProfile),
    tpModel: asRecord(profile.recommendedTpModel),
    slModel: asRecord(profile.recommendedSlModel),
    trailingModel: asRecord(profile.recommendedTrailingModel),
    formulaOverride,
    entryModel: String(profile.recommendedEntryModel ?? "all"),
    confirmationWindow: String(profile.recommendedConfirmationWindow ?? "4h"),
    buildPriority: profile.buildPriority,
    researchStatus: profile.researchStatus,
  };
}

async function writeSymbolRuntimeModel(
  stage: SymbolModelStage,
  model: PromotedSymbolRuntimeModel,
): Promise<void> {
  const key = stageKey(stage, model.symbol);
  const value = JSON.stringify(model);
  await db
    .insert(platformStateTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: platformStateTable.key,
      set: { value, updatedAt: new Date() },
    });
}

async function readSymbolRuntimeModel(
  stage: SymbolModelStage,
  symbol: string,
): Promise<PromotedSymbolRuntimeModel | null> {
  const rows = await db
    .select()
    .from(platformStateTable)
    .where(eq(platformStateTable.key, stageKey(stage, symbol)))
    .limit(1);
  const raw = rows[0]?.value;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      symbol: String(record.symbol ?? symbol),
      source: "promoted_symbol_model",
      sourceRunId: asNumber(record.sourceRunId, 0),
      promotedAt: String(record.promotedAt ?? new Date(0).toISOString()),
      suggestedAt: String(record.suggestedAt ?? new Date(0).toISOString()),
      recommendedScanIntervalSeconds: asNumber(record.recommendedScanIntervalSeconds, 60),
      recommendedScoreGates: {
        paper: asNumber(asRecord(record.recommendedScoreGates).paper, 60),
        demo: asNumber(asRecord(record.recommendedScoreGates).demo, 65),
        real: asNumber(asRecord(record.recommendedScoreGates).real, 70),
      },
      expectedTradesPerMonth: asNumber(record.expectedTradesPerMonth, 0),
      expectedCapitalUtilizationPct: asNumber(record.expectedCapitalUtilizationPct, 0),
      confidenceMultiplier: asNumber(record.confidenceMultiplier, 1),
      projectedMoveMultiplier: asNumber(record.projectedMoveMultiplier, 1),
      holdProfile: asRecord(record.holdProfile),
      tpModel: asRecord(record.tpModel),
      slModel: asRecord(record.slModel),
      trailingModel: asRecord(record.trailingModel),
      formulaOverride: (() => {
        const override = asRecord(record.formulaOverride);
        return Object.keys(override).length > 0 ? override : null;
      })(),
      entryModel: String(record.entryModel ?? "all"),
      confirmationWindow: String(record.confirmationWindow ?? "4h"),
      buildPriority: (["high", "medium", "low"].includes(String(record.buildPriority))
        ? record.buildPriority
        : "low") as "high" | "medium" | "low",
      researchStatus: String(record.researchStatus ?? "research_complete"),
      optimisationRunId: record.optimisationRunId == null ? null : asNumber(record.optimisationRunId, 0),
      optimisationCandidateId: record.optimisationCandidateId == null ? null : asNumber(record.optimisationCandidateId, 0),
      optimisationParams: (() => {
        const params = asRecord(record.optimisationParams);
        return Object.keys(params).length > 0 ? params : null;
      })(),
    };
  } catch {
    return null;
  }
}

export async function getPromotedSymbolRuntimeModel(
  symbol: string,
): Promise<PromotedSymbolRuntimeModel | null> {
  return readSymbolRuntimeModel("promoted", symbol);
}

export async function getStagedSymbolRuntimeModel(
  symbol: string,
): Promise<PromotedSymbolRuntimeModel | null> {
  return readSymbolRuntimeModel("staged", symbol);
}

export async function stageLatestSymbolResearchProfile(
  symbol: string,
  stateMap: Record<string, string> = {},
): Promise<PromotedSymbolRuntimeModel | null> {
  const profile = await getLatestSymbolResearchProfile(symbol);
  if (!profile) return null;
  const model = compileRuntimeModelFromResearchProfile(profile, stateMap, new Date().toISOString());
  await writeSymbolRuntimeModel("staged", model);
  return model;
}

export async function stageSymbolRuntimeModel(
  model: PromotedSymbolRuntimeModel,
): Promise<PromotedSymbolRuntimeModel> {
  await writeSymbolRuntimeModel("staged", model);
  return model;
}

export async function promoteLatestSymbolResearchProfile(
  symbol: string,
  stateMap: Record<string, string> = {},
): Promise<PromotedSymbolRuntimeModel | null> {
  const profile = await getLatestSymbolResearchProfile(symbol);
  if (!profile) return null;
  const model = compileRuntimeModelFromResearchProfile(profile, stateMap, new Date().toISOString());
  await writeSymbolRuntimeModel("promoted", model);
  return model;
}

export async function promoteSymbolResearchProfile(
  profile: SymbolResearchProfile,
  stateMap: Record<string, string> = {},
): Promise<PromotedSymbolRuntimeModel> {
  const model = compileRuntimeModelFromResearchProfile(profile, stateMap, new Date().toISOString());
  await writeSymbolRuntimeModel("promoted", model);
  return model;
}
