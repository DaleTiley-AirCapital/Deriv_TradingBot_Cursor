export function formatDurationCompact(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;

  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map(v => String(v).padStart(2, "0")).join(":");
  }

  return [minutes, seconds].map(v => String(v).padStart(2, "0")).join(":");
}
