export const APP_VERSION = "3.0.0";
export const APP_NAME = "Deriv Trading - Long Hold V3";
export const LAST_UPDATED = "2026-04-14";

export interface ReleaseEntry {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

export const RELEASES: ReleaseEntry[] = [
  {
    version: "3.0.0",
    date: "2026-04-14",
    title: "V3 Symbol-Native Engine System — Live Path Rewrite",
    changes: [
      "9 symbol-native engines replace all V2 shared-scoring: boom_expansion, boom_expansion_long, crash_expansion, r75x3 (continuation/reversal/breakout), r100x3",
      "Per-engine 6-component native scores (0–100) — no shared generic composite scoring path in live system",
      "Symbol Coordinator resolves multi-engine conflicts (R_75, R_100): priority breakout>continuation>reversal",
      "3-stage hybrid trade manager: entry SL, breakeven promotion at 20% TP, ATR trailing from 30% TP",
      "Current score gates: Paper≥60, Demo≥65, Real≥70 — will raise as calibration data supports higher values",
      "Signal visibility threshold set to 50, blocked/rejected signals surfaced in Engine Decisions",
      "V3 Isolated Backtest Engine in Research tab with JSON export",
      "Railway rebuild script for deterministic clean deploys",
    ],
  },
  {
    version: "2.0.0",
    date: "2026-03-29",
    title: "V2 Empirical Big Move Readiness Scoring",
    changes: [
      "Replaced logistic regression with empirical 5-dimension Big Move Readiness Score",
      "New scoring dimensions: Range Position (25%), MA Deviation (20%), Volatility Profile (20%), Range Expansion (15%), Directional Confirmation (20%)",
      "Research-driven thresholds from actual 50-200%+ move analysis",
      "V2 scoring thresholds (superseded by V3 calibrated gates): Paper 85 / Demo 90 / Real 92",
      "AI suggestion floors prevent threshold drift below V2 minimums",
      "Startup migration enforces minimum thresholds on every boot",
      "Updated OpenAPI spec, generated types, and frontend for new dimensions",
      "Created strategy skill documentation",
      "Added Help/About page with release history",
      "Rebranded to 'Deriv Trading - Long Hold'",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-02-01",
    title: "Initial V1 Release",
    changes: [
      "Full-stack trading platform for Deriv synthetic indices",
      "5 strategy families: trend continuation, mean reversion, spike cluster recovery, swing exhaustion, trendline breakout",
      "Regime-first architecture with 8 market regime classifications",
      "Multi-mode trading: Paper, Demo, Real with independent configuration",
      "30% trailing stop safety net (no time-based exits)",
      "Multi-window signal confirmation (3 windows, 90min gaps)",
      "Pyramiding support up to 3 positions per symbol",
      "AI verification via GPT-5.1",
      "Comprehensive backtesting engine with walk-forward testing",
      "12-symbol data collection, 4-symbol active trading",
    ],
  },
];

