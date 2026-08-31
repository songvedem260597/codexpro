export function formatWorkerRunningDuration(startedAt, now = Date.now()) {
  const startedAtMs = Date.parse(String(startedAt || ""));
  const nowMs = Number(now);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return "";
  const elapsedSeconds = Math.floor(Math.max(0, nowMs - startedAtMs) / 1_000);
  const seconds = elapsedSeconds % 60;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const minutes = elapsedMinutes % 60;
  const hours = Math.floor(elapsedMinutes / 60);
  const paddedSeconds = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
    : `${elapsedMinutes}:${paddedSeconds}`;
}
