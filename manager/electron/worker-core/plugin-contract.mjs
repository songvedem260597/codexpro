const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOCAL_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const WORKER_TYPES = new Set(["browser", "api", "local", "custom"]);
const ACTIVITIES = new Set(["idle", "queued", "working", "settling", "failed", "offline"]);

function clean(value, maxLength = 200) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function normalizeCapabilities(value) {
  const capabilities = Array.isArray(value) ? value : [];
  return [...new Set(capabilities
    .map((item) => clean(item, 64).toLowerCase())
    .filter((item) => CAPABILITY_PATTERN.test(item)))].sort();
}

export function normalizeWorkerPluginManifest(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = clean(source.id, 64).toLowerCase();
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error("Worker plugin id is invalid.");
  const workerType = clean(source.worker_type ?? source.workerType, 32).toLowerCase();
  if (!WORKER_TYPES.has(workerType)) throw new Error(`Worker plugin ${id} has an invalid worker_type.`);
  const name = clean(source.name, 100);
  if (!name) throw new Error(`Worker plugin ${id} must have a name.`);
  const version = clean(source.version, 40);
  if (!version) throw new Error(`Worker plugin ${id} must have a version.`);
  return Object.freeze({
    id,
    name,
    version,
    worker_type: workerType,
    protocol: clean(source.protocol, 80),
    credential_type: clean(source.credential_type ?? source.credentialType, 40),
    capabilities: Object.freeze(normalizeCapabilities(source.capabilities))
  });
}

export function namespacedWorkerId(pluginId, localWorkerId) {
  const normalizedPluginId = clean(pluginId, 64).toLowerCase();
  const normalizedLocalId = clean(localWorkerId, 160);
  if (!PLUGIN_ID_PATTERN.test(normalizedPluginId)) throw new Error("Worker plugin id is invalid.");
  if (!LOCAL_WORKER_ID_PATTERN.test(normalizedLocalId)) throw new Error(`Worker id for plugin ${normalizedPluginId} is invalid.`);
  return `${normalizedPluginId}:${normalizedLocalId}`;
}

export function splitWorkerId(workerId) {
  const normalized = clean(workerId, 240);
  const separator = normalized.indexOf(":");
  if (separator <= 0) throw new Error("Worker id must be namespaced as <plugin>:<worker>.");
  const pluginId = normalized.slice(0, separator).toLowerCase();
  const localWorkerId = normalized.slice(separator + 1);
  namespacedWorkerId(pluginId, localWorkerId);
  return { pluginId, localWorkerId };
}

function normalizeActivity(value, connected) {
  if (!connected) return "offline";
  const activity = clean(value, 32).toLowerCase();
  return ACTIVITIES.has(activity) ? activity : "idle";
}

export function normalizeWorkerSummary(manifest, value) {
  const source = value && typeof value === "object" ? value : {};
  const localWorkerId = clean(source.local_worker_id ?? source.localWorkerId ?? source.worker_id ?? source.workerId, 160);
  const connected = source.connected !== false;
  const capabilities = normalizeCapabilities([
    ...manifest.capabilities,
    ...(Array.isArray(source.capabilities) ? source.capabilities : [])
  ]);
  return {
    worker_id: namespacedWorkerId(manifest.id, localWorkerId),
    local_worker_id: localWorkerId,
    plugin_id: manifest.id,
    plugin_name: manifest.name,
    plugin_version: manifest.version,
    worker_type: manifest.worker_type,
    label: clean(source.label || localWorkerId, 160),
    provider: clean(source.provider || manifest.id, 100),
    model: clean(source.model, 160),
    connected,
    activity: normalizeActivity(source.activity, connected),
    current_task_id: clean(source.current_task_id ?? source.currentTaskId, 160),
    current_task_title: clean(source.current_task_title ?? source.currentTaskTitle, 300),
    current_workspace_root: clean(source.current_workspace_root ?? source.currentWorkspaceRoot, 2048),
    run_id: clean(source.run_id ?? source.runId ?? source.conversation_id ?? source.conversationId, 200),
    last_task_id: clean(source.last_task_id ?? source.lastTaskId, 160),
    last_result: clean(source.last_result ?? source.lastResult, 200_000),
    stream_text: clean(source.stream_text ?? source.streamText, 200_000),
    stream_revision: Math.max(0, Number(source.stream_revision ?? source.streamRevision) || 0),
    stream_phase: clean(source.stream_phase ?? source.streamPhase, 40),
    stream_updated_at: clean(source.stream_updated_at ?? source.streamUpdatedAt, 80),
    stream_tool_status: clean(source.stream_tool_status ?? source.streamToolStatus, 300),
    started_at: clean(source.started_at ?? source.startedAt, 80),
    finished_at: clean(source.finished_at ?? source.finishedAt, 80),
    capabilities,
    last_error: clean(source.last_error ?? source.lastError, 1000),
    browser: source.browser && typeof source.browser === "object" ? source.browser : undefined,
    usage: source.usage && typeof source.usage === "object" ? source.usage : undefined
  };
}

export function assertWorkerPlugin(value) {
  if (!value || typeof value !== "object") throw new Error("Worker plugin must be an object.");
  const manifest = normalizeWorkerPluginManifest(value.manifest);
  if (typeof value.list !== "function") throw new Error(`Worker plugin ${manifest.id} must implement list().`);
  for (const operation of ["send", "read", "stop"]) {
    if (value[operation] !== undefined && typeof value[operation] !== "function") {
      throw new Error(`Worker plugin ${manifest.id} has an invalid ${operation}() operation.`);
    }
  }
  return manifest;
}
