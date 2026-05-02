export interface ParityMoveVerdict {
  moveId: number | string;
  symbol: string;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
  movePct: number;
  moveFamily: string;
  calibrationMoveFamily?: string;
  runtimeFamily?: string | null;
  selectedRuntimeFamily: string | null;
  selectedBucket: string | null;
  phaseDerivedFamily?: string | null;
  phaseDerivedBucket?: string | null;
  triggerTransition?: string | null;
  triggerDirectionAtEval?: "buy" | "sell" | "none" | null;
  liveEligibleTrigger?: boolean;
  parityFamilyCompatible?: boolean;
  bucketCompatible?: boolean;
  candidateProduced: boolean;
  expectedTradeDirection?: "buy" | "sell" | null;
  actualCandidateDirection?: "buy" | "sell" | null;
  candidateDirection: "buy" | "sell" | null;
  familyCompatible?: boolean;
  directionCompatible?: boolean;
  confidence: number;
  setupMatch: number;
  matchReason?: string | null;
  mismatchReason?: string | null;
  firstFailureReason: string | null;
  allFailureReasons: string[];
  parityDistanceScore: number | null;
}

export interface ParityAggregateReport {
  symbol: string;
  totalMoves: number;
  matchedMoves: number;
  noCandidate: number;
  familyMismatch: number;
  directionMismatch: number;
  bucketMismatch: number;
  setupEvidenceFailed: number;
  runtimeModelMissing: number;
  invalidRuntimeModel: number;
}
