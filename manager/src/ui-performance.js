const browserProfileSignatureCache = new WeakMap();

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

export function sameProjectList(previousProjects, nextProjects) {
  const previous = Array.isArray(previousProjects) ? previousProjects : [];
  const next = Array.isArray(nextProjects) ? nextProjects : [];
  if (previous.length !== next.length) return false;
  return previous.every((project, index) => JSON.stringify(project) === JSON.stringify(next[index]));
}
