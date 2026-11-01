export const PROFILE_TTL_MS = 3 * 60_000;
export const PROFILE_RETENTION_MS = 24 * 60 * 60_000;
export const PROFILE_REGISTRY_VERSION = 1;
export function normalizeRecentConversations(value) {
    return (Array.isArray(value) ? value : [])
        .filter((conversation) => conversation && typeof conversation === "object" && !Array.isArray(conversation))
        .map((conversation) => {
        const id = String(conversation.id || "").trim();
        return {
            id,
            title: String(conversation.title || "Đoạn chat chưa có tiêu đề").trim().slice(0, 300),
            url: `https://chatgpt.com/c/${id}`,
            updated_at: Math.max(0, Number(conversation.updated_at) || 0),
            long_task_watchdog_hung: conversation.long_task_watchdog_hung === true,
            long_task_watchdog_attempt_key: String(conversation.long_task_watchdog_attempt_key || "").trim().slice(0, 300)
        };
    })
        .filter((conversation) => /^[A-Za-z0-9-]{8,160}$/.test(String(conversation.id || "")))
        .slice(0, 3);
}
export function browserProfileRetentionState(profile, now = Date.now()) {
    const lastSeen = Math.max(0, Number(profile?.lastSeen) || 0);
    const ageMs = Math.max(0, Number(now) - lastSeen);
    const connected = profile?.restored !== true && ageMs <= PROFILE_TTL_MS;
    const visible = ageMs <= PROFILE_RETENTION_MS;
    const nextTransitionAt = connected
        ? lastSeen + PROFILE_TTL_MS
        : visible
            ? lastSeen + PROFILE_RETENTION_MS
            : null;
    return { connected, visible, nextTransitionAt };
}
export function browserProfilePersistenceSnapshot(profiles, now = Date.now()) {
    const retained = [...profiles]
        .filter((profile) => browserProfileRetentionState(profile, now).visible)
        .map((profile) => ({
        id: String(profile.id || "").slice(0, 160),
        enabled: profile.enabled !== false,
        enabledUpdatedAt: Math.max(0, Number(profile.enabledUpdatedAt) || 0),
        email: String(profile.email || "").slice(0, 320),
        label: String(profile.label || "").slice(0, 320),
        extensionVersion: String(profile.extensionVersion || "").slice(0, 32),
        runtimeBuildId: String(profile.runtimeBuildId || "").slice(0, 120),
        connectorInstalled: profile.connectorInstalled === true,
        connectorMessage: String(profile.connectorMessage || "").slice(0, 500),
        connectorCheckedAt: String(profile.connectorCheckedAt || "").slice(0, 64),
        connectorServerFingerprint: String(profile.connectorServerFingerprint || "").slice(0, 128),
        workspaceRoot: String(profile.workspaceRoot || "").slice(0, 4_096),
        lastSeen: Math.max(0, Number(profile.lastSeen) || 0)
    }))
        .filter((profile) => Boolean(profile.id))
        .slice(0, 100);
    return { version: PROFILE_REGISTRY_VERSION, saved_at: new Date(now).toISOString(), profiles: retained };
}
export function mergeBrowserExtensionStreamBatch(profileId, tabs, streams) {
    const profile = String(profileId || "").trim().slice(0, 160);
    const tabList = Array.isArray(tabs) ? tabs : [];
    const streamList = Array.isArray(streams) ? streams.slice(0, 12) : [];
    const updates = [];
    for (const value of streamList) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            continue;
        const stream = value;
        const tabId = Number(stream.tab_id);
        if (!Number.isInteger(tabId) || tabId < 0)
            continue;
        const tab = tabList.find((candidate) => Number(candidate?.id) === tabId);
        if (!tab)
            continue;
        const recordId = Math.max(0, Number(stream.record_id) || 0);
        const revision = Math.max(0, Number(stream.revision) || 0);
        if (!recordId || !revision)
            continue;
        const currentRecordId = Math.max(0, Number(tab.network_stream_record_id) || 0);
        const currentRevision = Math.max(0, Number(tab.network_stream_revision) || 0);
        if (currentRecordId === recordId && revision <= currentRevision)
            continue;
        tab.network_stream_record_id = recordId;
        tab.network_stream_revision = revision;
        tab.network_stream_text = String(stream.text ?? "").slice(0, 200_000);
        tab.network_stream_event_count = Math.max(0, Number(stream.event_count) || 0);
        tab.network_stream_updated_at = String(stream.updated_at ?? "").slice(0, 64);
        tab.network_stream_in_progress = stream.in_progress === true;
        tab.network_stream_error = String(stream.error ?? "").slice(0, 500);
        tab.network_stream_activity_text = String(stream.activity_text ?? "").trim().slice(0, 220);
        if (stream.in_progress === true) {
            tab.busy = true;
            tab.network_state = "generating";
            tab.busy_source = "network_stream_push";
        }
        else if (String(tab.busy_source || "") === "network_stream_push") {
            tab.busy = false;
            if (tab.network_state === "generating")
                tab.network_state = "completed";
            tab.busy_source = "";
        }
        updates.push({
            profile_id: profile,
            tab_id: tabId,
            conversation_id: String(stream.conversation_id ?? "").slice(0, 180),
            record_id: recordId,
            revision,
            text: String(tab.network_stream_text ?? ""),
            event_count: Number(tab.network_stream_event_count) || 0,
            updated_at: String(tab.network_stream_updated_at ?? ""),
            in_progress: tab.network_stream_in_progress === true,
            error: String(tab.network_stream_error ?? ""),
            activity_text: String(tab.network_stream_activity_text ?? "")
        });
    }
    return { changed: updates.length > 0, updates };
}
//# sourceMappingURL=browserExtensionProfileState.js.map