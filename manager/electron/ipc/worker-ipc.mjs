export function registerWorkerIpcHandlers({
  diagnosticIpcHandle,
  runtimeStatus,
  materializeApiWorkerRequest,
  recordUserReportedError,
  workerPluginRegistry,
  apiWorkerStore,
  discoverApiWorkerModels,
  createProviderForApiWorker
}) {
  if (typeof diagnosticIpcHandle !== "function") throw new Error("Worker IPC registration requires diagnosticIpcHandle.");

  diagnosticIpcHandle("codexpro:status", { category: "status", action: "runtime-status", slowMs: 5_000 }, () => runtimeStatus());
  diagnosticIpcHandle("codexpro:workers", { category: "status", action: "list-workers", slowMs: 5_000 }, async () => {
    const status = await runtimeStatus();
    return { workers: status.workers, sources: status.workerSources };
  });
  diagnosticIpcHandle("codexpro:worker-send", {
    category: "worker",
    action: "worker-send",
    logSuccess: true,
    successMessage: "Worker đã nhận job",
    failureMessage: "Không gửi được job tới worker",
    details: (payload) => ({ worker_id: String(payload?.workerId || payload?.worker_id || ""), task_id: String(payload?.task_id || payload?.taskId || ""), task_kind: String(payload?.task_kind || payload?.taskKind || ""), workflow_id: String(payload?.workflow || "") })
  }, async (_event, payload) => {
    const prepared = await materializeApiWorkerRequest(payload);
    recordUserReportedError(prepared, { request_channel: "worker_job" });
    return await workerPluginRegistry.invoke("send", String(prepared?.workerId || prepared?.worker_id || ""), prepared);
  });
  diagnosticIpcHandle("codexpro:worker-read", {
    category: "worker",
    action: "worker-read",
    failureMessage: "Không đọc được trạng thái worker",
    details: (payload) => ({ worker_id: String(payload?.workerId || payload?.worker_id || "") })
  }, (_event, payload) => workerPluginRegistry.invoke("read", String(payload?.workerId || payload?.worker_id || ""), payload));
  diagnosticIpcHandle("codexpro:worker-stop", {
    category: "worker",
    action: "worker-stop",
    logSuccess: true,
    successMessage: "Đã gửi lệnh dừng worker",
    failureMessage: "Không dừng được worker",
    details: (payload) => ({ worker_id: String(payload?.workerId || payload?.worker_id || "") })
  }, (_event, payload) => workerPluginRegistry.invoke("stop", String(payload?.workerId || payload?.worker_id || ""), payload));
  diagnosticIpcHandle("codexpro:api-worker-configs", { category: "settings", action: "list-api-workers" }, () => apiWorkerStore.list());
  diagnosticIpcHandle("codexpro:list-api-worker-models", {
    category: "settings",
    action: "list-api-worker-models",
    slowMs: 15_000,
    logSuccess: true,
    successMessage: "Đã tải danh sách model cho API worker",
    failureMessage: "Không tải được danh sách model",
    details: (payload) => ({ id: String(payload?.id || ""), provider: String(payload?.provider || ""), credential_supplied: Boolean(payload?.api_key || payload?.apiKey) }),
    resultDetails: (result) => ({ model_count: Array.isArray(result?.models) ? result.models.length : 0 })
  }, (_event, payload) => discoverApiWorkerModels(payload, {
    getStoredCredential: async (id) => apiWorkerStore.credential(id),
    createProvider: async (config, getApiKey) => createProviderForApiWorker(config, { getApiKey })
  }));
  diagnosticIpcHandle("codexpro:save-api-worker", {
    category: "settings",
    action: "save-api-worker",
    logSuccess: true,
    successMessage: "Đã lưu API worker",
    failureMessage: "Không lưu được API worker",
    details: (payload) => ({ id: String(payload?.id || ""), provider: String(payload?.provider || ""), model: String(payload?.model || ""), credential_changed: Boolean(payload?.api_key || payload?.apiKey || payload?.clear_credential || payload?.clearCredential) })
  }, (_event, payload) => apiWorkerStore.save(payload));
  diagnosticIpcHandle("codexpro:delete-api-worker", {
    category: "settings",
    action: "delete-api-worker",
    logSuccess: true,
    successMessage: "Đã xóa API worker",
    failureMessage: "Không xóa được API worker",
    details: (id) => ({ id: String(id || "") })
  }, (_event, id) => apiWorkerStore.remove(id));
  diagnosticIpcHandle("codexpro:test-api-worker", {
    category: "settings",
    action: "test-api-worker",
    slowMs: 15_000,
    logSuccess: true,
    successMessage: "API worker kết nối thành công",
    failureMessage: "API worker không kết nối được",
    details: (id) => ({ id: String(id || "") })
  }, async (_event, id) => {
    const config = apiWorkerStore.list().find((item) => item.id === String(id || ""));
    if (!config) throw new Error("API worker configuration was not found.");
    return await createProviderForApiWorker(config).probe();
  });
}
