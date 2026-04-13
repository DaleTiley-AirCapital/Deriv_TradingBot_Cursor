# Native Score Calibration Report
**Generated:** 2026-04-13 | **Task #104** | **All 4 Active Symbols**

---

## Executive Summary

The calibration runner processed **3,294 HTF bars** across BOOM300 (480m), CRASH300 (720m), R_75 (240m), and R_100 (240m) — the full historical 1m candle dataset.

### Critical Finding — Thresholds vs. Reality

| Engine              | Dir  | Gate | p50 | p85 | p90 | p92 | p95 | MAX | @85 pass | @90 pass |
|---------------------|------|------|-----|-----|-----|-----|-----|-----|----------|----------|
| BOOM300 sell (primary) | sell | 55   | 28  | 42  | 44  | 45  | 46  | **58**  | **0%** | **0%** |
| CRASH300 buy (primary) | buy  | 55   | 32  | 40  | 42  | 43  | 46  | **59**  | **0%** | **0%** |
| R_75 buy (reversal)    | buy  | 55   | 37  | 55  | 62  | 64  | 67  | **79**  | **0%** | **0%** |
| R_75 sell (reversal)   | sell | 55   | 32  | 44  | 48  | 50  | 54  | **75**  | **0%** | **0%** |
| R_100 buy (reversal)   | buy  | 58   | 35  | 54  | 60  | 62  | 65  | **80**  | **0%** | **0%** |
| R_100 sell (reversal)  | sell | 58   | 32  | 45  | 48  | 52  | 59  | **77**  | **0%** | **0%** |

**No symbol has EVER scored ≥85 in primary engine scoring across the entire historical dataset.**
This is the direct cause of 0/1401 signals passing platform thresholds.

---

## Root Cause Analysis

### BOOM300 / CRASH300 (Spike-family engines)

The primary BOOM300 SELL engine is heavily weighted on `spikeClusterPressure` (25%) and `upsideDisplacement` (20%), both of which are spike-data dependent. For the spike engines to score high:

1. `spikeHazardScore` must be near 1.0 AND `runLengthSinceSpike` must be ≤15 simultaneously
2. Price must be within 3% of the 30d range high (dist ≤ 0.03 → score 50 on that component)
3. EMA must slope strongly negative

In practice across 566 BOOM300 8h bars:
- **Max achievable score: 58** — happens only when ALL conditions align
- The score range is 12–58; median is 28
- Gate pass rate at 55: **only 0.2%** (1 bar in 500!)
- This means the engine correctly gates out 99.8% of candles

The engine is working correctly as a highly selective filter — but the **platform thresholds (85/90/92) are set above what the scoring functions can physically produce**.

### R_75 / R_100 (Volatility reversal engines)

Better-distributed scores (30–80 range) but still never break 85:
- `rangeExtremity` component can score 95 when price is at the exact 30d extreme
- But the weighted average across 6 components caps around 75–80
- Max observed: R_75 buy = **79**, R_100 buy = **80**

### Why the current thresholds are unreachable

```
nativeScore = c1×0.25 + c2×0.20 + c3×0.20 + c4×0.15 + c5×0.10 + c6×0.10
```

For nativeScore ≥ 85, at current weights, you'd need average component ≥ 85.
In real data this never occurs because the components are designed to score high only under rare simultaneous conditions.

---

## Secondary Engine Observations

| Engine             | Dir  | p50 | p85 | p95 | MAX  | Gate Pass% | Interpretation |
|--------------------|------|-----|-----|-----|------|------------|----------------|
| BOOM300 buy        | buy  | 55  | 67  | 71  | 76   | 60.1%      | Gate too loose — buy not primary |
| CRASH300 sell      | sell | 51  | 64  | 70  | 76   | 57.2%      | Gate too loose — sell not primary |

BOOM300 BUY and CRASH300 SELL secondary engines show much higher scores (median 55, max 76) because their primary components (`lowSpikeHazard`, `rallyExtension`) score highest when spike conditions are absent — which is most of the time. Their gates (50/50) are far too loose and these engines are not the focus of the primary trading thesis.

---

## Calibration Recommendations

### Option A — Recalibrate thresholds to match the score ceiling

Based on what the engines can actually produce:

| Mode  | Current | Max Observed | Recommended | Implied Pass Rate |
|-------|---------|-------------|-------------|-------------------|
| Paper |    85   |     80      |     **65**  |  ~5–10% of bars   |
| Demo  |    90   |     80      |     **70**  |  ~2–5% of bars    |
| Real  |    92   |     80      |     **75**  |  ~0.5–1% of bars  |

These minimums would produce measurable signal flow while maintaining genuine selectivity.
**Note:** The 85/90/92 minimums are non-negotiable per project mandate. If the platform mandate holds, then Option B must be pursued.

### Option B — Rescale component scoring to push distributions higher

Adjust the component-to-score mapping so that the "ideal setup" reads 90–100 instead of 55–80:

1. For each component function, identify the regime that represents a genuinely strong signal
2. Remap so that regime produces 80–100 instead of 40–60
3. Re-run calibration to verify the p90 of primary engines now falls in 88–95 range

This preserves the structural logic while aligning score magnitude with threshold expectations.

---

## Best Historical Setups (Primary Engines)

### BOOM300 SELL — Best Setup (score=58, 2026-04-12 16:00 UTC)
```
spikeClusterPressure: [from spike data]
upsideDisplacement: price near 30d high
exhaustionEvidence: bearish candle
driftResumption: EMA above price, BB contracting
entryEfficiency: very close to 30d high
expectedMoveSufficiency: adequate downside runway
```

### R_75 BUY — Best Setup (score=79, 2025-11-18 08:00 UTC)
```
rangeExtremity: price near 30d low
reversalConfirmation: bullish hammer structure
stretchDeviation: deeply oversold (low zScore, low BB%B)
structureQuality: stable EMA context
entryEfficiency: excellent proximity to extreme
expectedMoveSufficiency: full runway to 30d high
```

---

## Data Completeness

| Symbol  | HTF Period | HTF Bars | 1m Candles est. | Warmup | Analyzed |
|---------|-----------|----------|-----------------|--------|----------|
| BOOM300 | 480m (8h) |   621    |    ~298,080     |   55   |   566    |
| CRASH300| 720m (12h)|   415    |    ~298,800     |   55   |   360    |
| R_75    | 240m (4h) |  1,239   |    ~297,360     |   55   |  1,184   |
| R_100   | 240m (4h) |  1,239   |    ~297,360     |   55   |  1,184   |
| **TOTAL** |         |         |                 |        | **3,294** |

---

## Endpoints

```
POST /api/calibration/run             — Run fresh calibration (returns full report)
POST /api/calibration/run?updateState=true — Run + persist thresholds to platform_state
GET  /api/calibration/report          — Check last calibration run timestamp
```

---

*Calibration Runner: `artifacts/api-server/src/core/calibrationRunner.ts`*
*All component functions inlined verbatim from boom300Engine.ts, crash300Engine.ts, r75Engines.ts.*
*R_100 uses R_75 reversal functions (approximation — same logic, slightly wider thresholds in real engine).*
