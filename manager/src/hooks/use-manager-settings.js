import { useCallback, useEffect, useState } from "react";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";
import { DEFAULT_MANAGER_SETTINGS, GLOBAL_RULES_TEMPLATE } from "../manager-settings-model.js";

export function useManagerSettings({ api, notify, setError }) {
  const [managerSettings, setManagerSettings] = useState(DEFAULT_MANAGER_SETTINGS);
  const [chatWidthInput, setChatWidthInput] = useState(String(DEFAULT_MANAGER_SETTINGS.chatWidth));
  const [chatHeightInput, setChatHeightInput] = useState(String(DEFAULT_MANAGER_SETTINGS.chatHeight));
  const [profileCardHeightInput, setProfileCardHeightInput] = useState(String(DEFAULT_MANAGER_SETTINGS.profileCardHeight));
  const [globalRulesDraft, setGlobalRulesDraft] = useState(DEFAULT_MANAGER_SETTINGS.globalRules);
  const [settingsBusy, setSettingsBusy] = useState("");
  const [workerPackDraft, setWorkerPackDraft] = useState("");
  const [showWorkerPackCreator, setShowWorkerPackCreator] = useState(false);
  const [workerPackDeleteArmed, setWorkerPackDeleteArmed] = useState("");

  const applyManagerSettings = useCallback((next) => {
    setManagerSettings({
      ...DEFAULT_MANAGER_SETTINGS,
      ...(next || {}),
      repoSelections: { ...DEFAULT_MANAGER_SETTINGS.repoSelections, ...(next?.repoSelections || {}) },
      workerImages: { ...DEFAULT_MANAGER_SETTINGS.workerImages, ...(next?.workerImages || {}) },
      workerImageDataUrls: { ...DEFAULT_MANAGER_SETTINGS.workerImageDataUrls, ...(next?.workerImageDataUrls || {}) },
      workerImagePacks: Array.isArray(next?.workerImagePacks) ? next.workerImagePacks : []
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getManagerSettings()
      .then((next) => { if (!cancelled) applyManagerSettings(next); })
      .catch((err) => {
        if (!cancelled) {
          logRendererDiagnostic(api, "error", "settings", `Không tải được cài đặt: ${err?.message || String(err)}`, { action: "get-manager-settings", error: err });
          setError(err?.message || String(err));
        }
      });
    return () => { cancelled = true; };
  }, [api, applyManagerSettings, setError]);

  const saveManagerSetting = useCallback(async (patch, message = "Đã lưu cài đặt") => {
    setSettingsBusy("save");
    try {
      applyManagerSettings(await api.saveManagerSettings(patch));
      if (message) notify(message);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, notify, setError]);

  useEffect(() => setChatWidthInput(String(managerSettings.chatWidth)), [managerSettings.chatWidth]);
  useEffect(() => setChatHeightInput(String(managerSettings.chatHeight)), [managerSettings.chatHeight]);
  useEffect(() => setProfileCardHeightInput(String(managerSettings.profileCardHeight)), [managerSettings.profileCardHeight]);
  useEffect(() => setGlobalRulesDraft(managerSettings.globalRules || GLOBAL_RULES_TEMPLATE), [managerSettings.globalRules]);

  const commitChatWidthInput = useCallback(() => {
    const parsed = Number(chatWidthInput);
    const nextWidth = Math.max(720, Math.min(1600, Number.isFinite(parsed) ? Math.round(parsed / 20) * 20 : managerSettings.chatWidth));
    setChatWidthInput(String(nextWidth));
    if (nextWidth !== managerSettings.chatWidth) void saveManagerSetting({ chatWidth: nextWidth }, "Đã lưu độ rộng popup");
  }, [chatWidthInput, managerSettings.chatWidth, saveManagerSetting]);

  const commitChatHeightInput = useCallback(() => {
    const parsed = Number(chatHeightInput);
    const nextHeight = Math.max(180, Math.min(700, Number.isFinite(parsed) ? Math.round(parsed / 10) * 10 : managerSettings.chatHeight));
    setChatHeightInput(String(nextHeight));
    if (nextHeight !== managerSettings.chatHeight) void saveManagerSetting({ chatHeight: nextHeight }, "Đã lưu chiều cao khung chat");
  }, [chatHeightInput, managerSettings.chatHeight, saveManagerSetting]);

  const commitProfileCardHeightInput = useCallback(() => {
    const parsed = Number(profileCardHeightInput);
    const nextHeight = Math.max(390, Math.min(760, Number.isFinite(parsed) ? Math.round(parsed / 10) * 10 : managerSettings.profileCardHeight));
    setProfileCardHeightInput(String(nextHeight));
    if (nextHeight !== managerSettings.profileCardHeight) void saveManagerSetting({ profileCardHeight: nextHeight }, "Đã lưu chiều cao thẻ profile");
  }, [profileCardHeightInput, managerSettings.profileCardHeight, saveManagerSetting]);

  const changeAppBackground = useCallback(async () => {
    setSettingsBusy("background");
    try {
      applyManagerSettings(await api.chooseAppBackground());
      notify("Đã đổi hình nền ứng dụng");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, notify, setError]);

  const restoreAppBackground = useCallback(async () => {
    setSettingsBusy("background");
    try {
      applyManagerSettings(await api.resetAppBackground());
      notify("Đã xóa hình nền ứng dụng");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, notify, setError]);

  const changeWorkerImage = useCallback(async (state) => {
    setSettingsBusy(`worker:${state}`);
    try {
      applyManagerSettings(await api.chooseWorkerImage({ packId: managerSettings.selectedWorkerPackId, state }));
      notify(`Đã đổi ảnh worker ${state}`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, managerSettings.selectedWorkerPackId, notify, setError]);

  const restoreWorkerImage = useCallback(async (state) => {
    setSettingsBusy(`worker:${state}`);
    try {
      applyManagerSettings(await api.resetWorkerImage({ packId: managerSettings.selectedWorkerPackId, state }));
      notify(`Đã khôi phục ảnh worker ${state}`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, managerSettings.selectedWorkerPackId, notify, setError]);

  const createWorkerImagePack = useCallback(async () => {
    const name = workerPackDraft.trim();
    if (!name) return;
    setSettingsBusy("worker-pack:create");
    try {
      applyManagerSettings(await api.createWorkerImagePack(name));
      setWorkerPackDraft("");
      setShowWorkerPackCreator(false);
      setWorkerPackDeleteArmed("");
      notify(`Đã tạo bộ ảnh “${name.slice(0, 60)}”`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, notify, setError, workerPackDraft]);

  const selectWorkerImagePack = useCallback(async (packId) => {
    setSettingsBusy("worker-pack:select");
    try {
      const next = await api.selectWorkerImagePack(packId);
      applyManagerSettings(next);
      setWorkerPackDeleteArmed("");
      const selected = next.workerImagePacks?.find((pack) => pack.id === packId);
      notify(`Đang dùng ${selected ? `bộ “${selected.name}”` : "bộ mặc định"}`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, notify, setError]);

  const deleteWorkerImagePack = useCallback(async () => {
    const pack = managerSettings.workerImagePacks.find((item) => item.id === managerSettings.selectedWorkerPackId);
    if (!pack) return;
    if (workerPackDeleteArmed !== pack.id) {
      setWorkerPackDeleteArmed(pack.id);
      return;
    }
    setSettingsBusy("worker-pack:delete");
    try {
      applyManagerSettings(await api.deleteWorkerImagePack(pack.id));
      setWorkerPackDeleteArmed("");
      notify(`Đã xóa bộ ảnh “${pack.name}”`);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, managerSettings.selectedWorkerPackId, managerSettings.workerImagePacks, notify, setError, workerPackDeleteArmed]);

  const restoreManagerSettings = useCallback(async () => {
    setSettingsBusy("reset");
    try {
      applyManagerSettings(await api.resetManagerSettings());
      notify("Đã khôi phục giao diện mặc định");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSettingsBusy("");
    }
  }, [api, applyManagerSettings, notify, setError]);

  return {
    managerSettings,
    setManagerSettings,
    chatWidthInput,
    setChatWidthInput,
    chatHeightInput,
    setChatHeightInput,
    profileCardHeightInput,
    setProfileCardHeightInput,
    globalRulesDraft,
    setGlobalRulesDraft,
    settingsBusy,
    workerPackDraft,
    setWorkerPackDraft,
    showWorkerPackCreator,
    setShowWorkerPackCreator,
    workerPackDeleteArmed,
    applyManagerSettings,
    saveManagerSetting,
    commitChatWidthInput,
    commitChatHeightInput,
    commitProfileCardHeightInput,
    changeAppBackground,
    restoreAppBackground,
    changeWorkerImage,
    restoreWorkerImage,
    createWorkerImagePack,
    selectWorkerImagePack,
    deleteWorkerImagePack,
    restoreManagerSettings
  };
}
