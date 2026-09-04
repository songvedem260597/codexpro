import React, { useCallback, useEffect, useState } from "react";
import { AppDropdown } from "../../app-dropdown.jsx";
import { createApiWorkerDraft, normalizeApiWorkerModels, switchApiWorkerProvider, validateApiWorkerDraft } from "../../api-worker-form.js";

const api = window.codexpro;

export function ApiWorkerSettings({ onChanged, notify, onError }) {
  const [configs, setConfigs] = useState([]);
  const [draft, setDraft] = useState(() => createApiWorkerDraft());
  const [editingId, setEditingId] = useState("");
  const [models, setModels] = useState([]);
  const [manualModel, setManualModel] = useState(false);
  const [modelConfirmed, setModelConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      const next = await api.listApiWorkers?.() || [];
      setConfigs(next);
      return next;
    }
    catch (error) { onError(error); }
    return [];
  }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const createNew = () => {
    setEditingId("");
    setDraft(createApiWorkerDraft("9router", configs.map((item) => item.id)));
    setModels([]);
    setManualModel(false);
    setModelConfirmed(false);
  };
  const edit = (config) => {
    setEditingId(config.id);
    setDraft({ ...createApiWorkerDraft(config.provider), ...config, api_key: "" });
    setModels([]);
    setManualModel(true);
    setModelConfirmed(true);
  };
  const credentialAvailable = Boolean(editingId && configs.find((item) => item.id === editingId)?.credential_available);
  const validation = validateApiWorkerDraft(draft, { configs, editingId, credentialAvailable, requireModelSelection: true, modelConfirmed });
  const modelDiscoveryReady = Boolean(draft.base_url.trim() && (draft.api_key.trim() || credentialAvailable));
  const changeProvider = (provider) => {
    setDraft((current) => switchApiWorkerProvider(current, provider, configs.map((item) => item.id)));
    setModels([]);
    setManualModel(false);
    setModelConfirmed(false);
  };
  const changeBaseUrl = (value) => {
    update("base_url", value);
    setModels([]);
    setManualModel(false);
    setModelConfirmed(false);
  };
  const discoverModels = async () => {
    if (!modelDiscoveryReady) return;
    setBusy("models");
    try {
      const result = await api.listApiWorkerModels?.(draft);
      const next = normalizeApiWorkerModels(result?.models);
      if (!next.length) throw new Error("Provider không trả về model nào. Bạn có thể chọn nhập model thủ công.");
      setModels(next);
      setManualModel(false);
      setModelConfirmed(false);
      notify(`Đã tải ${next.length} model. Chọn một model ở bước 2.`);
    } catch (error) { onError(error); }
    finally { setBusy(""); }
  };
  const selectModel = (value, option) => {
    if (option?.customModel) {
      update("model", option.customModel);
      setManualModel(true);
      setModelConfirmed(true);
      return;
    }
    if (value === "__manual__") {
      setManualModel(true);
      setModelConfirmed(Boolean(draft.model.trim()));
      return;
    }
    setManualModel(false);
    setModelConfirmed(Boolean(value));
    update("model", value);
  };
  const save = async () => {
    if (!validation.valid) return;
    setBusy("save");
    try {
      await api.saveApiWorker(draft);
      const next = await load();
      setEditingId("");
      setDraft(createApiWorkerDraft("9router", next.map((item) => item.id)));
      setModels([]);
      setManualModel(false);
      setModelConfirmed(false);
      await onChanged?.();
      notify("Đã lưu API worker bằng kho bí mật của hệ điều hành");
    } catch (error) { onError(error); }
    finally { setBusy(""); }
  };
  const test = async (id) => {
    setBusy(`test:${id}`);
    try {
      const result = await api.testApiWorker(id);
      notify(result?.model_available === false ? "API online, model chưa có trong danh sách provider" : "API worker kết nối thành công");
    } catch (error) { onError(error); }
    finally { setBusy(""); }
  };
  const toggleEnabled = async (config) => {
    const nextEnabled = config?.enabled === false;
    setBusy(`toggle:${config.id}`);
    try {
      await api.saveApiWorker({ ...config, enabled: nextEnabled, api_key: "" });
      await load();
      if (editingId === config.id) setDraft((current) => ({ ...current, enabled: nextEnabled }));
      await onChanged?.();
      notify(nextEnabled ? "Đã bật API worker" : "Đã tắt API worker");
    } catch (error) { onError(error); }
    finally { setBusy(""); }
  };
  const remove = async (id) => {
    setBusy(`delete:${id}`);
    try {
      await api.deleteApiWorker(id);
      const next = await load();
      if (editingId === id) {
        setEditingId("");
        setDraft(createApiWorkerDraft("9router", next.map((item) => item.id)));
        setModels([]);
        setManualModel(false);
        setModelConfirmed(false);
      }
      await onChanged?.();
      notify("Đã xóa API worker và credential mã hóa");
    } catch (error) { onError(error); }
    finally { setBusy(""); }
  };
  return (
    <section className="settings-panel api-worker-settings">
      <div className="settings-panel-head">
        <div><p className="eyebrow">API WORKER PLUGINS</p><h2>9Router / API tương thích OpenAI</h2><p className="section-note">API chỉ làm inference. Rule, AGENTS, CodexGraph, workspace và mọi tool luôn đi qua phiên MCP riêng của worker.</p></div>
        <span className="global-rules-badge">MCP-ONLY</span>
      </div>
      <div className="api-worker-form">
        <label><span>ID worker · bắt buộc</span><input value={draft.id} disabled={Boolean(editingId)} placeholder="9router-main" onChange={(event) => update("id", event.target.value)} /></label>
        <label><span>Tên hiển thị</span><input value={draft.label} placeholder="9Router" onChange={(event) => update("label", event.target.value)} /></label>
        <label><span>Bước 1 · Chọn provider</span><AppDropdown className="is-form" value={draft.provider} options={[{ value: "9router", label: "9Router", hint: "OpenAI-compatible tại localhost:20128" }, { value: "openai-compatible", label: "OpenAI-compatible", hint: "Endpoint API tùy chỉnh" }]} onChange={changeProvider} ariaLabel="Chọn API provider" searchable={false} /></label>
        <label><span>Base URL · bắt buộc</span><input value={draft.base_url} placeholder="http://localhost:20128/v1" onChange={(event) => changeBaseUrl(event.target.value)} /></label>
        <label className="api-worker-wide"><span>API key · {credentialAvailable ? "để trống để giữ key hiện tại" : "bắt buộc"}</span><input type="password" autoComplete="new-password" value={draft.api_key} placeholder="Được mã hóa bằng kho bí mật của hệ điều hành" onChange={(event) => update("api_key", event.target.value)} /></label>
        <label className="api-worker-wide"><span>Bước 2 · Chọn model · bắt buộc</span><div className="api-worker-model-picker"><AppDropdown className="is-form" value={manualModel ? "__manual__" : modelConfirmed && models.some((item) => item.id === draft.model) ? draft.model : ""} options={[...models.map((item) => ({ value: item.id, label: item.name === item.id ? item.id : item.name, hint: `${item.name === item.id ? "" : `${item.id} · `}${item.context_length ? `${Math.round(item.context_length / 1000)}k context` : "Provider model"}`, searchText: `${item.id} ${item.name}` })), { value: "__manual__", label: manualModel && draft.model.trim() ? draft.model.trim() : "Nhập model thủ công…", hint: manualModel && draft.model.trim() ? "Model ID nhập thủ công" : "Dùng khi provider không hỗ trợ /models" }]} onChange={selectModel} createOption={(query) => models.some((item) => item.id.toLocaleLowerCase() === query.toLocaleLowerCase()) ? null : { key: "__custom_model__", value: query, label: `Dùng “${query}” làm model ID`, hint: "Nhấn Enter hoặc bấm để chọn model thủ công", searchText: query, customModel: query, className: "is-create" }} ariaLabel="Chọn model từ provider" placeholder={models.length ? "Chọn một model từ provider" : "Tải danh sách model trước"} searchable searchPlaceholder="Tìm hoặc nhập model ID rồi nhấn Enter…" /><button className="button secondary api-worker-load-models" type="button" onClick={() => void discoverModels()} disabled={Boolean(busy) || !modelDiscoveryReady}>{busy === "models" ? "Đang tải…" : "Tải danh sách model"}</button></div>{!modelDiscoveryReady && <small>Nhập API key và kiểm tra Base URL để tải model.</small>}{manualModel && <input value={draft.model} autoFocus placeholder="Nhập model ID" onChange={(event) => { update("model", event.target.value); setModelConfirmed(Boolean(event.target.value.trim())); }} />}</label>
      </div>
      <div className="api-worker-form-actions"><span className={`api-worker-save-status ${validation.valid ? "is-ready" : "is-blocked"}`}>{validation.message}</span><button className="button ghost" type="button" onClick={createNew} disabled={Boolean(busy)}>Tạo mới</button><button className="button primary" type="button" onClick={() => void save()} disabled={Boolean(busy) || !validation.valid}>{busy === "save" ? "Đang mã hóa…" : editingId ? "Lưu thay đổi" : "Lưu worker"}</button></div>
      <div className="api-worker-config-list">
        {!configs.length && <div className="empty">Chưa cấu hình API worker. Feature vẫn tắt cho đến khi có cấu hình và API key.</div>}
        {configs.map((config) => <article key={config.id} className={`api-worker-config ${config.enabled === false ? "is-disabled" : ""}`}><div><strong>{config.label}</strong><code>api:{config.id}</code><small>{config.provider} · {config.model}{config.enabled === false ? " · ĐÃ TẮT" : ""}</small></div><span className={`badge api-worker-key-status ${config.credential_available ? "connected" : "profile-missing"}`}>{config.credential_available ? "KEY ĐÃ MÃ HÓA" : "THIẾU KEY"}</span><div><button className={`button ${config.enabled === false ? "primary" : "ghost"}`} type="button" onClick={() => void toggleEnabled(config)} disabled={Boolean(busy)}>{busy === `toggle:${config.id}` ? "Đang lưu…" : config.enabled === false ? "Bật" : "Tắt"}</button><button className="button ghost" type="button" onClick={() => edit(config)} disabled={Boolean(busy)}>Sửa</button><button className="button secondary" type="button" onClick={() => void test(config.id)} disabled={Boolean(busy) || !config.credential_available}>{busy === `test:${config.id}` ? "Đang test…" : "Test"}</button><button className="button danger-quiet" type="button" onClick={() => void remove(config.id)} disabled={Boolean(busy)}>{busy === `delete:${config.id}` ? "Đang xóa…" : "Xóa"}</button></div></article>)}
      </div>
    </section>
  );
}
