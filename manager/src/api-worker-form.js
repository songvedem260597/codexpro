const API_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/;

const PROVIDER_TEMPLATES = Object.freeze({
  "9router": Object.freeze({
    id: "9router-main",
    label: "9Router chính",
    provider: "9router",
    base_url: "http://localhost:20128/v1",
    model: "cc/claude-opus-4-6"
  }),
  "openai-compatible": Object.freeze({
    id: "openai-worker",
    label: "OpenAI-compatible",
    provider: "openai-compatible",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4.1-mini"
  })
});

function templateFor(provider) {
  return PROVIDER_TEMPLATES[provider] || PROVIDER_TEMPLATES["9router"];
}

function occupiedIdSet(occupiedIds) {
  return new Set((Array.isArray(occupiedIds) ? occupiedIds : []).map((value) => String(value || "").trim()).filter(Boolean));
}

export function createApiWorkerDraft(provider = "9router", occupiedIds = []) {
  const template = templateFor(provider);
  const occupied = occupiedIdSet(occupiedIds);
  let id = template.id;
  let suffix = 1;
  while (occupied.has(id)) {
    suffix += 1;
    id = `${template.id}-${suffix}`;
  }
  return {
    ...template,
    id,
    label: suffix === 1 ? template.label : `${template.label} ${suffix}`,
    api_key: "",
    enabled: true
  };
}

export function switchApiWorkerProvider(current, provider, occupiedIds = []) {
  const source = current && typeof current === "object" ? current : {};
  const previousTemplate = templateFor(source.provider);
  const nextDraft = createApiWorkerDraft(provider, occupiedIds);
  const replace = (key) => {
    const value = String(source[key] ?? "").trim();
    if (!value || value === previousTemplate[key] || (key === "id" && value.startsWith(`${previousTemplate.id}-`))) return nextDraft[key];
    return source[key];
  };
  return {
    ...source,
    provider: nextDraft.provider,
    id: replace("id"),
    label: replace("label"),
    base_url: replace("base_url"),
    model: replace("model"),
    api_key: String(source.api_key || "")
  };
}

export function validateApiWorkerDraft(draft, options = {}) {
  const source = draft && typeof draft === "object" ? draft : {};
  const id = String(source.id || "").trim();
  const model = String(source.model || "").trim();
  const baseUrl = String(source.base_url || "").trim();
  const apiKey = String(source.api_key || "").trim();
  if (!id) return { valid: false, message: "Nhập ID worker để tiếp tục." };
  if (!API_WORKER_ID_PATTERN.test(id)) return { valid: false, message: "ID chỉ dùng chữ, số, dấu chấm, gạch dưới hoặc gạch ngang." };
  if (!options.editingId && (options.configs || []).some((config) => config.id === id)) return { valid: false, message: "ID worker đã tồn tại. Chọn Sửa hoặc dùng ID khác." };
  if (!model) return { valid: false, message: "Nhập model mà provider hỗ trợ." };
  if (!baseUrl) return { valid: false, message: "Nhập Base URL của API." };
  if (!apiKey && !options.credentialAvailable) return { valid: false, message: "Nhập API key để lưu worker mới." };
  return { valid: true, message: options.credentialAvailable && !apiKey ? "Sẵn sàng lưu và giữ API key hiện tại." : "Sẵn sàng mã hóa API key và lưu worker." };
}
