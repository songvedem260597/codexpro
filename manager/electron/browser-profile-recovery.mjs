function normalizedProfileId(value) {
  return String(value || "").trim();
}

function workerIsStarting(worker, nowMs, startingGraceMs) {
  const startingAtMs = Date.parse(String(worker?.startingAt || ""));
  return Number.isFinite(startingAtMs) && Math.max(0, nowMs - startingAtMs) < startingGraceMs;
}

function latestLifecycleEvent(profile) {
  const history = Array.isArray(profile?.lifecycle_events)
    ? profile.lifecycle_events.filter((event) => event && typeof event === "object" && !Array.isArray(event))
    : [];
  return history.at(-1) || (profile?.lifecycle_event && typeof profile.lifecycle_event === "object" ? profile.lifecycle_event : null);
}

function recoveryEvidence(profile, nowMs, evidenceMaxAgeMs) {
  if (!profile || profile.connected !== false) return null;
  const event = latestLifecycleEvent(profile);
  if (!event || String(event.type || "") !== "window_removed") return null;
  const reason = String(event.reason || "unknown");
  if (reason === "browser_control_close_profile") return null;
  const eventAtMs = Date.parse(String(event.at || ""));
  if (!Number.isFinite(eventAtMs) || Math.max(0, nowMs - eventAtMs) > evidenceMaxAgeMs) return null;
  return { event, reason };
}

export function createBrowserProfileRecoveryPlanner({
  now = () => Date.now(),
  missingGraceMs = 60_000,
  launchCooldownMs = 60_000,
  startingGraceMs = 45_000,
  evidenceMaxAgeMs = 10 * 60_000
} = {}) {
  const missingProfiles = new Map();

  function observe({ profiles = [], workers = [] } = {}) {
    const nowMs = Number(now());
    const observedProfiles = new Map(
      (Array.isArray(profiles) ? profiles : [])
        .map((profile) => [normalizedProfileId(profile?.profile_id), profile])
        .filter(([profileId]) => Boolean(profileId))
    );
    const liveProfileIds = new Set(
      [...observedProfiles.entries()]
        .filter(([, profile]) => profile?.connected !== false)
        .map(([profileId]) => profileId)
    );
    const expectedProfiles = new Map();

    for (const worker of Array.isArray(workers) ? workers : []) {
      const profileId = normalizedProfileId(worker?.sourceProfileId);
      const profileDirectory = String(worker?.sourceProfileDirectory || "").trim();
      if (!profileId || !profileDirectory) continue;
      if (worker?.running === true || Number(worker?.pid) > 0 || workerIsStarting(worker, nowMs, startingGraceMs)) continue;
      expectedProfiles.set(profileId, {
        profileId,
        profileDirectory,
        label: String(worker?.sourceProfileName || worker?.label || profileDirectory).trim()
      });
    }

    for (const profileId of missingProfiles.keys()) {
      if (!expectedProfiles.has(profileId) || liveProfileIds.has(profileId)) missingProfiles.delete(profileId);
    }

    const launches = [];
    for (const expected of expectedProfiles.values()) {
      if (liveProfileIds.has(expected.profileId)) continue;
      let state = missingProfiles.get(expected.profileId);
      if (!state) {
        state = { missingSinceMs: nowMs, lastLaunchAtMs: 0 };
        missingProfiles.set(expected.profileId, state);
      }
      if (nowMs - state.missingSinceMs < missingGraceMs) continue;
      if (state.lastLaunchAtMs && nowMs - state.lastLaunchAtMs < launchCooldownMs) continue;
      const evidence = recoveryEvidence(observedProfiles.get(expected.profileId), nowMs, evidenceMaxAgeMs);
      if (!evidence) continue;
      state.lastLaunchAtMs = nowMs;
      launches.push({
        ...expected,
        missingForMs: Math.max(0, nowMs - state.missingSinceMs),
        recoveryReason: evidence.reason,
        lifecycleEvent: evidence.event
      });
    }
    return launches;
  }

  function snapshot() {
    return [...missingProfiles.entries()].map(([profileId, state]) => ({ profileId, ...state }));
  }

  return { observe, snapshot };
}
