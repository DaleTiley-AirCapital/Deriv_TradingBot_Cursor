export const CALIBRATION_MOVE_BUCKETS = [
  { label: "1-2", min: 1, max: 2 },
  { label: "2-3", min: 2, max: 3 },
  { label: "3-4", min: 3, max: 4 },
  { label: "4-5", min: 4, max: 5 },
  { label: "5-6", min: 5, max: 6 },
  { label: "6-7", min: 6, max: 7 },
  { label: "7-8", min: 7, max: 8 },
  { label: "8-9", min: 8, max: 9 },
  { label: "9-10", min: 9, max: 10 },
  { label: "10-11", min: 10, max: 11 },
  { label: "11-12", min: 11, max: 12 },
  { label: "12-13", min: 12, max: 13 },
  { label: "13-14", min: 13, max: 14 },
  { label: "14-15", min: 14, max: 15 },
] as const;

export function getMovePctBucket(movePctFraction: number): string {
  const movePct = Math.abs(movePctFraction) * 100;
  for (const bucket of CALIBRATION_MOVE_BUCKETS) {
    if (movePct >= bucket.min && movePct < bucket.max) return bucket.label;
  }
  return movePct < 1 ? "<1" : "15+";
}
