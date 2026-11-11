export type ServiceId = "CRASH300" | "R_75" | "BOOM300" | "R_100";

export type Direction = "buy" | "sell";

export type Candle = {
  openTs: number;
  closeTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
  isInterpolated: boolean;
};

export type DetectedMove = {
  id: number;
  symbol: string;
  direction: "up" | "down";
  moveType: string;
  strategyFamilyCandidate: string;
  startTs: number;
  endTs: number;
  startPrice: number;
  endPrice: number;
  movePct: number;
  holdingMinutes: number;
  qualityScore: number;
  qualityTier: string;
};

export type LabRequest = {
  serviceId?: ServiceId;
  family?: string;
  direction?: string;
  targetPct?: number;
  fromTs?: number;
  toTs?: number;
  maxCandles?: number;
};

export type FeatureVector = Record<string, number>;

export type Fingerprint = {
  moveId: number;
  serviceId: string;
  family: string;
  direction: "up" | "down";
  moveStart: number;
  moveEnd: number;
  movePct: number;
  holdingMinutes: number;
  features: FeatureVector;
};

export type ControlFingerprint = {
  candleTs: number;
  serviceId: string;
  features: FeatureVector;
};

export type FeatureSeparation = {
  feature: string;
  target: DistributionSummary;
  control: DistributionSummary;
  separationScore: number;
  targetPresenceRate: number;
  controlPresenceRate: number;
};

export type DistributionSummary = {
  count: number;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
};

export type CandidateRule = {
  ruleId: string;
  serviceId: ServiceId;
  family: string;
  direction: Direction;
  targetPct: number;
  stopLossPct: number;
  maxHoldBars: number;
  entryConditions: RuleCondition[];
};

export type RuleCondition = {
  feature: string;
  min?: number;
  max?: number;
};

export type WalkForwardTrade = {
  entryTs: number;
  exitTs: number;
  direction: Direction;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  exitReason: "tp_hit" | "sl_hit" | "maturity_exit";
  maxFavorablePct: number;
  maxAdversePct: number;
  matchedMoveId: number | null;
};

export type WalkForwardSummary = {
  ruleId: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfitPct: number;
  grossLossPct: number;
  profitFactor: number | null;
  averagePnlPct: number;
  medianPnlPct: number;
  maxDrawdownPct: number;
  matchedMoveTrades: number;
  falsePositiveTrades: number;
};

export type LabRun = {
  id: string;
  kind: string;
  createdAt: string;
  request: Required<Pick<LabRequest, "serviceId" | "family" | "direction" | "targetPct">> & LabRequest;
  status: "completed" | "failed";
  result: unknown;
  error?: string;
};
