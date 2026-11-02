const API_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/;

const PROVIDER_TEMPLATES = Object.freeze({
  "9router": Object.freeze({
    id: "9router-main",
    label: "9Router",
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
  }),
  openrouter: Object.freeze({
    id: "openrouter-worker",
    label: "OpenRouter",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "cohere/north-mini-code:free"
  })
});

export const PRESET_WORKER_MODELS = Object.freeze([
  Object.freeze({
    id: "cohere/north-mini-code:free",
    label: "Cohere · North Mini Code (Free)",
    hint: "cohere/north-mini-code:free · Tối ưu code & tool calling",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "NVIDIA · Nemotron 3.5 Lightning (Free)",
    hint: "nvidia/nemotron-3.5-lightning:free · Phản hồi siêu nhanh",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "NVIDIA · Nemotron 3 Ultra 550B (Free)",
    hint: "nvidia/nemotron-3-ultra-550b-a55b:free · Suy luận sâu 550B",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "nvidia/nemotron-3.5-super-vl:free",
    label: "NVIDIA · Nemotron 3.5 Super VL (Free)",
    hint: "nvidia/nemotron-3.5-super-vl:free · Đa phương thức & code",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "NVIDIA · Nemotron 3 Nano Omni 30B (Free)",
    hint: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free · Reasoning 30B",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "dots-studio/dots-3-note-preview:free",
    label: "Dots Studio · Dots 3 Note Preview (Free)",
    hint: "dots-studio/dots-3-note-preview:free · Phân tích & ghi chú",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "qwen/qwen3-coder:free",
    label: "Qwen · Qwen3 Coder (Free)",
    hint: "qwen/qwen3-coder:free · Chuyên gia lập trình",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "deepseek/deepseek-chat-v3-0324:free",
    label: "DeepSeek · V3 0324 (Free)",
    hint: "deepseek/deepseek-chat-v3-0324:free · Đa năng & code",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "deepseek/deepseek-r1:free",
    label: "DeepSeek · R1 Reasoning (Free)",
    hint: "deepseek/deepseek-r1:free · Suy luận từng bước",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "google/gemini-2.5-pro-exp-03-25:free",
    label: "Google · Gemini 2.5 Pro Exp (Free)",
    hint: "google/gemini-2.5-pro-exp-03-25:free · Context lớn",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "mistralai/devstral-small:free",
    label: "Mistral · Devstral Small (Free)",
    hint: "mistralai/devstral-small:free · Agentic coding",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "meta-llama/llama-3.3-70b-instruct:free",
    label: "Meta · Llama 3.3 70B Instruct (Free)",
    hint: "meta-llama/llama-3.3-70b-instruct:free · Ổn định & nhanh",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "openrouter/free",
    label: "OpenRouter · Auto Free Router",
    hint: "openrouter/free · Tự động chọn model free khả dụng",
    provider: "openrouter"
  }),
  Object.freeze({
    id: "cc/claude-opus-4-6",
    label: "Claude Opus 4.6 (9Router)",
    hint: "cc/claude-opus-4-6 · 9Router local endpoint",
    provider: "9router"
  }),
  Object.freeze({
    id: "cc/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 (9Router)",
    hint: "cc/claude-sonnet-4-6 · 9Router local endpoint",
    provider: "9router"
  }),
  Object.freeze({
    id: "gpt-4.1-mini",
    label: "OpenAI · GPT-4.1 Mini",
    hint: "gpt-4.1-mini · OpenAI-compatible",
    provider: "openai-compatible"
  })
]);

export function buildWorkerModelOptions(worker, allWorkers = [], extraModels = [], currentModelOverride = "") {
  const provider = String(worker?.provider || "openrouter").trim().toLowerCase();
  const currentModel = String(currentModelOverride || worker?.model || "").trim();
  const byId = new Map();
  const addOption = (idValue, labelValue, hintValue) => {
    const id = String(idValue || "").trim();
    if (!id || byId.has(id)) return;
    const preset = PRESET_WORKER_MODELS.find((item) => item.id === id);
    const label = String(labelValue || preset?.label || id).trim();
    const hint = String(hintValue || preset?.hint || `${provider || "API"} · ${id}`).trim();
    byId.set(id, {
      value: id,
      label,
      hint,
      mark: "◈",
      searchText: `${id} ${label} ${hint}`
    });
  };

  if (currentModel) {
    const preset = PRESET_WORKER_MODELS.find((item) => item.id === currentModel);
    addOption(
      currentModel,
      preset ? preset.label : currentModel,
      preset ? `${preset.hint} · Đang chọn` : `${provider || "API"} · Model hiện tại của worker`
    );
  }

  if (Array.isArray(worker?.available_models)) {
    for (const modelId of worker.available_models) addOption(modelId);
  }

  for (const item of PRESET_WORKER_MODELS) {
    if (!provider || item.provider === provider || provider === "openrouter") {
      addOption(item.id, item.label, item.hint);
    }
  }

  for (const other of Array.isArray(allWorkers) ? allWorkers : []) {
    if (other?.model) addOption(other.model);
  }

  for (const extra of Array.isArray(extraModels) ? extraModels : []) {
    if (typeof extra === "string") addOption(extra);
    else if (extra?.id) addOption(extra.id, extra.name === extra.id ? undefined : extra.name, extra.context_length ? `${extra.id} · ${Math.round(extra.context_length / 1000)}k context` : undefined);
  }

  for (const item of PRESET_WORKER_MODELS) {
    addOption(item.id, item.label, item.hint);
  }

  return [...byId.values()];
}

export function createCustomWorkerModelOption(query, existingOptions = []) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return null;
  const exists = (Array.isArray(existingOptions) ? existingOptions : []).some(
    (item) => String(item?.value || "").toLowerCase() === cleanQuery.toLowerCase()
  );
  if (exists) return null;
  return {
    key: "__custom_worker_model__",
    value: cleanQuery,
    label: `Dùng model “${cleanQuery}”`,
    hint: "Nhấn Enter hoặc bấm để gán model ID tùy chỉnh cho worker này",
    mark: "＋",
    searchText: cleanQuery,
    customModel: cleanQuery,
    className: "is-create"
  };
}

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

export function normalizeApiWorkerModels(models) {
  const unique = new Map();
  for (const item of Array.isArray(models) ? models : []) {
    const id = String(item?.id || "").trim().slice(0, 240);
    if (!id || unique.has(id)) continue;
    unique.set(id, {
      id,
      name: String(item?.name || id).trim().slice(0, 240) || id,
      context_length: Number(item?.context_length || 0) || undefined
    });
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
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
  if (options.requireModelSelection && !options.modelConfirmed) return { valid: false, message: "Bước 2: tải danh sách rồi chọn model, hoặc chọn nhập thủ công." };
  if (!baseUrl) return { valid: false, message: "Nhập Base URL của API." };
  if (!apiKey && !options.credentialAvailable) return { valid: false, message: "Nhập API key để lưu worker mới." };
  return { valid: true, message: options.credentialAvailable && !apiKey ? "Sẵn sàng lưu và giữ API key hiện tại." : "Sẵn sàng mã hóa API key và lưu worker." };
}
