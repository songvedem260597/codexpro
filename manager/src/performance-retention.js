export function trimMapEntries(map, maxEntries = 128) {
  if (!(map instanceof Map)) return 0;
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 128));
  let removed = 0;
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
    removed += 1;
  }
  return removed;
}

export function trimSetEntries(set, maxEntries = 128) {
  if (!(set instanceof Set)) return 0;
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 128));
  let removed = 0;
  while (set.size > limit) {
    const oldestValue = set.values().next().value;
    if (oldestValue === undefined) break;
    set.delete(oldestValue);
    removed += 1;
  }
  return removed;
}

export function pruneTimestampMap(map, { maxEntries = 128, maxAgeMs = 30 * 60_000, now = Date.now() } = {}) {
  if (!(map instanceof Map)) return 0;
  const cutoff = Number(now) - Math.max(1_000, Number(maxAgeMs) || 30 * 60_000);
  let removed = 0;
  for (const [key, value] of map) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed + trimMapEntries(map, maxEntries);
}
