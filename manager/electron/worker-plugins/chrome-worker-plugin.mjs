function chromeActivity(profile) {
  if (!profile?.connected) return "offline";
  const tabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
  const working = profile.activity === "working"
    || Number(profile.busy_request_count || 0) > 0
    || tabs.some((tab) => tab?.busy || String(tab?.network_state || "").toLowerCase() === "generating");
  if (working) return "working";
  if (profile.activity === "settling" || tabs.some((tab) => tab?.settling)) return "settling";
  const failed = profile.renderer_unresponsive
    || tabs.some((tab) => tab?.renderer_unresponsive || tab?.connection_interrupted || tab?.message_delivery_timed_out);
  return failed ? "failed" : "idle";
}

function chromeCapabilities(profile) {
  if (!profile?.connected) return [];
  return [
    "send",
    "read",
    "stop",
    "open-browser",
    "recover-browser",
    "reload-extension",
    "setup-connector"
  ];
}

export function createChromeWorkerPlugin(operations = {}) {
  return {
    manifest: {
      id: "chrome",
      name: "Chrome Worker",
      version: "1",
      worker_type: "browser",
      protocol: "codexpro-browser-bridge",
      capabilities: ["browser-profile"]
    },

    async list(context = {}) {
      const profiles = Array.isArray(context.browserProfiles)
        ? context.browserProfiles
        : typeof operations.listProfiles === "function"
          ? await operations.listProfiles(context)
          : [];
      return profiles.map((profile) => ({
        local_worker_id: String(profile?.profile_id || ""),
        label: profile?.label || profile?.email || profile?.profile_id,
        provider: "chatgpt",
        connected: Boolean(profile?.connected),
        activity: chromeActivity(profile),
        current_task_id: profile?.current_task_id,
        current_task_title: profile?.current_task_title,
        current_workspace_root: profile?.current_workspace_root,
        run_id: profile?.active_conversation_id,
        capabilities: chromeCapabilities(profile),
        last_error: profile?.renderer_error || profile?.network_error || "",
        browser: profile
      }));
    },

    async send(payload) {
      if (typeof operations.sendRequest !== "function") throw new Error("Chrome worker send is unavailable.");
      return await operations.sendRequest({ ...payload, profileId: payload.local_worker_id });
    },

    async read(payload) {
      if (typeof operations.readResponse !== "function") throw new Error("Chrome worker read is unavailable.");
      return await operations.readResponse({ ...payload, profileId: payload.local_worker_id });
    },

    async stop(payload) {
      if (typeof operations.stopTask !== "function") throw new Error("Chrome worker stop is unavailable.");
      return await operations.stopTask({ ...payload, profileId: payload.local_worker_id });
    }
  };
}
