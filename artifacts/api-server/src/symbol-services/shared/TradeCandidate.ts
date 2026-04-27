export type TradeDirection = "buy" | "sell";
export type RuntimeQualityTier = "A" | "B" | "C" | "D" | "unknown";

export interface PolicyEnvelope {
  type: string;
  params: Record<string, unknown>;
}

export interface CapitalRequest {
  requestedPct: number;
  requestedUsd?: number;
  maxRiskPct?: number;
  notes?: string;
}

export interface TradeCandidate {
  candidateId: string;
  symbol: string;
  direction: TradeDirection;
  serviceName: string;
  modelRunId: number | null;
  calibrationRunId: number | null;
  runtimeModelId?: string | null;
  promotedModelRunId?: number | null;
  setupFamily: string;
  moveBucket: string;
  qualityTier: RuntimeQualityTier;
  confidence: number;
  setupMatch: number;
  entryPrice: number;
  entryReason: string;
  expectedMovePct: number;
  expectedHoldBars?: number;
  expectedHoldWindow?: string;
  tpPolicy: PolicyEnvelope;
  slPolicy: PolicyEnvelope;
  trailingPolicy: PolicyEnvelope;
  invalidationPolicy: PolicyEnvelope;
  evidence: Record<string, unknown>;
  featureSnapshot: Record<string, unknown>;
  matchedCalibrationBucket?: string | null;
  matchedHistoricalExamples?: Array<Record<string, unknown>>;
  parityEvidence?: Record<string, unknown>;
  capitalRequest: CapitalRequest;
  createdAt: string;
  expiresAt: string;
  failReasons?: string[];
}