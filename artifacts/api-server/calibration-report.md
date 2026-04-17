# Native Score Calibration Report

> Current runtime operating gates are tracked in `docs/current-operating-policy.md`.
> This report contains calibration analysis context and historical floor policy discussion.

Generated: 2026-04-13T16:11:40.983Z
HTF bars analyzed: 3297

## Threshold Summary

| Mode | Current (old) | Data-Driven Recommendation | Mandatory Floor |
|------|---------------|---------------------------|-----------------|
| Paper | 85 | **52** | 85 |
| Demo  | 90 | **55** | 90 |
| Real  | 92 | **62** | 92 |

**Rationale**: Data-driven: 3297 HTF bars across 4 symbols. Primary engine p90/p92/p95 medians: 52/55/62. Current pass rates at 85: [BOOM300(sell)@85=0%, CRASH300(buy)@85=0%, R_75(buy)@85=0%, R_75(sell)@85=0%, R_100(buy)@85=0%, R_100(sell)@85=0%]. Recommended thresholds derived from actual score distributions without enforcing minimum floors. If these are below the mandatory minimums (85/90/92), the engines need component recalibration — not threshold lowering.

> **Note**: Recommended thresholds are below the mandatory minimums. This documents that
> engines need component recalibration, not threshold lowering. The 85/90/92 floors are NON-NEGOTIABLE.

## Per-Engine Score Distributions

| Symbol | Engine | Dir | Bars | Gate | p50 | p85 | p90 | p92 | p95 | Max | @60 | @70 | @80 | @85 | Gate% |
|--------|--------|-----|------|------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-------|
| BOOM300 | boom | sell | 567 | 55 | 28 | 42 | 44 | 45 | 46 | 58 | 0 | 0 | 0 | 0 | 0.4% |
| BOOM300 | boom | buy | 567 | 50 | 59 | 69 | 70 | 70 | 72 | 78 | 279 | 64 | 0 | 0 | 77.6% |
| CRASH300 | crash | buy | 360 | 55 | 32 | 40 | 42 | 43 | 46 | 56 | 0 | 0 | 0 | 0 | 0.3% |
| CRASH300 | crash | sell | 360 | 50 | 51 | 64 | 66 | 68 | 70 | 76 | 84 | 21 | 0 | 0 | 57.2% |
| R_75 | r75:reversal | buy | 1185 | 55 | 37 | 55 | 62 | 64 | 67 | 79 | 139 | 34 | 0 | 0 | 15.9% |
| R_75 | r75:reversal | sell | 1185 | 55 | 32 | 44 | 48 | 50 | 54 | 75 | 38 | 6 | 0 | 0 | 5% |
| R_75 | r75:continuation | buy | 1185 | 58 | 49 | 67 | 70 | 72 | 74 | 83 | 331 | 139 | 5 | 0 | 33.2% |
| R_75 | r75:continuation | sell | 1185 | 58 | 51 | 67 | 71 | 72 | 74 | 82 | 351 | 139 | 11 | 0 | 35.2% |
| R_75 | r75:breakout | buy | 1185 | 60 | 32 | 52 | 55 | 57 | 59 | 78 | 55 | 14 | 0 | 0 | 4.6% |
| R_75 | r75:breakout | sell | 1185 | 60 | 36 | 58 | 62 | 65 | 68 | 82 | 155 | 51 | 3 | 0 | 13.1% |
| R_100 | r100:reversal | buy | 1185 | 58 | 36 | 56 | 61 | 62 | 65 | 78 | 139 | 17 | 0 | 0 | 13.7% |
| R_100 | r100:reversal | sell | 1185 | 58 | 29 | 47 | 52 | 55 | 62 | 77 | 80 | 20 | 0 | 0 | 7.3% |
| R_100 | r100:breakout | buy | 1185 | 60 | 26 | 47 | 52 | 55 | 60 | 77 | 68 | 19 | 0 | 0 | 5.7% |
| R_100 | r100:breakout | sell | 1185 | 60 | 31 | 54 | 59 | 61 | 66 | 78 | 112 | 30 | 0 | 0 | 9.5% |
| R_100 | r100:continuation | buy | 1185 | 62 | 45 | 60 | 63 | 65 | 67 | 76 | 195 | 30 | 0 | 0 | 13.2% |
| R_100 | r100:continuation | sell | 1185 | 62 | 50 | 61 | 64 | 66 | 68 | 81 | 214 | 39 | 1 | 0 | 14.9% |

## Ideal Setup Cohorts (best examples per engine)

### BOOM300 boom_expansion_engine (sell)
Ideal threshold: 39 | count: 121 | mean: 44 | median: 44 | p90: 48

### BOOM300 boom_expansion_engine (buy)
Ideal threshold: 68 | count: 117 | mean: 70.5 | median: 70 | p90: 74

### CRASH300 crash_expansion_engine (buy)
Ideal threshold: 38 | count: 91 | mean: 42.2 | median: 41 | p90: 48

### CRASH300 crash_expansion_engine (sell)
Ideal threshold: 61 | count: 78 | mean: 66.6 | median: 66 | p90: 72

### R_75 r75_reversal_engine (buy)
Ideal threshold: 51 | count: 240 | mean: 61.5 | median: 62 | p90: 71

### R_75 r75_reversal_engine (sell)
Ideal threshold: 42 | count: 246 | mean: 50.1 | median: 47 | p90: 64

### R_75 r75_continuation_engine (buy)
Ideal threshold: 64 | count: 254 | mean: 70.3 | median: 70 | p90: 76

### R_75 r75_continuation_engine (sell)
Ideal threshold: 64 | count: 254 | mean: 70.7 | median: 70 | p90: 77

### R_75 r75_breakout_engine (buy)
Ideal threshold: 48 | count: 254 | mean: 55.9 | median: 54 | p90: 66

### R_75 r75_breakout_engine (sell)
Ideal threshold: 54 | count: 244 | mean: 63.3 | median: 62 | p90: 73

### R_100 r100_reversal_engine (buy)
Ideal threshold: 52 | count: 244 | mean: 60.7 | median: 61 | p90: 68

### R_100 r100_reversal_engine (sell)
Ideal threshold: 42 | count: 254 | mean: 53.8 | median: 51 | p90: 68

### R_100 r100_breakout_engine (buy)
Ideal threshold: 44 | count: 241 | mean: 54.4 | median: 52 | p90: 67

### R_100 r100_breakout_engine (sell)
Ideal threshold: 50 | count: 242 | mean: 59.9 | median: 58 | p90: 71

### R_100 r100_continuation_engine (buy)
Ideal threshold: 58 | count: 246 | mean: 63.8 | median: 63 | p90: 70

### R_100 r100_continuation_engine (sell)
Ideal threshold: 59 | count: 246 | mean: 64.8 | median: 64 | p90: 71

## Critical Finding

**Zero signals would ever pass the 85/90/92 thresholds** with current component scoring functions.
Maximum observed scores:

BOOM300/sell: 58, BOOM300/buy: 78, CRASH300/buy: 56, CRASH300/sell: 76, R_75/buy: 79, R_75/sell: 75, R_75/buy: 83, R_75/sell: 82, R_75/buy: 78, R_75/sell: 82, R_100/buy: 78, R_100/sell: 77, R_100/buy: 77, R_100/sell: 78, R_100/buy: 76, R_100/sell: 81

**Root cause**: Component scoring functions require conditions that never simultaneously occur in historical HTF data
at the current timeframes (BOOM300=480m, CRASH300=720m, R_75/R_100=240m).
**Action required**: Recalibrate component weights and scoring curves, not just thresholds.