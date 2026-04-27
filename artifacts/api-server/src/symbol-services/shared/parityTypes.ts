export interface ParityMoveVerdict {
  moveId: number | string;
  symbol: string;
  startTs: number;
  endTs: number;
  direction: "up" | "down" | "unknown";
  movePct: number;
  moveFamily: string;
  selectedRuntimeFamily: string | null;
  selectedBucket: string | null;
  candidateProduced: boolean;
  candidateDirection: "buy" | "sell" | null;
  confidence: number;
  setupMatch: number;
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