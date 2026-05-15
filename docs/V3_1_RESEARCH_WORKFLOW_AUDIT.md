# V3.1 Research Workflow Data Store Audit

No new database tables were added for the V3.1 workflow consolidation. Existing stores are reused and old diagnostic endpoints remain backend/debug surfaces where useful.

| Store / artifact | Written by | Read by | Contains | Class | Duplicate / overlap | Runtime build needed | User report needed | Decision |
|---|---|---|---|---|---|---|---|---|
| `candles` | boot schema, data integrity routes, historical download/top-up | data coverage, calibration, backtest, phase reports, runtime services | OHLCV candles, timeframe, interpolation/source flags | source data | canonical candle store | yes | yes, coverage only | keep visible under Data Coverage |
| `ticks` | boot schema, tick ingestion | stream/diagnostics | raw tick stream | source data | overlaps candles only by derivation | no | execution debug | keep backend/export only |
| `detected_moves` | full calibration move detection | calibration reports, synthesis, parity, phase identifiers | historical move universe and quality/context metadata | source research data | feeds several derived reports | yes | yes | keep report |
| `calibration_pass_runs` | calibration pass runner | calibration status, run history, reports | pass run status, totals, errors, metadata | validation/derived | no | yes, as source run id | yes | keep report |
| `move_precursor_passes` | precursor AI pass | calibration profile/synthesis/debug exports | per-move precursor fit and misses | derived data | partially overlaps move context JSON | yes | advanced export only | keep backend, report via pass results |
| `move_behavior_passes` | behavior/trigger/extraction passes | calibration profile/synthesis/debug exports | entry timing, captureable move, holdability, trigger behavior | derived data | overlaps selected trade/lifecycle reports | yes | advanced export only | keep backend, report via pass results |
| `move_family_inferences` | family inference pass | synthesis/profile/debug | AI-assisted family classification | derived data | overlaps detected move candidate family | yes | no primary | keep backend |
| `move_progression_artifacts` | progression/extraction pass | synthesis/profile/debug | move progression and strategy-family details | derived data | overlaps behavior pass | yes | no primary | keep backend |
| `calibration_feature_relevance` | bucket model synthesis | runtime profile/synthesis | feature weights by family/bucket | derived data | overlaps family bucket profiles | yes | no primary | keep backend |
| `calibration_entry_ideals` | bucket model synthesis | runtime profile/synthesis | ideal entry conditions by family/bucket | derived data | overlaps runtime rule draft | yes | no primary | keep backend |
| `calibration_exit_risk_profiles` | bucket model synthesis | runtime profile/synthesis | exit/risk profile by family/bucket | derived data | overlaps lifecycle and profit ranking | yes | no primary | keep backend |
| `calibration_feature_frames` | deterministic enrichment | synthesis, phase/debug exports | feature snapshots around moves | source research data | overlaps phase identifier snapshots | yes | no primary | keep backend |
| `calibration_move_window_summaries` | deterministic enrichment | synthesis/debug | window summaries for move lead-in/outcome | source research data | overlaps phase reports | yes | no primary | keep backend |
| `calibration_family_bucket_profiles` | bucket model synthesis | runtime profile/synthesis | family and move-size bucket profiles | derived data | overlaps symbol research profile | yes | no primary | keep backend |
| `strategy_calibration_profiles` | calibration profile generation | calibration reports/runtime model | per-move-type fit, misses, profitability, feeddown schema | derived data | overlaps symbol profile | yes | yes | keep report |
| `symbol_research_profiles` | full calibration final profile | runtime model status, build model | latest symbol-level research recommendation | derived data | overlaps strategy profiles in summary form | yes | yes | keep report |
| `model_runs` | older model training path | historical diagnostics | model metadata/results | obsolete/legacy | replaced by research profiles and build jobs | no | no primary | keep backend only |
| `backtest_runs` | V3 backtest runner | validation reports, comparison, attribution | persisted backtest config/result JSON | validation data | overlaps runtime validation result | yes, for validation | yes | keep report, remove peer action |
| `backtest_trades` | V3 backtest persistence | backtest reports/attribution | simulated trade rows | validation data | overlaps selected trades and trade lifecycle replay | yes, for validation | yes | keep report |
| `signal_log` | live/backtest signal logging | execution exports, signal page | signal decisions and rejection lifecycle | execution data | overlaps service candidates | no build, yes validation provenance | yes | keep execution report |
| `service_candidates` | service candidate factory/execution path | execution reports/allocator | runtime-produced candidate provenance | execution data | overlaps signal log | no build, yes validation provenance | yes | keep execution report |
| `allocator_decisions` | allocator | execution reports | allocator decision, risk and mode provenance | execution data | no | no build, yes validation provenance | yes | keep execution report |
| `trades` | trade engine | execution reports/lifecycle | open and closed trade lifecycle | execution data | overlaps broker state | no build, yes validation provenance | yes | keep execution report |
| `behavior_events` | backtest behavior capture | lifecycle replay/debug | event-level trade lifecycle details | validation data | overlaps backtest trades | yes, lifecycle simulation | yes | keep report |
| `platform_state` staged symbol model entries | calibration runtime model staging | runtime model UI, calibration routes | staged/promoted legacy symbol runtime model JSON | derived/runtime state | overlaps service runtime artifact | transitional | status only | keep backend, reduce UI emphasis |
| `platform_state` `staged_synthesis_candidate_<SERVICE>` | candidate staging endpoint | service lifecycle, runtime tab | pointer to staged candidate artifact and source job | runtime state | no | yes | status only | keep |
| `platform_state` `promoted_service_runtime_<SERVICE>` | Promote Runtime endpoint | service execution gate, lifecycle, runtime tab | promoted service runtime artifact and mode gates | runtime state | canonical service runtime state | no build, yes execution | status only | keep |
| `elite_synthesis_jobs` | Build Runtime Model worker/job route | build history, reports, candidate staging | params, progress, result artifact, candidate runtime artifacts, baseline records | derived/build data | overlaps many exported subreports | yes | yes | keep, rename UI to Build Runtime Model |
| `symbol_model_optimisation_runs` | backtest optimiser | optimiser status/debug | optimiser run lifecycle and selected winner | validation/build internal | overlaps Build Runtime Model profit ranking | internal only | no primary | keep backend, remove UI action |
| `symbol_model_optimisation_candidates` | backtest optimiser | optimiser status/debug | optimiser candidate metrics | validation/build internal | overlaps candidate leaderboard | internal only | no primary | keep backend, remove UI action |
| `runtime_build_result_<SERVICE>_<RUN>.json` | runtime build export route | Reports tab | consolidated build summary over existing job/profile/report data | derived artifact | consolidates selected candidate, profit, lifecycle, coverage reports | yes | yes | add artifact, no table |
| `runtime_validation_result_<SERVICE>_<RUN>.json` | Validate Runtime route | Runtime tab / Reports | consolidated validation status over staged candidate and existing diagnostic stages | validation artifact | consolidates backtest/parity/trigger/noise/provenance statuses | no build | yes | add artifact, no table |
| phase identifier summary/sample/full | CRASH300 phase identifier exports | Reports | move phase identifiers, parity timing, linked backtest attribution | validation/debug artifact | overlaps parity and attribution | yes, as coverage/missed-move input | grouped validation/build report | keep report only |
| selected trades export | Build Runtime Model result export | Reports | trades selected by recommended candidate/policy | derived build artifact | overlaps backtest trades | yes | yes | keep report |
| return amplification export | Build Runtime Model result export | Reports | profit ranking, return-first scenarios, rejected high-profit candidates | derived build artifact | overlaps optimiser candidates | yes | yes | keep report |
| policy comparison export | Build Runtime Model / backtest compare | Reports | candidate leaderboard or run comparison | derived validation/build artifact | overlaps optimiser candidate ranking | yes | yes | keep report only |
| trade lifecycle replay export | Build Runtime Model result export | Reports | entry/exit lifecycle replay and exit-policy audit | validation/build artifact | overlaps behavior events/backtest trades | yes | yes | keep report |

## UI Disposition

Visible workflow actions kept:

- Data Coverage
- Full Calibration
- Build Runtime Model
- Validate Runtime
- Promote Runtime
- Stream / Monitor

Removed as peer-level workflow actions:

- Run Integrated Elite Synthesis
- Validate Current Runtime Backtest
- Run Parity
- Runtime Trigger Validation
- Optimiser
- Backtest Calibration Optimiser
- Policy Comparison as a workflow action
- Move-centric Strategy Lab
- High-capture artifact build

These capabilities remain internal stages or read-only reports where existing backend support is useful.
