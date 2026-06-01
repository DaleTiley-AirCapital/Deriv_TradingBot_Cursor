# V3.2 System Handoff For External AI Review

Generated: 2026-05-26

Repository: `Deriv_TradingBot_Cursor`

Current local branch at time of writing: `main`

Latest pushed commit at time of writing: `93f06be4 Enforce promoted runtime parity for live candidates`

Application version in code: `3.2.0`

## 1. Purpose Of This Document

This document describes the current Deriv Trading V3.2 system state, what has been built, how the research/runtime/live pipeline is supposed to work, what was recently changed, and which parts still deserve independent review.

It is written for another AI model or engineer to inspect the system without relying on prior chat context.

The user objective is not generic signal generation. The objective is capital extraction:

- Build a runtime per symbol from detected historical moves.
- Convert the runtime into deterministic live-safe rules.
- Promote only validated service runtimes.
- Let promoted services emit only true runtime-matching candidates.
- Let the allocator allocate capital to valid service candidates.
- Let the Trade Lifecycle Manager manage exits so larger moves can run.

The user does not want:

- Legacy composite-score logic deciding trades after a runtime is promoted.
- Extra visible Research tasks.
- Allocator re-scoring service candidates.
- Live/paper behavior diverging from Build Runtime Model behavior.
- Hidden fallback logic preserving stale behavior.

## 2. Current Product Model

The app is a Deriv synthetic-index trading system with four registered services:

- `CRASH300`
- `BOOM300`
- `R_75`
- `R_100`

Current active/promoted services are intended to be:

- `CRASH300`
- `R_75`

`BOOM300` and `R_100` are registered roadmap services and should not emit live candidates until they have their own Build Runtime Model, Validate Runtime, and Promote Runtime passes.

The current visible workflow is:

1. Data Coverage
2. Full Calibration
3. Build Runtime Model
4. Validate Runtime
5. Promote Runtime
6. Stream / Monitor

Reports should be read-only evidence. Diagnostics should not become new top-level tasks.

## 3. Current Source-Of-Truth Files

Important backend files:

- `artifacts/api-server/src/core/synthesis/engine.ts`
  - Builds runtime model artifacts.
  - Emits runtime build outputs.
  - Now exports selected R_75 runtime trades and runtime contracts.

- `artifacts/api-server/src/core/serviceRuntimeLifecycle.ts`
  - Converts review/runtime build artifacts into staged or promoted service runtime artifacts.
  - Builds CRASH300 and R_75 promoted runtime adapters.
  - Serializes R_75 selected runtime contracts, allowed engine-direction pairs, component thresholds, feature bands, and runtime evidence thresholds.

- `artifacts/api-server/src/core/calibration/runtimeProfileUtils.ts`
  - Main runtime evidence admission helper for live/backtest parity.
  - `evaluateRuntimeEntryEvidence(...)` validates whether a live engine/coordinator output matches the promoted runtime contract.
  - Contains CRASH300 calibrated setup checks.
  - Contains R_75 exact engine+direction and component-threshold checks.

- `artifacts/api-server/src/core/symbolModels/candidateBuilder.ts`
  - Builds service trade candidates from symbol engine/coordinator output.
  - CRASH300 now calls `evaluateRuntimeEntryEvidence(...)` before a candidate is accepted as matching a promoted runtime.

- `artifacts/api-server/src/infrastructure/scheduler.ts`
  - Live scanner orchestration.
  - Flow: stream/candle state -> `scanSymbolV3` -> build service candidate -> allocator -> open trade.
  - Creates service candidate records, allocator decision records, and opens paper/demo/real trades.

- `artifacts/api-server/src/core/portfolioAllocatorV3.ts`
  - Allocator for V3/service-runtime candidates.
  - It should own capital, exposure, drawdown gates, cascade timing, mode permission, and portfolio safety.
  - It should not independently decide whether the service candidate is strategically valid once the promoted service runtime admitted it.

- `artifacts/api-server/src/core/allocatorCore.ts`
  - Shared admission gate evaluator.
  - Still contains a native/composite score gate for non-service-runtime paths.
  - Service-runtime candidates call this with `skipScoreGate: true`, so promoted runtime candidates should bypass legacy score/confidence gate 4.

- `artifacts/api-server/src/core/tradeEngine.ts`
  - Opens and manages positions.
  - Applies runtime calibration exit model.
  - Still contains internal fields and implementation language around trailing stops.
  - Current runtime language should be Trade Lifecycle Manager/protection, but the code still contains historical trailing field names for execution compatibility.

- `artifacts/api-server/src/infrastructure/deriv.ts`
  - Deriv broker/data adapter.
  - Recently fixed CRASH300 API-symbol revalidation so `CRASH300` maps to broker symbol `CRASH300N` after restart/reconnect.

Important frontend files:

- `artifacts/deriv-quant/src/pages/research.tsx`
  - Research workflow UI.
  - Shows Data Coverage, Calibration, Build Runtime Model, Runtime Model, Reports.

- `artifacts/deriv-quant/src/pages/overview.tsx`
  - Operations overview and service runtime status.

- `artifacts/deriv-quant/src/pages/decisions.tsx`
  - Allocator decisions page.
  - Displays service candidates, runtime evidence, allocator decision, and execution result.

- `artifacts/deriv-quant/src/pages/trades.tsx`
  - Trade lifecycle page.

- `artifacts/deriv-quant/src/pages/help.tsx`
  - Help/documentation UI.

Important docs:

- `docs/current-operating-policy.md`
- `docs/RESEARCH_TO_RUNTIME_WORKFLOW.md`
- `docs/runtime-feeddown-contract.md`
- `docs/operator-runbook.md`
- `docs/symbol-service-architecture.md`

## 4. High-Level Runtime Flow

The intended current flow is:

```text
historical candles/ticks
  -> Full Calibration
  -> detected moves and deterministic source data
  -> Build Runtime Model
  -> review runtime candidate artifact
  -> Validate Runtime
  -> validation result
  -> Promote Runtime
  -> promoted service runtime artifact
  -> live scanner reads promoted runtime
  -> service emits candidate only if runtime contract matches
  -> allocator allocates capital if portfolio gates allow
  -> trade opens
  -> Trade Lifecycle Manager manages protection/exhaustion/exit
```

Build Runtime Model must not promote or trade.

Validate Runtime must not promote or trade.

Promote Runtime is manual and service-level.

Allocator should not re-score or invalidate the strategy after a service runtime emitted a valid candidate.

## 5. Build Runtime Model

Build Runtime Model replaced fragmented tasks such as old Integrated Elite Synthesis, parity, optimizer, runtime trigger validation, and visible backtest buttons.

The Build Runtime Model visible task should internally:

- Load latest calibration source data.
- Build or reuse move universe.
- Build or reuse candidate entry matrix.
- Build or reuse controls.
- Run deterministic candidate search.
- Run lifecycle simulation.
- Rank by capital extraction.
- Analyze missed moves.
- Optionally run offline AI strategy review.
- Convert winning strategy into deterministic runtime rules.
- Generate a review candidate runtime artifact.
- Generate read-only reports.

The output contract is intended to be:

```text
runtime_build_result_<SERVICE>_<RUN>.json
```

Key fields expected:

- `targetMoveUniverse`
- `largeMoveCoverage`
- `candidateFamilyComparison`
- `bestCapitalExtractionCandidate`
- `missedTargetMoveAnalysis`
- `lifecycleHoldAndExhaustionAnalysis`
- `dynamicTpProtectionSummary`
- `runtimeRuleDraft`
- `runtimeArtifactEligibility`
- `blockers`
- `warnings`

## 6. CRASH300 Runtime Intent

The CRASH300 objective was changed several times during the work.

Earlier, the system focused on:

- `failed_recovery_short`
- small clean subsets
- `>=9%` crash expansion moves

The current stated operating intent is broader:

- Trade CRASH300 candidates with potential to exceed 5%.
- Capture both 5-9% and 9%+ opportunities.
- Let large moves run with correct protection and exhaustion handling.

Known runtime result examples mentioned in the UI/chats:

- Older run `#44`:
  - Target universe: `56 crash_expansion >= 9%`
  - Best candidate: `lifecycle_capture_gte_5`
  - Trades/wins/losses: `66 / 66 / 0`
  - Win/SL: `100.00% / 0.00%`
  - Lifecycle PnL: about `9.37% median / 9.13% avg`

- Later run `#64`:
  - Target universe: `62 crash_expansion >= 9%`
  - Best candidate: `capital_extraction_gte_9_down`
  - Trades/wins/losses: `20 / 14 / 6`
  - Win/SL: `70.00% / 30.00%`
  - Marked blocked.

- Later run `#68` was validated/promoted by the user.
  - It appeared to show more CRASH300 potential than earlier runs.
  - Exact artifact should be inspected in DB/artifact store by future reviewers.

Important unresolved question:

Why did `#44`, `#64`, `#68`, and later runs differ so much? Possibilities include:

- Different target objective.
- Different target universe after recalibration.
- Different artifact adapter behavior.
- Different daily limit/candidate pruning.
- Different runtime build code at each time.
- Historical artifacts being interpreted through newer UI/reporting code.

This needs artifact-level comparison, not UI-only comparison.

## 7. R_75 Runtime Intent

R_75 is a volatility symbol and must not be treated like CRASH/BOOM one-direction spike logic.

The intended R_75 runtime must evaluate/capture:

- breakout
- reversal
- continuation
- buy and sell where the data supports them

The move universe should be `>=5%`, not `>=9%`, because `>=9%` is too sparse for R_75.

Known R_75 calibration/build facts from prior runs:

- Detected target moves: `211`
- Direction distribution previously observed around `110 up / 101 down`
- User highlighted bucket counts:
  - breakout `5-6`: `39`
  - breakout `6-7`: `28`
  - breakout `7-8`: `16`
  - reversal `5-6`: `23`
  - continuation `6-7`: `6`
  - plus higher buckets with lower counts.

Known runtime result examples:

- Run `#69`:
  - Target universe: `211 all_r75_calibrated_families >= 5%`
  - Large move coverage: `105 / 211 (49.76%)`
  - Best candidate: `r75_breakout_all_capital_extraction`
  - Trades/wins/losses: `105 / 105 / 0`
  - Win/SL: `100.00% / 0.00%`
  - Lifecycle PnL: `5.47% median / 5.77% avg`
  - Exit timing: `early 19 / correct 86 / late 0`
  - TP2/runner: `6.58% / 8.03%`
  - Protection: `2.63% activation / 2.00% room`
  - Eligibility: `runtime_artifact_eligible`

- Later run `#70` was validated/promoted by the user.

Important unresolved issue:

The UI still presented the selected candidate as if one best family dominated, even though R_75 is intended to carry validated multi-family contracts forward. The latest code attempts to preserve multi-family runtime contracts in the promoted artifact, but the UI and artifact should be independently checked to confirm all selected contracts are present and enforced.

## 8. Latest Fixes Already Built And Pushed

Latest pushed commit:

```text
93f06be4 Enforce promoted runtime parity for live candidates
```

Files changed in that commit:

- `artifacts/api-server/src/core/calibration/runtimeProfileUtils.ts`
- `artifacts/api-server/src/core/portfolioAllocatorV3.ts`
- `artifacts/api-server/src/core/serviceRuntimeLifecycle.ts`
- `artifacts/api-server/src/core/symbolModels/candidateBuilder.ts`
- `artifacts/api-server/src/core/synthesis/engine.ts`
- `artifacts/api-server/src/infrastructure/deriv.ts`

Main changes:

1. CRASH300 live candidate emission now requires promoted calibrated runtime evidence.

   `evaluateRuntimeEntryEvidence(...)` rejects CRASH300 candidates unless:

   - metadata says `crash300ScoringSource === "promoted_calibrated_runtime_model"`
   - calibrated setup components pass thresholds:
     - `spikePhaseFit >= 58`
     - `developmentWindowFit >= 60`
     - `triggerWindowFit >= 60`
     - `runwayFit >= 58`

2. R_75 runtime contracts now carry more build-derived information.

   The promoted R_75 adapter now serializes:

   - `selectedRuntimeContracts`
   - `allowedEngineDirections`
   - `componentThresholdsByEngineDirection`
   - `runtimeEvidenceThresholdsByEngineDirection`
   - `featureBandsByEngineDirection`
   - `candidateEmissionCooldownMinutes`

3. R_75 live candidate admission now enforces exact engine+direction runtime contracts.

   The live candidate must match a promoted runtime contract such as:

   ```text
   r75_breakout_engine:buy
   r75_reversal_engine:sell
   r75_continuation_engine:buy
   ```

   It must not be admitted simply because the engine name and direction are each broadly present somewhere.

4. R_75 live evidence now enforces component thresholds.

   Default fallback thresholds are `55` for relevant component scores when selected-trade-derived thresholds are unavailable.

5. R_75 selected Build Runtime Model trades are now exported.

   `engine.ts` adds selected trade snapshots so the runtime adapter can infer thresholds from the exact accepted build trades.

6. Allocator drawdown behavior was changed.

   Drawdown remains a hard safety/admission gate, but it should not reduce capital allocation size once the portfolio is within allowed drawdown.

7. Deriv API symbol revalidation was repaired.

   The broker/data adapter now revalidates configured symbols when cache mapping is absent/stale, so `CRASH300` should correctly map to broker symbol `CRASH300N` after restart.

## 9. Current Candidate Admission Logic

Current scanner path:

```text
scheduler.scanSingleSymbolV3
  -> scanSymbolV3
  -> coordinator output
  -> buildSymbolTradeCandidate
  -> evaluateRuntimeEntryEvidence
  -> reserveServiceCandidateEmission
  -> createServiceCandidateRecord
  -> allocateV3Signal
  -> openPositionV3
```

For promoted service runtimes:

- Runtime evidence should be checked before the allocator.
- The allocator receives `runtimeArtifact`.
- `allocateV3Signal(...)` calls `evaluateSignalAdmission(...)` with `skipScoreGate: true` when `runtimeArtifact != null`.
- Therefore legacy score/confidence gate 4 should be bypassed for promoted service-runtime candidates.

Important subtlety:

`portfolioAllocatorV3.ts` still contains code that can produce `confidence_below_threshold` and engine-specific score-rejection text. This should only apply when `evaluateSignalAdmission(...)` rejects at stage 4. For promoted service runtimes, `skipScoreGate: true` should prevent stage 4 rejection.

If the UI still shows allocator rejection based on confidence after this commit is deployed, likely causes are:

- The deployment is not running commit `93f06be4`.
- The candidate was emitted without a `runtimeArtifact`.
- The code path is not the service-runtime path.
- A historical allocator row is being viewed.
- The worker/API deployment did not restart cleanly.

## 10. Current Allocator Model

The allocator is intended to be capital allocation only after service validation.

Current responsibilities:

- Check active mode.
- Check enabled symbol.
- Check kill switch.
- Check open trade/cascade timing.
- Check max open trades.
- Check daily/weekly/max drawdown gates.
- Check available target utilization capacity.
- Allocate first slice, second cascade slice, or remaining capacity.
- Approve leverage according to runtime/candidate quality.

Current sizing behavior:

- Default target utilization:
  - paper: `95%`
  - demo: `90%`
  - real: `80%`
- Default first slice:
  - paper: `30%`
  - demo: `20%`
  - real: `15%`
- Default second cascade:
  - paper: `40%`
  - demo: `30%`
  - real: `20%`
- Default cascade interval: `1 hour`

The allocator currently still computes `qualityLeverage(...)` from native score, confidence, and projected move. The user has questioned whether this should exist if the service runtime already validated the opportunity.

## 11. Current Trade Lifecycle / Exit Model

Intended user-facing model:

- Trade Lifecycle Manager
- protection activation
- protected floor
- TP1
- TP2/runner target
- lifecycle state
- continuation score
- reversal pressure
- momentum failure exit
- time/progress failure exit
- protected exit

Current implementation still includes internal legacy trailing terms:

- `trailingModel`
- `trailingStopPct`
- `trailingDistancePct`
- `trailingActivationThresholdPct`
- exit reason `trailing_stop`

`tradeEngine.ts` currently manages open positions and applies runtime calibration exit settings. `scheduler.ts` comments say `manageOpenPositions()` is now the unified lifecycle state machine.

Independent reviewers should check whether the current `tradeEngine.ts` lifecycle logic truly implements the Build Runtime Model lifecycle result, or whether it is still a trailing-stop execution model with renamed UI.

This is probably the most important open technical risk after candidate admission.

## 12. Current UI State

Recent UI corrections made before this document:

- Help and docs updated to V3.2 language.
- Allocator nav shortened from "Allocator Decisions" to "Allocator".
- Mobile overflow/pan issues were addressed for overview/research/trades.
- Header balance label fixed so demo balance is not shown as real balance.
- Data freshness warning was intended to use live tick freshness rather than historical candle freshness.
- Decisions page relabeled confidence as runtime evidence.

Remaining UI concerns to verify:

- The Decisions page may still display historical rows with old rejection reasons.
- Runtime Model page may show "Runtime TP bucket model unavailable" if promoted artifact lacks expected bucket fields or UI does not understand the artifact shape.
- R_75 expected metrics may show `not estimated` even when build artifact had 105/105.
- Research history may display historical artifacts through current renderer, which can make old runs appear inconsistent.

## 13. Known Symptoms And Concerns

These are the main unresolved concerns that triggered this handoff.

### 13.1 Backtest/Build 100% Win Rate But Live Trades Lose

The user observed promoted runtimes with 100% Build Runtime Model win rate, then live/paper trades that lost.

Possible explanations:

- Build Runtime Model tested a simplified candidate family, not the exact live scanner state.
- Live candidate admission still accepted weak non-matching setup states.
- Live exit management differs from lifecycle replay.
- Broker/live candle timing and detected move alignment differ from historical replay.
- Runtime artifacts lack enough serialized thresholds to reproduce the exact accepted build trades.
- Old/historical rows caused confusion.
- The deployment was not running the latest code at the time of the trades.

Latest commit tries to address candidate admission parity, not exit parity.

### 13.2 R_75 105/105 May Be Too Optimistic

The user is concerned that R_75 detected 211 moves and matches 105 at 100% win rate.

That could be valid if the runtime is extremely selective, but it is suspicious enough that another model should inspect:

- How winners/losses are defined in Build Runtime Model.
- Whether losers are excluded before win-rate calculation.
- Whether selected trades use future data.
- Whether the lifecycle replay exits are realistic.
- Whether the runtime serialized to live includes every filter used in the build.

### 13.3 CRASH300 Build Results Differ Across Runs

The user observed CRASH300 run `#44` much better than run `#64`/`#66`.

The system should compare artifacts field by field:

- target universe count
- objective
- calibration run id
- source data window
- selected policy
- candidate filters
- lifecycle settings
- daily limit
- controls/phantom results
- runtime artifact eligibility

### 13.4 Recent Replay Candidate Counts Looked Too High

A prior replay emitted:

- CRASH300: `42 / 5000`
- R_75: `4202 / 5000`, later reduced but still suspected high.

The user's expectation from historical trade frequency:

- CRASH300 66 trades over about 6 months implies roughly one trade every few days.
- R_75 105 trades over about 6 months implies roughly one trade every second day.

Therefore a recent 5000-candle replay should not emit large percentages of candles as candidates.

Latest commit attempts to fix this by enforcing runtime contract thresholds in live candidate admission, but the replay should be rerun after deploy and compared to expected historical frequency.

### 13.5 Allocator Rejection Based On Confidence Should Not Happen For Promoted Service Candidates

The user explicitly does not want allocator rejection based on generic confidence after a service runtime emits a valid candidate.

Current code should skip that gate for service-runtime candidates, but reviewers should verify with a fresh deployed candidate.

### 13.6 Trade Lifecycle Manager May Still Be Too Trailing-Stop-Like

The code still contains trailing terminology and logic.

The user wants:

- Hold through normal continuation pullbacks.
- Exit only on validated exhaustion.
- TP/protection derived from target move potential.
- No panic close simply because a pullback occurs.

This requires a deeper parity check between lifecycle replay and `manageOpenPositions()`.

## 14. What To Verify Next

Recommended independent review sequence:

1. Confirm deployed commit.

   Check both main/live and codex-dev deployments report commit `93f06be4` or later.

2. Inspect promoted runtime artifacts for CRASH300 and R_75.

   Verify they include:

   - service id
   - source build run id
   - selected policy id
   - runtime setup contract
   - TP/protection/lifecycle settings
   - R_75 selected runtime contracts
   - R_75 component thresholds and evidence thresholds
   - CRASH300 calibrated component expectations

3. Rerun Validate Runtime for both services.

   Validate Runtime should include recent-candle replay and report candidate emission counts.

4. Replay recent live candles after latest commit.

   Expected results should be near historical frequency, not hundreds/thousands of candidates per 5000 candles.

5. Compare one live candidate to build accepted-trade distributions.

   For each emitted live candidate, log:

   - engine name
   - direction
   - runtime setup reason
   - matched bucket
   - component scores
   - thresholds used
   - expected move
   - TP/SL/protection settings
   - whether it matches any selected runtime contract

6. Compare one opened live trade to lifecycle replay.

   Confirm:

   - same TP model
   - same hard SL/protection model
   - same maturity rules
   - same exhaustion conditions
   - same normal-pullback tolerance

7. Confirm allocator only rejects for portfolio reasons.

   Acceptable allocator rejection reasons:

   - kill switch
   - mode inactive
   - symbol disabled
   - cascade interval wait
   - max open trades
   - daily/weekly loss limit
   - max drawdown
   - insufficient capacity
   - target capital utilization reached

   Suspicious allocator rejection reasons for promoted service candidates:

   - `confidence_below_threshold`
   - `score_below_gate`
   - generic composite/native score failure

8. Check trade manager parity.

   The runtime can be perfectly admitted and still lose if `manageOpenPositions()` exits differently from Build Runtime Model lifecycle replay.

## 15. Current Test Status

Latest local checks before this document:

- `pnpm run typecheck`: passed
- `pnpm run build`: passed
- API structural verification: passed `20/20`
- API guardrails: passed `6/6`
- `git diff --check`: passed with only Windows LF/CRLF warnings

Build warnings still present:

- Vite sourcemap warning in `src/components/ui/tooltip.tsx`
- Vite sourcemap warning in `src/components/ui/progress.tsx`
- Vite chunk-size warning

These warnings did not fail the build.

## 16. Questions For External AI Models

Please answer these directly from code/artifact evidence:

1. Does live candidate emission now require the exact promoted runtime contract for CRASH300 and R_75?

2. Does R_75 live scanning enforce every filter that produced the 105/105 Build Runtime Model result?

3. Does CRASH300 live scanning enforce every filter that produced the promoted Build Runtime Model result?

4. Does `manageOpenPositions()` implement the same lifecycle exit model used during Build Runtime Model replay?

5. Are TP, SL, protection, and maturity settings serialized from Build Runtime Model into the promoted runtime artifact without loss?

6. Is the allocator truly capital-only once a service candidate is emitted?

7. Why did CRASH300 runs `#44`, `#64`, `#68`, and later runs differ so dramatically?

8. Is R_75 105/105 over 211 moves realistic, or is the build excluding losing cases?

9. Are historical UI reports mixing old artifact shapes with current renderer logic?

10. Are there still stale code paths that can open trades from native engine/coordinator output without service-runtime evidence?

## 17. Most Likely Remaining Root Causes

Based on current code and observed behavior, the remaining likely root causes are:

1. Runtime artifact serialization is still incomplete.

   The build may know why 105 trades passed, but the promoted runtime may not carry enough exact filters into live.

2. Candidate admission parity was only recently fixed.

   Any trades opened before commit `93f06be4` may not represent the current code.

3. Trade lifecycle parity is not proven.

   Candidate admission can be correct while live exits are still wrong.

4. UI/historical rows create confusion.

   Old allocator decisions and old runtime artifacts may be displayed through current UI labels.

5. CRASH300 and R_75 have different objective histories.

   Comparing old CRASH300 run results without checking the objective and data window can be misleading.

## 18. Suggested Next Engineering Work

Do not start by changing thresholds.

Instead, prove parity:

1. Add an operator-visible "Runtime Match Audit" for each emitted candidate.

   It should show the exact promoted runtime contract and every pass/fail dimension.

2. Add a "Trade Lifecycle Parity Audit" for every open/closed trade.

   It should show whether the live exit decision would match the Build Runtime Model lifecycle replay.

3. Store immutable runtime contract snapshots on each opened trade.

   Each trade should carry the exact runtime artifact subset used at entry, not just artifact id.

4. Rebuild CRASH300 and R_75 only after proving current live admission and exit logic.

5. Do not allow live/paper trades from any path that lacks:

   - service id
   - promoted runtime artifact id
   - matched runtime contract id
   - runtime setup reason
   - lifecycle plan id
   - allocator decision id

## 19. Plain-English Current State

The app has been moved a long way toward the intended V3.2 architecture:

- Research workflow is consolidated.
- Build Runtime Model is the runtime-builder.
- Validate Runtime and Promote Runtime are the manual gates.
- CRASH300 and R_75 can have promoted service runtimes.
- The allocator is intended to allocate capital rather than select strategy.
- Recent code now tries to force live candidates through promoted runtime evidence.

But the system is not yet fully proven.

The main remaining question is not whether the UI says a runtime is promoted. The real question is:

```text
Is every live/paper trade opened from exactly the same deterministic rule contract that produced the Build Runtime Model result, and is it managed by the same lifecycle exit model?
```

That is the central parity question an external reviewer should focus on.

