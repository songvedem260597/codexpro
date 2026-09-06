export function registerSettingsIpcHandlers({
  diagnosticIpcHandle,
  managerSettingsPayload,
  saveManagerSettingsPatch,
  createWorkerImagePack,
  selectWorkerImagePack,
  deleteWorkerImagePack,
  chooseWorkerImage,
  resetWorkerImage,
  chooseAppBackground,
  resetAppBackground,
  resetManagerSettings
}) {
  if (typeof diagnosticIpcHandle !== "function") throw new Error("Settings IPC registration requires diagnosticIpcHandle.");

  diagnosticIpcHandle("codexpro:get-manager-settings", { category: "settings", action: "get-manager-settings" }, () => managerSettingsPayload());
  diagnosticIpcHandle("codexpro:save-manager-settings", {
    category: "settings",
    action: "save-manager-settings",
    logSuccess: true,
    successMessage: "Lưu cài đặt Manager hoàn tất",
    failureMessage: "Lưu cài đặt Manager thất bại",
    details: (patch) => ({ changed_keys: Object.keys(patch && typeof patch === "object" ? patch : {}).slice(0, 30) })
  }, (_event, patch) => saveManagerSettingsPatch(patch));
  diagnosticIpcHandle("codexpro:create-worker-image-pack", { category: "settings", action: "create-worker-image-pack", failureMessage: "Tạo bộ ảnh worker thất bại" }, (_event, name) => createWorkerImagePack(name));
  diagnosticIpcHandle("codexpro:select-worker-image-pack", { category: "settings", action: "select-worker-image-pack", failureMessage: "Chọn bộ ảnh worker thất bại" }, (_event, packId) => selectWorkerImagePack(packId));
  diagnosticIpcHandle("codexpro:delete-worker-image-pack", { category: "settings", action: "delete-worker-image-pack", failureMessage: "Xóa bộ ảnh worker thất bại" }, (_event, packId) => deleteWorkerImagePack(packId));
  diagnosticIpcHandle("codexpro:choose-worker-image", { category: "settings", action: "choose-worker-image", failureMessage: "Chọn ảnh worker thất bại", details: (payload) => ({ state: String(payload?.state || "") }) }, (_event, payload) => chooseWorkerImage(payload?.packId, payload?.state));
  diagnosticIpcHandle("codexpro:reset-worker-image", { category: "settings", action: "reset-worker-image", failureMessage: "Khôi phục ảnh worker thất bại", details: (payload) => ({ state: String(payload?.state || "") }) }, (_event, payload) => resetWorkerImage(payload?.packId, payload?.state));
  diagnosticIpcHandle("codexpro:choose-app-background", { category: "settings", action: "choose-app-background", failureMessage: "Chọn hình nền thất bại" }, () => chooseAppBackground());
  diagnosticIpcHandle("codexpro:reset-app-background", { category: "settings", action: "reset-app-background", failureMessage: "Xóa hình nền thất bại" }, () => resetAppBackground());
  diagnosticIpcHandle("codexpro:reset-manager-settings", {
    category: "settings",
    action: "reset-manager-settings",
    logSuccess: true,
    successMessage: "Khôi phục cài đặt Manager hoàn tất",
    failureMessage: "Khôi phục cài đặt Manager thất bại"
  }, () => resetManagerSettings());
}
