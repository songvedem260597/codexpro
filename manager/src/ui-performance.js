const browserProfileSignatureCache = new WeakMap();
export const EMPTY_BROWSER_PROFILE_GRACE_MS = 15_000;

export function browserProfileUiSignature(profile) {
  if (!profile || typeof profile !== "object") return "";
  const cached = browserProfileSignatureCache.get(profile);
  if (cached) return cached;
  const { last_seen: _lastSeen, ...uiState } = profile;
  const signature = JSON.stringify(uiState);
  browserProfileSignatureCache.set(profile, signature);
  return signature;
}

export function mergeBrowserProfilePayload(previousProfiles, incomingProfiles) {
  const previous = Array.isArray(previousProfiles) ? previousProfiles : [];
  const incoming = Array.isArray(incomingProfiles) ? incomingProfiles : [];
  if (!previous.length) return incoming;
  const previousById = new Map(previous.map((profile) => [profile.profile_id, profile]));
  let changed = previous.length !== incoming.length;
  const merged = incoming.map((profile) => {
    const prior = previousById.get(profile.profile_id);
    if (!prior) {
      changed = true;
      return profile;
    }
    const candidate = { ...prior, ...profile };
    if (browserProfileUiSignature(prior) === browserProfileUiSignature(candidate)) return prior;
    changed = true;
    return candidate;
  });
  if (!changed && incoming.every((profile) => previousById.has(profile.profile_id))) return previous;
  return merged;
}

export function stabilizeEmptyBrowserProfileSnapshot(previousProfiles, incomingProfiles, options = {}) {
  const removedProfileIds = new Set(
    (Array.isArray(options.removedProfileIds) ? options.removedProfileIds : [])
      .map((profileId) => String(profileId || ""))
      .filter(Boolean)
  );
  const previousSource = Array.isArray(previousProfiles) ? previousProfiles : [];
  const previous = removedProfileIds.size
    ? previousSource.filter((profile) => !removedProfileIds.has(String(profile?.profile_id || "")))
    : previousSource;
  const incoming = Array.isArray(incomingProfiles) ? incomingProfiles : [];
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : EMPTY_BROWSER_PROFILE_GRACE_MS;
  const emptySinceMs = Number.isFinite(options.emptySinceMs) ? Math.max(0, options.emptySinceMs) : 0;

  if (incoming.length || !previous.length) {
    return {
      profiles: mergeBrowserProfilePayload(previous, incoming),
      emptySinceMs: 0,
      preserved: false,
      retryAfterMs: 0
    };
  }

  const startedAt = emptySinceMs || nowMs;
  const elapsedMs = Math.max(0, nowMs - startedAt);
  if (elapsedMs < graceMs) {
    return {
      profiles: previous,
      emptySinceMs: startedAt,
      preserved: true,
      retryAfterMs: Math.max(1, graceMs - elapsedMs)
    };
  }

  return {
    profiles: [],
    emptySinceMs: 0,
    preserved: false,
    retryAfterMs: 0
  };
}

export function mergeRuntimeStatus(previousStatus, incomingStatus) {
  if (!incomingStatus || typeof incomingStatus !== "object") return previousStatus;
  const previous = previousStatus && typeof previousStatus === "object" ? previousStatus : null;
  const workerSnapshotAvailable = incomingStatus.workerSnapshotAvailable !== false;
  const workerJobsAvailable = incomingStatus.workerJobsAvailable !== false;

  if (workerSnapshotAvailable) {
    const browserProfiles = mergeBrowserProfilePayload(previous?.browserProfiles, incomingStatus.browserProfiles);
    return {
      ...incomingStatus,
      browserProfiles,
      workerJobs: workerJobsAvailable ? incomingStatus.workerJobs : (previous?.workerJobs || []),
      workerSnapshotStale: false,
      workerSnapshotStaleSince: ""
    };
  }

  return {
    ...incomingStatus,
    browserProfiles: previous?.browserProfiles || incomingStatus.browserProfiles || [],
    workers: previous?.workers || incomingStatus.workers || [],
    workerSources: previous?.workerSources || incomingStatus.workerSources || [],
    workerJobs: workerJobsAvailable ? incomingStatus.workerJobs : (previous?.workerJobs || incomingStatus.workerJobs || []),
    workerSnapshotStale: true,
    workerSnapshotStaleSince: previous?.workerSnapshotStaleSince || incomingStatus.checkedAt || new Date().toISOString()
  };
}

export function sameProjectList(previousProjects, nextProjects) {
  const previous = Array.isArray(previousProjects) ? previousProjects : [];
  const next = Array.isArray(nextProjects) ? nextProjects : [];
  if (previous.length !== next.length) return false;
  return previous.every((project, index) => JSON.stringify(project) === JSON.stringify(next[index]));
}
