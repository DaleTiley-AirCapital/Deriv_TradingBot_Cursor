# Integrated Elite Synthesis

## Purpose

Integrated Elite Synthesis is the normal async research search engine for a symbol service.

It is not a one-pass report and it is not a manual tier sweep replacement with a prettier name. It builds a unified service dataset, evaluates complete runtime-policy candidates, iterates through multiple passes, and returns a candidate runtime-policy artifact for operator review.

It must not:

- call AI
- reuse the old optimiser as the primary search engine
- auto-promote a runtime policy
- change live runtime behavior directly
- leak oracle labels or post-entry data into final live rules

## Normal Workflow Role

The normal service workflow is:

1. Full Calibration
2. Generate or Stage Research Model
3. Run Integrated Elite Synthesis
4. Review Candidate Runtime Policy
5. Promote Candidate Runtime
6. Validate Current Runtime Backtest
7. Paper validation

Manual tier testing, admission-policy toggles, and parity debugging remain advanced diagnostics only.

## Async Job Contract

Dedicated job table:

- `elite_synthesis_jobs`

Core fields:

- `id`
- `service_id`
- `symbol`
- `status`
- `stage`
- `params`
- `progress_pct`
- `current_pass`
- `max_passes`
- `message`
- `heartbeat_at`
- `started_at`
- `completed_at`
- `error_summary`
- `best_summary`
- `result_summary`
- `result_artifact`
- `created_at`

Statuses:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

Stages:

- `loading_data`
- `building_dataset`
- `evaluating_current_pool`
- `rebuilding_trigger_candidates`
- `feature_elimination`
- `generating_policies`
- `evaluating_policies`
- `optimising_entry_timing`
- `optimising_exits`
- `refining_candidates`
- `selecting_best`
- `writing_result`
- `completed`
- `failed`

## Endpoint Contract

- `POST /api/research/:serviceId/elite-synthesis/jobs`
- `GET /api/research/:serviceId/elite-synthesis/jobs/:id`
- `POST /api/research/:serviceId/elite-synthesis/jobs/:id/cancel`
- `GET /api/research/:serviceId/elite-synthesis/jobs/:id/result`
- `GET /api/research/:serviceId/elite-synthesis/jobs/:id/export/full`
- `GET /api/research/:serviceId/elite-synthesis/dataset-summary`
- `GET /api/research/elite-synthesis/schema-status`

Status endpoints must stay compact. Full pass logs, policy tables, and export-heavy artifacts must only be returned from the full export path.

## Reusable Adapter Interface

Every synthesis-capable service should implement an adapter with at least:

- `serviceId`
- `symbol`
- `displayName`
- `loadCalibrationRuns()`
- `loadCalibratedMoves()`
- `loadRuntimeModel()`
- `loadBacktestRuns()`
- `loadBacktestTrades()`
- `loadPhaseSnapshots()`
- `loadCalibrationReconciliation()`
- `buildLiveSafeFeatureVector()`
- `deriveMoveSizeBucket()`
- `deriveRuntimeArchetype()`
- `generateTriggerCandidatesFromMoveOffsets()`
- `evaluatePolicyOnHistoricalData()`
- `deriveExitPolicyFromSubset()`
- `validateNoFutureLeakage()`

## Unified Dataset Requirements

The synthesis dataset should combine:

- calibrated moves
- runtime trades and candidates
- non-move controls

The final candidate policy may use only live-safe features available at the entry candle. Oracle labels may be used during evaluation and scoring inside synthesis, but never as final live runtime rules.

## Non-Stop Search Rule

Integrated synthesis must not stop early just because the current runtime candidate pool is weak.

Required behavior:

1. Evaluate current runtime candidate pool.
2. If the current pool is insufficient, enter `rebuilding_trigger_candidates`.
3. Generate trigger candidates from calibrated move offsets.
4. Continue the search with rebuilt candidates.
5. Only return `targetAchieved: false` after the configured search space is exhausted or a real error occurs.

## Candidate Policy Requirements

Every policy candidate must be complete:

- selected move-size buckets
- selected runtime archetypes or families
- selected buckets
- selected trigger transitions
- allowed regimes
- selected live-safe core features
- entry thresholds
- entry timing rules
- no-trade rules
- daily trade limit
- cascade rules
- TP rules
- SL rules
- trailing rules
- min-hold rules
- live-safe elite-score formula

Isolated filters do not count as a policy result.

## Leakage Audit Rules

Final live rules must not use:

- future pnl
- future mfe or mae
- actual exit reason
- realised win or loss
- strict oracle relationship label
- calibrated move outcome label
- post-entry candle data
- legacy diagnostic score

The result artifact must include a leakage audit that confirms those checks explicitly.

## Result Contract

Compact result:

- job id
- service id
- status
- target achieved
- best policy summary
- top policy summaries
- bottleneck summary
- leakage audit summary
- window summary
- source run ids

Full export:

- best policy artifact
- top 20 policies
- pass log
- feature separability tables
- exit optimisation tables
- trigger rebuild summary
- leakage audit
- bottleneck or exhaustion analysis
- future implementation recommendation

## Runtime Safety

Integrated synthesis runs async, persists progress, and must keep Railway responsive by:

- chunking work by stage and pass
- persisting heartbeat and progress regularly
- keeping status payloads compact
- deferring heavy artifacts to export endpoints
- supporting cancellation between chunks or passes
