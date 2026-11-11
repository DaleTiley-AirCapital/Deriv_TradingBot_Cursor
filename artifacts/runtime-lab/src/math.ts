import type { DistributionSummary } from "./types.js";

export function percentile(values: number[], p: number): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = (finite.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return finite[lower] ?? null;
  const lowerValue = finite[lower] ?? 0;
  const upperValue = finite[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

export function summarize(values: number[]): DistributionSummary {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    p10: percentile(finite, 0.1),
    p25: percentile(finite, 0.25),
    median: percentile(finite, 0.5),
    p75: percentile(finite, 0.75),
    p90: percentile(finite, 0.9),
  };
}

export function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return 0;
  return (to - from) / from;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function median(values: number[]): number {
  return percentile(values, 0.5) ?? 0;
}
