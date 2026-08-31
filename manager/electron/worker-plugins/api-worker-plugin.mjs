import { runMcpAgentJob } from "../worker-core/mcp-agent-loop.mjs";

function clean(value, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function localWorkerId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/.test(id)) throw new Error("API worker configuration id is invalid.");
  return id;
}

function visibleDeltaText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (value.type && value.type !== "text") return "";
  return String(value.text ?? value.delta ?? "");
}

function publicRun(state) {
  if (!state) return undefined;
  return {
    job_id: state.jobId,
    task_title: state.title,
    last_request: state.request,
    activity: state.activity,
    started_at: state.startedAt,
    finished_at: state.finishedAt,
    result: state.result,
    error: state.error,
    stream_text: state.streamText,
    stream_revision: state.streamRevision,
    stream_phase: state.streamPhase,
    stream_updated_at: state.streamUpdatedAt,
    stream_tool_status: state.streamToolStatus,
    events: state.events.slice(-50)
  };
}

export function createApiWorkerPlugin(options = {}) {
  const runs = new Map();
  const publish = (workerConfigId, state) => {
    if (runs.get(workerConfigId) !== state) return;
    try {
      options.onUpdate?.({ local_worker_id: workerConfigId, ...publicRun(state) });
    } catch {
      // A renderer update is advisory and must never fail the worker job.
    }
  };
  const updateStream = (workerConfigId, state, patch = {}) => {
    if (runs.get(workerConfigId) !== state || state.activity !== "working") return false;
    Object.assign(state, patch);
    state.streamRevision += 1;
    state.streamUpdatedAt = new Date().toISOString();
    publish(workerConfigId, state);
    return true;
  };
  const getConfigurations = typeof options.listConfigurations === "function"
    ? options.listConfigurations
    : async () => Array.isArray(options.configurations) ? options.configurations : [];

  async function configuration(workerConfigId) {
    workerConfigId = localWorkerId(workerConfigId);
    const configs = await getConfigurations();
    const config = configs.find((item) => String(item?.id || "") === workerConfigId && item?.enabled !== false);
    if (!config) throw new Error(`API worker ${workerConfigId} is not configured.`);
    return config;
  }

  return {
    manifest: {
      id: "api",
      name: "API Workers",
      version: "1",
      worker_type: "api",
      protocol: "codexpro-mcp-agent-v1",
      credential_type: "secret-reference",
      capabilities: ["send", "read", "stop", "mcp-tools", "job-policy"]
    },

    async list() {
      const configs = await getConfigurations();
      return configs.filter((config) => config?.enabled !== false).map((config) => {
        const id = localWorkerId(config?.id);
        const run = runs.get(id);
        return {
          local_worker_id: id,
          label: clean(config?.label || id, 160),
          provider: clean(config?.provider || "openai-compatible", 100),
          model: clean(config?.model, 240),
          connected: config?.credential_available !== false,
          activity: run?.activity || "idle",
          current_task_id: run?.activity === "working" ? run.jobId : "",
          current_task_title: run?.activity === "working" ? run.title : "",
          last_task_title: run?.title || "",
          current_workspace_root: run?.activity === "working" ? run.root : "",
          run_id: run?.jobId || "",
          last_task_id: run?.jobId || "",
          last_result: run?.result?.text || "",
          stream_text: run?.streamText || "",
          stream_revision: run?.streamRevision || 0,
          stream_phase: run?.streamPhase || "idle",
          stream_updated_at: run?.streamUpdatedAt || "",
          stream_tool_status: run?.streamToolStatus || "",
          started_at: run?.startedAt || "",
          finished_at: run?.finishedAt || "",
          capabilities: ["send", "read", "stop", "tool-calling"],
          last_error: run?.error || "",
          usage: run?.result?.usage
        };
      });
    },

    async send(payload) {
      const workerConfigId = localWorkerId(payload.local_worker_id);
      const config = await configuration(workerConfigId);
      const existing = runs.get(workerConfigId);
      if (existing?.activity === "working") throw new Error(`API worker ${workerConfigId} is already running a job.`);
      if (typeof options.createProvider !== "function" || typeof options.createMcpClients !== "function") {
        throw new Error("API worker runtime dependencies are unavailable.");
      }
      const controller = new AbortController();
      const scope = payload.scope === "all_allowed" ? "all_allowed" : "workspace";
      const root = clean(payload.root, 2048);
      const sameWorkspace = Boolean(existing?.scope === scope && (scope === "all_allowed" || (existing?.root && root && existing.root.toLowerCase() === root.toLowerCase())));
      const history = sameWorkspace && Array.isArray(existing?.history) ? existing.history.slice(-12) : [];
      const attachmentNames = Array.isArray(payload.attachment_names) ? payload.attachment_names.map((name) => clean(name, 260)).filter(Boolean) : [];
      const request = clean(payload.text || payload.request, 12_000) || `Đã gửi ${attachmentNames.length} file: ${attachmentNames.join(", ")}`;
      const state = {
        jobId: clean(payload.task_id || payload.taskId, 40),
        title: "",
        scope,
        root,
        request,
        history,
        activity: "working",
        startedAt: new Date().toISOString(),
        finishedAt: "",
        result: undefined,
        error: "",
        streamText: "",
        streamRevision: 0,
        streamPhase: "preparing",
        streamUpdatedAt: new Date().toISOString(),
        streamToolStatus: "",
        events: [],
        controller
      };
      runs.set(workerConfigId, state);
      publish(workerConfigId, state);
      const workerId = `api:${workerConfigId}`;
      let clients;
      let provider;
      try {
        clients = await options.createMcpClients({ workerId, config, payload });
        provider = await options.createProvider({ config, payload });
      } catch (error) {
        state.error = clean(error?.message || error, 1000);
        state.activity = "failed";
        state.streamPhase = "error";
        state.streamRevision += 1;
        state.streamUpdatedAt = new Date().toISOString();
        state.finishedAt = new Date().toISOString();
        publish(workerConfigId, state);
        await Promise.allSettled([clients?.jobMcp?.close?.(), clients?.controlMcp?.close?.()]);
        throw error;
      }
      state.promise = runMcpAgentJob({
        provider,
        controlMcp: clients.controlMcp,
        jobMcp: clients.jobMcp,
        job: {
          id: state.jobId,
          workerId,
          kind: payload.task_kind || payload.taskKind,
          scope,
          root: state.root,
          workspaceCandidates: payload.workspaceCandidates || payload.workspace_candidates
        },
        request: payload.text || payload.request,
        messages: [...history, ...(Array.isArray(payload.messages) ? payload.messages : [])],
        limits: payload.limits,
        signal: controller.signal,
        onPhase: (phase, details = {}) => updateStream(workerConfigId, state, {
          streamPhase: clean(phase, 40) || "working",
          streamToolStatus: phase === "tool" ? clean((details.names || []).join(", "), 300) : ""
        }),
        onVisibleTurnStart: () => updateStream(workerConfigId, state, {
          streamText: "",
          streamPhase: "streaming",
          streamToolStatus: ""
        }),
        onVisibleDelta: (delta) => {
          const text = visibleDeltaText(delta);
          if (!text) return;
          updateStream(workerConfigId, state, {
            streamText: `${state.streamText}${text}`,
            streamPhase: "streaming",
            streamToolStatus: ""
          });
        },
        onTaskTitle: (title, bootstrap) => {
          state.title = clean(title, 56);
          state.root = clean(bootstrap?.root || state.root, 2048);
        },
        onEvent: (event) => state.events.push(event)
      }).then((result) => {
        state.title = clean(result?.task_title || state.title, 56);
        state.result = result;
        state.history = [...history, { role: "user", content: request }, { role: "assistant", content: clean(result?.text, 20_000) }].slice(-12);
        state.activity = "idle";
        state.streamText = String(result?.text || "");
        state.streamPhase = "complete";
        state.streamToolStatus = "";
        state.streamRevision += 1;
        state.streamUpdatedAt = new Date().toISOString();
        state.finishedAt = new Date().toISOString();
        publish(workerConfigId, state);
        return result;
      }).catch((error) => {
        state.error = clean(error?.message || error, 1000);
        state.activity = controller.signal.aborted ? "idle" : "failed";
        state.streamPhase = controller.signal.aborted ? "cancelled" : "error";
        state.streamRevision += 1;
        state.streamUpdatedAt = new Date().toISOString();
        state.finishedAt = new Date().toISOString();
        publish(workerConfigId, state);
      }).finally(async () => {
        await Promise.allSettled([clients.jobMcp?.close?.(), clients.controlMcp?.close?.()]);
      });
      return { accepted: true, worker_id: workerId, job_id: state.jobId };
    },

    async read(payload) {
      return publicRun(runs.get(localWorkerId(payload.local_worker_id))) || { activity: "idle" };
    },

    async stop(payload) {
      const state = runs.get(localWorkerId(payload.local_worker_id));
      if (!state || state.activity !== "working") return { stopped: false, reason: "not_running" };
      state.controller.abort(new Error("API worker job cancelled."));
      await state.promise;
      return { stopped: true, job_id: state.jobId };
    }
  };
}
