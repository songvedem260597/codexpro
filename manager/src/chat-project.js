export function projectSelectionChanged(previousRoot, nextRoot) {
  const normalize = (value) => String(value || "").trim().replace(/[\\/]+$/, "").toLowerCase();
  const previous = normalize(previousRoot);
  const next = normalize(nextRoot);
  return Boolean(previous && next && previous !== next);
}
