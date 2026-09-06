import { readFile } from "node:fs/promises";
import path from "node:path";

// Inspect the installed source, not a remote release or an arbitrary worker's version.
export async function availableExtensionVersion(root, fallback, read = readFile) {
  if (!root) return fallback;
  const controller = new AbortController();
  let timer;
  try {
    const content = await Promise.race([
      read(path.join(root, "chrome-extension", "manifest.json"), { encoding: "utf8", signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("manifest timeout")), 500); })
    ]);
    const version = JSON.parse(content).version;
    if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) return fallback;
    return version;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
