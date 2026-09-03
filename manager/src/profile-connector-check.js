const CHECK_TTL_MS = 10 * 60_000;
const RETRY_MS = 60_000;

export function shouldCheckProfileConnector(profile, { now = Date.now(), lastCheck = 0, safe = true } = {}) {
  if (!profile?.connected || !safe || now - lastCheck < RETRY_MS) return false;
  const checkedAt = Date.parse(profile.connector_checked_at || '');
  // Recheck once per Manager session; persisted success is not current proof.
  return !lastCheck || profile.connector_verification_required === true
    || !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt >= CHECK_TTL_MS;
}

export function profileConnectorCardAction(profile, { confirmedMissing = false } = {}) {
  if (profile?.connector_installed && profile?.connector_profile_bound !== false) return "ready";
  if (profile?.connector_update_required === true) return "update";
  if (profile?.connector_verification_state === "disconnected") return "connect";
  if (confirmedMissing && profile?.connector_verification_state === "missing") return "setup";
  return "check";
}
