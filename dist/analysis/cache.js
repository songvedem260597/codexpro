const MAX_CACHE_ENTRIES = 8;
const cache = new Map();
export function getCachedWorkspaceAnalysis(key) {
    const value = cache.get(key);
    if (!value)
        return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
}
export function setCachedWorkspaceAnalysis(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (!oldest)
            break;
        cache.delete(oldest);
    }
}
export function invalidateWorkspaceAnalysis(workspaceId) {
    for (const key of cache.keys()) {
        if (key.startsWith(`${workspaceId}:`))
            cache.delete(key);
    }
}
//# sourceMappingURL=cache.js.map