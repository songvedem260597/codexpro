import { useCallback, useEffect, useRef } from "react";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";
import { applyConversationTitleOverrides } from "../features/chat/chat-conversation-utils.js";
import { extensionReady, profileSafeForWorkerUpdate } from "../features/profiles/profile-runtime-utils.js";
import { isNetworkStreamCurrentGeneration, mergeNetworkStreamTranscript } from "../chat-transcript.js";
import { mergeRuntimeStatus, normalizeTerminalMessageStreamProfiles, sameProjectList, stabilizeEmptyBrowserProfileSnapshot } from "../ui-performance.js";
import { pruneTimestampMap } from "../performance-retention.js";

const PROFILE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_CHECK_RETRY_MS = 30 * 60 * 1000;
const CONNECTOR_AUTO_MIGRATION_RETRY_MS = 5 * 60 * 1000;
const REALTIME_WATCHDOG_MS = 30000;
const PROJECT_REFRESH_MS = 5 * 60 * 1000;

export function useRuntimeStatus({
  api,
  status,
  setStatus,
  setProjects,
  busy,
  setBusy,
  setError,
  conversationTitleOverridesRef,
  requestTargetsRef,
  setRequestResponses,
  networkStreamPushTimes,
  checkingProfiles,
  setCheckingProfiles,
  setAutoMigratingProfileId
}) {
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const refreshForegroundQueued = useRef(false);
  const projectRefreshInFlight = useRef(false);
  const statusRefreshInFlight = useRef(false);
  const emptyBrowserSnapshotSince = useRef(0);
  const emptyBrowserSnapshotTimer = useRef(0);
  const refreshStatusRef = useRef(null);
  const profileCheckTimes = useRef(new Map());
  const profileChecksInFlight = useRef(new Set());
  const connectorAutoMigrationAttempts = useRef(new Map());
  const connectorAutoMigrationInFlight = useRef("");
  const pendingBrowserStreamUpdates = useRef(new Map());
  const browserStreamFrame = useRef(0);

  const mergeStatus = useCallback((current, nextStatus) => {
    const merged = mergeRuntimeStatus(current, nextStatus);
    if (!current || nextStatus?.workerSnapshotAvailable === false || nextStatus?.local?.ok === false) {
      return applyConversationTitleOverrides(merged, conversationTitleOverridesRef.current);
    }
    const stabilized = stabilizeEmptyBrowserProfileSnapshot(current.browserProfiles, merged.browserProfiles, { emptySinceMs: emptyBrowserSnapshotSince.current });
    const firstTransientEmpty = stabilized.preserved && !emptyBrowserSnapshotSince.current;
    emptyBrowserSnapshotSince.current = stabilized.emptySinceMs;
    if (stabilized.preserved) {
      if (firstTransientEmpty) logRendererDiagnostic(api, "warn", "status", "Snapshot worker tạm thời rỗng; giữ dữ liệu gần nhất để xác minh", { action: "worker-empty-snapshot-grace", retry_after_ms: stabilized.retryAfterMs });
      if (!emptyBrowserSnapshotTimer.current) emptyBrowserSnapshotTimer.current = window.setTimeout(() => {
        emptyBrowserSnapshotTimer.current = 0;
        void refreshStatusRef.current?.();
      }, stabilized.retryAfterMs);
      return applyConversationTitleOverrides({
        ...merged,
        browserProfiles: stabilized.profiles,
        workers: current.workers || merged.workers,
        workerSources: current.workerSources || merged.workerSources,
        workerSnapshotStale: true,
        workerSnapshotStaleReason: "empty-grace",
        workerSnapshotStaleSince: current.workerSnapshotStaleReason === "empty-grace" ? current.workerSnapshotStaleSince : (nextStatus.checkedAt || new Date().toISOString())
      }, conversationTitleOverridesRef.current);
    }
    if (emptyBrowserSnapshotTimer.current) window.clearTimeout(emptyBrowserSnapshotTimer.current);
    emptyBrowserSnapshotTimer.current = 0;
    return applyConversationTitleOverrides({ ...merged, browserProfiles: stabilized.profiles, workerSnapshotStaleReason: "" }, conversationTitleOverridesRef.current);
  }, [api, conversationTitleOverridesRef]);

  const refresh = useCallback(async (foreground = false) => {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      refreshForegroundQueued.current = refreshForegroundQueued.current || foreground;
      return;
    }
    refreshInFlight.current = true;
    if (foreground) setBusy("refresh");
    setError("");
    try {
      const nextStatus = await api.getStatus();
      setStatus((current) => mergeStatus(current, nextStatus));
      if (foreground) {
        const nextProjects = await api.listProjects();
        setProjects((current) => sameProjectList(current, nextProjects) ? current : nextProjects);
      }
    } catch (err) {
      logRendererDiagnostic(api, "error", "status", `Không làm mới Manager: ${err?.message || String(err)}`, { action: "refresh", error: err });
      setError(err?.message || String(err));
    } finally {
      refreshInFlight.current = false;
      if (foreground) setBusy("");
      if (refreshQueued.current) {
        const queuedForeground = refreshForegroundQueued.current;
        refreshQueued.current = false;
        refreshForegroundQueued.current = false;
        void refresh(queuedForeground);
      }
    }
  }, [api, mergeStatus, setBusy, setError, setProjects, setStatus]);

  const refreshStatus = useCallback(async () => {
    if (statusRefreshInFlight.current || refreshInFlight.current) return;
    statusRefreshInFlight.current = true;
    try {
      const nextStatus = await api.getStatus();
      setStatus((current) => mergeStatus(current, nextStatus));
    } catch (err) {
      logRendererDiagnostic(api, "warn", "status", `Background status refresh lỗi: ${err?.message || String(err)}`, { action: "refresh-status", error: err });
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, [api, mergeStatus, setStatus]);
  refreshStatusRef.current = refreshStatus;

  const refreshProjects = useCallback(async () => {
    if (projectRefreshInFlight.current || refreshInFlight.current) return;
    projectRefreshInFlight.current = true;
    try {
      const nextProjects = await api.listProjects();
      setProjects((current) => sameProjectList(current, nextProjects) ? current : nextProjects);
    } catch (err) {
      logRendererDiagnostic(api, "warn", "projects", `Background project refresh lỗi: ${err?.message || String(err)}`, { action: "refresh-projects", error: err });
    } finally {
      projectRefreshInFlight.current = false;
    }
  }, [api, setProjects]);

  useEffect(() => {
    void refresh(true);
    const unsubscribeProfiles = api.onBrowserProfiles?.((payload) => {
      const incomingProfiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
      setStatus((current) => {
        if (!current) return current;
        const profiles = normalizeTerminalMessageStreamProfiles(incomingProfiles, current.workerJobs);
        const stabilized = stabilizeEmptyBrowserProfileSnapshot(current.browserProfiles, profiles, {
          emptySinceMs: emptyBrowserSnapshotSince.current,
          removedProfileIds: payload?.disabled_profile_ids
        });
        const firstTransientEmpty = stabilized.preserved && !emptyBrowserSnapshotSince.current;
        emptyBrowserSnapshotSince.current = stabilized.emptySinceMs;
        if (stabilized.preserved && firstTransientEmpty) logRendererDiagnostic(api, "warn", "status", "Luồng realtime trả danh sách worker rỗng; giữ dữ liệu gần nhất để xác minh", { action: "worker-empty-snapshot-grace", retry_after_ms: stabilized.retryAfterMs });
        if (stabilized.preserved && !emptyBrowserSnapshotTimer.current) emptyBrowserSnapshotTimer.current = window.setTimeout(() => {
          emptyBrowserSnapshotTimer.current = 0;
          void refreshStatusRef.current?.();
        }, stabilized.retryAfterMs);
        if (!stabilized.preserved && emptyBrowserSnapshotTimer.current) window.clearTimeout(emptyBrowserSnapshotTimer.current);
        if (!stabilized.preserved) emptyBrowserSnapshotTimer.current = 0;
        const browserProfiles = stabilized.profiles;
        const clearedEmptyGrace = !stabilized.preserved && current.workerSnapshotStaleReason === "empty-grace";
        if (browserProfiles === current.browserProfiles && !clearedEmptyGrace) return current;
        return applyConversationTitleOverrides({
          ...current,
          checkedAt: payload?.checked_at || new Date().toISOString(),
          browserProfiles,
          workerSnapshotStale: stabilized.preserved,
          workerSnapshotStaleReason: stabilized.preserved ? "empty-grace" : "",
          workerSnapshotStaleSince: stabilized.preserved ? (current.workerSnapshotStaleSince || payload?.checked_at || new Date().toISOString()) : ""
        }, conversationTitleOverridesRef.current);
      });
    });
    const unsubscribeBrowserStream = api.onBrowserStream?.((payload) => {
      for (const update of Array.isArray(payload?.updates) ? payload.updates : []) {
        const profileId = String(update?.profile_id || "");
        const conversationId = String(update?.conversation_id || "");
        if (!profileId || !conversationId) continue;
        pendingBrowserStreamUpdates.current.set(`${profileId}:${conversationId}`, update);
      }
      if (browserStreamFrame.current || !pendingBrowserStreamUpdates.current.size) return;
      browserStreamFrame.current = window.requestAnimationFrame(() => {
        browserStreamFrame.current = 0;
        const updates = [...pendingBrowserStreamUpdates.current.values()];
        pendingBrowserStreamUpdates.current.clear();
        setRequestResponses((current) => {
          let next = current;
          for (const update of updates) {
            const profileId = String(update?.profile_id || "");
            const conversationId = String(update?.conversation_id || "");
            const selectedTarget = String(requestTargetsRef.current[profileId] || "");
            if (!profileId || !conversationId || (selectedTarget && selectedTarget !== conversationId)) continue;
            const previous = next[profileId] || {};
            if (previous.conversationId && previous.conversationId !== conversationId) continue;
            const recordId = Math.max(0, Number(update?.record_id) || 0);
            const revision = Math.max(0, Number(update?.revision) || 0);
            const previousRecordId = Math.max(0, Number(previous.networkStreamPushRecordId) || 0);
            const previousRevision = Math.max(0, Number(previous.networkStreamPushRevision) || 0);
            if (previousRecordId === recordId && revision <= previousRevision) continue;
            const streamUpdatedAt = String(update?.updated_at || "");
            if (!isNetworkStreamCurrentGeneration({ networkStartedAt: previous.networkStartedAt, streamUpdatedAt })) continue;
            const streamText = String(update?.text || "");
            const messages = streamText
              ? mergeNetworkStreamTranscript(previous.messages || [], { conversationId, text: streamText, truncated: false })
              : previous.messages || [];
            networkStreamPushTimes.current.set(`${profileId}:${conversationId}`, Date.now());
            if (next === current) next = { ...current };
            next[profileId] = {
              ...previous,
              visible: true,
              conversationId,
              messages,
              text: streamText || previous.text || "",
              busy: update?.in_progress === true,
              loading: false,
              networkStreamAvailable: Boolean(streamText || update?.activity_text || previous.networkStreamAvailable),
              networkStreamInProgress: update?.in_progress === true,
              networkStreamUpdatedAt: streamUpdatedAt,
              networkStreamEventCount: Math.max(0, Number(update?.event_count) || 0),
              networkStreamError: String(update?.error || ""),
              networkStreamActivityText: String(update?.activity_text || ""),
              networkStreamPushRecordId: recordId,
              networkStreamPushRevision: revision,
              incomplete: update?.in_progress === true,
              incompleteReason: update?.in_progress === true ? "network_stream_in_progress" : "",
              contentNeedsRefresh: false,
              updatedAt: streamUpdatedAt || previous.updatedAt
            };
          }
          return next;
        });
      });
    });
    const unsubscribeWorkers = api.onWorkerUpdate?.((payload) => {
      const workerId = String(payload?.worker_id || "");
      if (!workerId) return;
      setStatus((current) => {
        if (!current || !Array.isArray(current.workers)) return current;
        const index = current.workers.findIndex((worker) => worker.worker_id === workerId);
        if (index < 0) return current;
        const workers = current.workers.slice();
        workers[index] = { ...workers[index], ...payload };
        return { ...current, workers };
      });
    });
    const statusTimer = window.setInterval(() => void refreshStatus(), REALTIME_WATCHDOG_MS);
    const projectsTimer = window.setInterval(() => void refreshProjects(), PROJECT_REFRESH_MS);
    return () => {
      unsubscribeProfiles?.();
      unsubscribeBrowserStream?.();
      unsubscribeWorkers?.();
      if (browserStreamFrame.current) window.cancelAnimationFrame(browserStreamFrame.current);
      browserStreamFrame.current = 0;
      pendingBrowserStreamUpdates.current.clear();
      window.clearInterval(statusTimer);
      window.clearInterval(projectsTimer);
      if (emptyBrowserSnapshotTimer.current) window.clearTimeout(emptyBrowserSnapshotTimer.current);
      emptyBrowserSnapshotTimer.current = 0;
    };
  }, [api, conversationTitleOverridesRef, networkStreamPushTimes, refresh, refreshProjects, refreshStatus, requestTargetsRef, setRequestResponses, setStatus]);

  useEffect(() => {
    const profiles = status?.browserProfiles || [];
    for (const profile of profiles) {
      const lastCheck = profileCheckTimes.current.get(profile.profile_id) || 0;
      const checkedAt = Date.parse(profile.connector_checked_at || "");
      const recentlyVerified = Number.isFinite(checkedAt) && Date.now() - checkedAt < PROFILE_CHECK_TTL_MS;
      if (!profile.connected || !extensionReady(profile.extension_version) || recentlyVerified || Date.now() - lastCheck < PROFILE_CHECK_RETRY_MS) continue;
      profileCheckTimes.current.set(profile.profile_id, Date.now());
      profileChecksInFlight.current.add(profile.profile_id);
      setCheckingProfiles((current) => [...new Set([...current, profile.profile_id])]);
      void api.checkProfile(profile.profile_id)
        .catch((err) => {
          logRendererDiagnostic(api, "warn", "profile", `Kiểm tra profile ${profile.profile_id} lỗi: ${err?.message || String(err)}`, { action: "check-profile", profile_id: profile.profile_id, error: err });
          return null;
        })
        .finally(() => {
          profileChecksInFlight.current.delete(profile.profile_id);
          setCheckingProfiles((current) => current.filter((id) => id !== profile.profile_id));
          window.setTimeout(() => void refresh(false), 1200);
        });
    }
  }, [api, refresh, setCheckingProfiles, status?.browserProfiles]);

  useEffect(() => {
    if (busy || connectorAutoMigrationInFlight.current) return;
    const now = Date.now();
    const candidate = (status?.browserProfiles || []).find((profile) => {
      if (!profile?.connected || profile.connector_update_required !== true || !extensionReady(profile.extension_version)) return false;
      if (!profileSafeForWorkerUpdate(profile) || profileChecksInFlight.current.has(profile.profile_id) || checkingProfiles.includes(profile.profile_id)) return false;
      const lastAttempt = connectorAutoMigrationAttempts.current.get(profile.profile_id) || 0;
      return now - lastAttempt >= CONNECTOR_AUTO_MIGRATION_RETRY_MS;
    });
    if (!candidate) return;

    const profileId = candidate.profile_id;
    connectorAutoMigrationInFlight.current = profileId;
    connectorAutoMigrationAttempts.current.set(profileId, now);
    setAutoMigratingProfileId(profileId);
    logRendererDiagnostic(api, "info", "profile", `Tự cập nhật connector ${profileId}`, { action: "auto-migrate-profile-connector", profile_id: profileId });
    void api.setupProfile(profileId)
      .then((result) => {
        logRendererDiagnostic(api, "info", "profile", `Tự cập nhật connector ${profileId} hoàn tất`, {
          action: "auto-migrate-profile-connector-success",
          profile_id: profileId,
          connector_profile_bound: result?.connector_profile_bound,
          connector_installed: result?.connector_installed
        });
      })
      .catch((err) => {
        logRendererDiagnostic(api, "warn", "profile", `Tự cập nhật connector ${profileId} lỗi: ${err?.message || String(err)}`, { action: "auto-migrate-profile-connector-error", profile_id: profileId, error: err });
      })
      .finally(() => {
        connectorAutoMigrationAttempts.current.set(profileId, Date.now());
        if (connectorAutoMigrationInFlight.current === profileId) connectorAutoMigrationInFlight.current = "";
        setAutoMigratingProfileId((current) => current === profileId ? "" : current);
        window.setTimeout(() => void refresh(false), 1200);
      });
  }, [api, busy, checkingProfiles, refresh, setAutoMigratingProfileId, status?.browserProfiles]);

  useEffect(() => {
    const sweep = () => {
      pruneTimestampMap(profileCheckTimes.current, { maxEntries: 96, maxAgeMs: 60 * 60_000 });
      pruneTimestampMap(connectorAutoMigrationAttempts.current, { maxEntries: 96, maxAgeMs: 60 * 60_000 });
    };
    sweep();
    const timer = window.setInterval(sweep, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return { refresh, refreshStatus, refreshProjects };
}
