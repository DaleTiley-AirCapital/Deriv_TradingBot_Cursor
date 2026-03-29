export const APP_VERSION = "2.0.0";
export const APP_NAME = "Deriv Trading - Long Hold";
export const LAST_UPDATED = "2026-03-29";

export interface ReleaseEntry {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

export const RELEASES: ReleaseEntry[] = [
  {
    version: "2.0.0",
    date: "2026-03-29",
    title: "V2 Empirical Big Move Readiness Scoring",
    changes: [
      "Replaced logistic regression with empirical 5-dimension Big Move Readiness Score",
      "New scoring dimensions: Range Position (25%), MA Deviation (20%), Volatility Profile (20%), Range Expansion (15%), Directional Confirmation (20%)",
      "Research-driven thresholds from actual 50-200%+ move analysis",
      "Scoring thresholds enforced: Paper 85, Demo 90, Real 92",
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
      "30% trailing stop safety net, 72h profitable exit backstop",
      "Multi-window signal confirmation (3 windows, 90min gaps)",
      "Pyramiding support up to 3 positions per symbol",
      "AI verification via GPT-4o",
      "Comprehensive backtesting engine with walk-forward testing",
      "12-symbol data collection, 4-symbol active trading",
    ],
  },
];
