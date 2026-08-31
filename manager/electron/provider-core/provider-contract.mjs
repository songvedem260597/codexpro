const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_MAX_LENGTH = 240;

function clean(value, maxLength = 200) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function normalizeProviderManifest(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = clean(source.id, 64).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error("Provider id is invalid.");
  const name = clean(source.name, 100);
  if (!name) throw new Error(`Provider ${id} must have a name.`);
  const kind = clean(source.kind, 64).toLowerCase();
  if (!kind) throw new Error(`Provider ${id} must declare a kind.`);
  const capabilities = source.capabilities && typeof source.capabilities === "object"
    ? source.capabilities
    : {};
  return Object.freeze({
    id,
    name,
    kind,
    version: clean(source.version, 40) || "1",
    capabilities: Object.freeze({
      tool_calling: capabilities.tool_calling === true,
      streaming: capabilities.streaming === true,
      model_discovery: capabilities.model_discovery === true,
      cancellation: capabilities.cancellation !== false,
      usage: capabilities.usage !== false
    })
  });
}

export function assertProvider(value) {
  if (!value || typeof value !== "object") throw new Error("Provider must be an object.");
  const manifest = normalizeProviderManifest(value.manifest);
  if (typeof value.complete !== "function") throw new Error(`Provider ${manifest.id} must implement complete().`);
  for (const operation of ["probe", "listModels"]) {
    if (value[operation] !== undefined && typeof value[operation] !== "function") {
      throw new Error(`Provider ${manifest.id} has an invalid ${operation}() operation.`);
    }
  }
  return manifest;
}

export function normalizeModelId(value) {
  const model = clean(value, MODEL_MAX_LENGTH);
  if (!model || /[\u0000-\u001f\u007f]/.test(model)) throw new Error("Provider model id is invalid.");
  return model;
}

export function mcpToolsToProviderTools(tools, limits = {}) {
  const maxTools = Math.max(1, Math.min(Number(limits.maxTools) || 200, 500));
  return (Array.isArray(tools) ? tools : []).slice(0, maxTools).map((tool) => {
    const name = clean(tool?.name, 128);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error("MCP returned an invalid tool name.");
    const description = clean(tool?.description, 4000);
    const parameters = tool?.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : { type: "object", properties: {} };
    return {
      type: "function",
      function: { name, description, parameters }
    };
  });
}

export function normalizeProviderToolCalls(value, limits = {}) {
  const maxCalls = Math.max(1, Math.min(Number(limits.maxCalls) || 32, 100));
  return (Array.isArray(value) ? value : []).slice(0, maxCalls).map((call, index) => {
    const source = call && typeof call === "object" ? call : {};
    const fn = source.function && typeof source.function === "object" ? source.function : source;
    const id = clean(source.id, 160) || `tool_call_${index + 1}`;
    const name = clean(fn.name, 128);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error("Provider returned an invalid tool name.");
    const rawArguments = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    if (rawArguments.length > (Number(limits.maxArgumentsChars) || 100_000)) {
      throw new Error(`Provider tool arguments for ${name} exceeded the configured limit.`);
    }
    let args;
    try {
      args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    } catch {
      throw new Error(`Provider returned invalid JSON arguments for tool ${name}.`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`Provider tool arguments for ${name} must be an object.`);
    }
    return { id, name, arguments: args, raw_arguments: rawArguments };
  });
}
