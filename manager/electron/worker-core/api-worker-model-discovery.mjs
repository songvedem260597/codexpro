const PROVIDERS = new Set(["9router", "openrouter", "openai-compatible"]);

function clean(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export async function discoverApiWorkerModels(payload, options = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const provider = clean(source.provider, 40).toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error("API worker provider is invalid.");
  const id = clean(source.id, 95);
  const inlineCredential = clean(source.api_key || source.apiKey, 20_000);
  const storedCredential = inlineCredential || !id || typeof options.getStoredCredential !== "function"
    ? ""
    : clean(await options.getStoredCredential(id), 20_000);
  const credential = inlineCredential || storedCredential;
  if (!credential) throw new Error("Nhập API key trước khi tải danh sách model.");
  if (typeof options.createProvider !== "function") throw new Error("API worker provider factory is unavailable.");
  const config = {
    id: id || "model-discovery",
    provider,
    base_url: clean(source.base_url || source.baseUrl, 1000),
    model: clean(source.model, 240) || "model-discovery",
    app_name: clean(source.app_name || source.appName, 100),
    app_url: clean(source.app_url || source.appUrl, 500)
  };
  const providerAdapter = await options.createProvider(config, async () => credential);
  if (typeof providerAdapter?.listModels !== "function") throw new Error("Provider không hỗ trợ tải danh sách model.");
  const models = await providerAdapter.listModels();
  const safe = (value, maxLength) => clean(value, maxLength).split(credential).join("[REDACTED]");
  return {
    models: (Array.isArray(models) ? models : []).slice(0, 10_000).map((item) => ({
      id: safe(item?.id, 240),
      name: safe(item?.name || item?.id, 240),
      context_length: Number(item?.context_length || 0) || undefined
    })).filter((item) => item.id)
  };
}
