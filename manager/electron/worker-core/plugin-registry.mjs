import { assertWorkerPlugin, normalizeWorkerSummary, splitWorkerId } from "./plugin-contract.mjs";

function errorSummary(error) {
  return {
    name: String(error?.name || "Error").slice(0, 120),
    message: String(error?.message || error || "Worker plugin failed.").slice(0, 1000)
  };
}

export class WorkerPluginRegistry {
  #plugins = new Map();

  register(plugin) {
    const manifest = assertWorkerPlugin(plugin);
    if (this.#plugins.has(manifest.id)) throw new Error(`Worker plugin ${manifest.id} is already registered.`);
    this.#plugins.set(manifest.id, { plugin, manifest });
    return manifest;
  }

  manifests() {
    return [...this.#plugins.values()].map(({ manifest }) => manifest);
  }

  async list(context = {}) {
    const workers = [];
    const sources = [];
    const seen = new Set();
    await Promise.all([...this.#plugins.values()].map(async ({ plugin, manifest }) => {
      try {
        const listed = await plugin.list(context);
        const normalized = (Array.isArray(listed) ? listed : []).map((worker) => normalizeWorkerSummary(manifest, worker));
        for (const worker of normalized) {
          if (seen.has(worker.worker_id)) throw new Error(`Worker plugin ${manifest.id} returned duplicate worker id ${worker.worker_id}.`);
          seen.add(worker.worker_id);
          workers.push(worker);
        }
        sources.push({ plugin_id: manifest.id, ok: true, count: normalized.length });
      } catch (error) {
        sources.push({ plugin_id: manifest.id, ok: false, count: 0, error: errorSummary(error) });
      }
    }));
    workers.sort((left, right) => left.worker_id.localeCompare(right.worker_id));
    sources.sort((left, right) => left.plugin_id.localeCompare(right.plugin_id));
    return { workers, sources };
  }

  async invoke(operation, workerId, payload = {}) {
    if (!["send", "read", "stop"].includes(operation)) throw new Error(`Unsupported worker operation ${operation}.`);
    const { pluginId, localWorkerId } = splitWorkerId(workerId);
    const entry = this.#plugins.get(pluginId);
    if (!entry) throw new Error(`Worker plugin ${pluginId} is not registered.`);
    const handler = entry.plugin[operation];
    if (typeof handler !== "function") throw new Error(`Worker plugin ${pluginId} does not support ${operation}.`);
    return await handler({ ...payload, worker_id: workerId, local_worker_id: localWorkerId });
  }
}
