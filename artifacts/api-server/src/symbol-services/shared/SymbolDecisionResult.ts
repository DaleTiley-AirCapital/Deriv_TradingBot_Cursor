import type { TradeDirection, RuntimeQualityTier } from "./TradeCandidate.js";

export interface SymbolDecisionResult {
  symbol: string;
  serviceName: string;
  valid: boolean;
  direction: TradeDirection | null;
  confidence: number;
  qualityTier: RuntimeQualityTier;
  setupFamily: string;
  moveBucket: string;
  setupMatch: number;
  evidence: Record<string, unknown>;
  featureSnapshot: Record<string, unknown>;
  failReasons: string[];
}