type AdmissionCandidateLike = {
  setupFamily?: string | null;
  moveBucket?: string | null;
};

export type Crash300AdmissionPolicyMode = "off" | "preview" | "enforce";

export type Crash300AdmissionPolicyConfig = {
  enabled: boolean;
  mode: Crash300AdmissionPolicyMode;
  blockWrongDirectionWithTrigger: boolean;
  blockPostCrashRecoveryUp: boolean;
  blockUpRecovery10PlusPct: boolean;
  blockRecoveryUpOnDownMove: boolean;
  blockCrashDownOnUpMove: boolean;
};

export type Crash300AdmissionPolicyDiagnostics = {
  tradeDirection: "buy" | "sell";
  triggerDirection: "buy" | "sell" | "none" | "unknown";
  runtimeFamily: string | null;
  selectedBucket: string | null;
  matchedMoveDirection?: "up" | "down" | "unknown" | null;
  triggerFresh?: boolean | null;
  familyDirection?: "buy" | "sell" | "unknown";
  bucketDirection?: "buy" | "sell" | "unknown";
  semanticFlags?: string[];
  evaluationMode?: "runtime" | "backtest" | "diagnostic";
};

export type Crash300AdmissionPolicyResult = {
  allowed: boolean;
  blockedReasons: string[];
  policyName: string;
  policyMode: Crash300AdmissionPolicyMode;
  wouldHaveBlocked: boolean;
};

export const DEFAULT_CRASH300_ADMISSION_POLICY: Crash300AdmissionPolicyConfig = {
  enabled: false,
  mode: "preview",
  blockWrongDirectionWithTrigger: false,
  blockPostCrashRecoveryUp: false,
  blockUpRecovery10PlusPct: false,
  blockRecoveryUpOnDownMove: false,
  blockCrashDownOnUpMove: false,
};

function normalizeTradeDirection(direction: "up" | "down" | "unknown" | null | undefined): "buy" | "sell" | "unknown" {
  if (direction === "up") return "buy";
  if (direction === "down") return "sell";
  return "unknown";
}

export function normalizeCrash300AdmissionPolicyConfig(
  value: unknown,
): Crash300AdmissionPolicyConfig {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const modeRaw = String(record.mode ?? DEFAULT_CRASH300_ADMISSION_POLICY.mode).toLowerCase();
  const mode: Crash300AdmissionPolicyMode =
    modeRaw === "off" || modeRaw === "enforce" || modeRaw === "preview"
      ? modeRaw
      : DEFAULT_CRASH300_ADMISSION_POLICY.mode;
  const bool = (key: Exclude<keyof Crash300AdmissionPolicyConfig, "mode" | "enabled">): boolean =>
    typeof record[key] === "boolean" ? Boolean(record[key]) : DEFAULT_CRASH300_ADMISSION_POLICY[key];
  return {
    enabled: typeof record.enabled === "boolean" ? Boolean(record.enabled) : DEFAULT_CRASH300_ADMISSION_POLICY.enabled,
    mode,
    blockWrongDirectionWithTrigger: bool("blockWrongDirectionWithTrigger"),
    blockPostCrashRecoveryUp: bool("blockPostCrashRecoveryUp"),
    blockUpRecovery10PlusPct: bool("blockUpRecovery10PlusPct"),
    blockRecoveryUpOnDownMove: bool("blockRecoveryUpOnDownMove"),
    blockCrashDownOnUpMove: bool("blockCrashDownOnUpMove"),
  };
}

export function evaluateCrash300AdmissionPolicy(
  candidate: AdmissionCandidateLike,
  _context: Record<string, unknown> | null,
  _trigger: Record<string, unknown> | null,
  diagnostics: Crash300AdmissionPolicyDiagnostics,
  policyConfig: Crash300AdmissionPolicyConfig,
): Crash300AdmissionPolicyResult {
  const blockedReasons: string[] = [];
  const semanticFlags = new Set(diagnostics.semanticFlags ?? []);
  const runtimeFamily = candidate.setupFamily ?? diagnostics.runtimeFamily ?? null;
  const selectedBucket = candidate.moveBucket ?? diagnostics.selectedBucket ?? null;
  const matchedMoveTradeDirection = normalizeTradeDirection(diagnostics.matchedMoveDirection ?? null);

  if (policyConfig.enabled && policyConfig.blockPostCrashRecoveryUp && runtimeFamily === "post_crash_recovery_up") {
    blockedReasons.push("policy_block_post_crash_recovery_up");
  }
  if (policyConfig.enabled && policyConfig.blockUpRecovery10PlusPct && selectedBucket === "up|recovery|10_plus_pct") {
    blockedReasons.push("policy_block_up_recovery_10_plus_pct");
  }
  if (
    policyConfig.enabled &&
    policyConfig.blockRecoveryUpOnDownMove &&
    (
      semanticFlags.has("recovery_up_family_on_down_move") ||
      (runtimeFamily === "post_crash_recovery_up" && matchedMoveTradeDirection === "sell")
    )
  ) {
    blockedReasons.push("policy_block_recovery_up_on_down_move");
  }
  if (
    policyConfig.enabled &&
    policyConfig.blockCrashDownOnUpMove &&
    (
      semanticFlags.has("crash_down_family_on_up_move") ||
      (runtimeFamily === "crash_event_down" && matchedMoveTradeDirection === "buy")
    )
  ) {
    blockedReasons.push("policy_block_crash_down_on_up_move");
  }
  if (policyConfig.enabled && policyConfig.blockWrongDirectionWithTrigger) {
    const triggerMismatch = diagnostics.triggerDirection !== "unknown"
      && diagnostics.triggerDirection !== "none"
      && diagnostics.triggerDirection !== diagnostics.tradeDirection;
    const familyBucketMismatch = diagnostics.familyDirection !== "unknown"
      && diagnostics.bucketDirection !== "unknown"
      && diagnostics.familyDirection !== diagnostics.bucketDirection;
    const tradeVsMoveMismatch = diagnostics.evaluationMode !== "runtime"
      && matchedMoveTradeDirection !== "unknown"
      && matchedMoveTradeDirection !== diagnostics.tradeDirection;
    if (
      triggerMismatch ||
      familyBucketMismatch ||
      tradeVsMoveMismatch ||
      semanticFlags.has("trigger_trade_direction_mismatch") ||
      semanticFlags.has("family_bucket_direction_mismatch") ||
      semanticFlags.has("recovery_up_family_on_down_move") ||
      semanticFlags.has("crash_down_family_on_up_move")
    ) {
      blockedReasons.push("policy_block_wrong_direction_with_trigger");
    }
  }

  const wouldHaveBlocked = blockedReasons.length > 0;
  const allowed = !policyConfig.enabled || policyConfig.mode !== "enforce" || !wouldHaveBlocked;
  return {
    allowed,
    blockedReasons,
    policyName: "crash300_admission_policy",
    policyMode: policyConfig.enabled ? policyConfig.mode : "off",
    wouldHaveBlocked,
  };
}
