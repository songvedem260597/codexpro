import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionIdFromManifestKey } from "../electron/extension-runtime-activation.mjs";
import {
  createManagerExtensionRuntimeController,
  createManagerOwnedChromeBinding,
  findChromeProfileBinding
} from "../electron/extension-runtime-manager.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const canonicalRoot = path.join(repoRoot, "chrome-extension");
const chromeForTesting = path.join(os.homedir(), ".codexpro", "chrome-for-testing", "current", "chrome.exe");
const canonicalManifest = JSON.parse(fs.readFileSync(path.join(canonicalRoot, "manifest.json"), "utf8"));
const extensionId = extensionIdFromManifestKey(String(canonicalManifest.key || ""));
const profileId = "bootstrap-persisted-binding-repro";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(process.platform, "win32", "Windows Chrome for Testing is required for this regression");
assert.equal(fs.existsSync(chromeForTesting), true, "Manager Chrome for Testing is missing");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("timeout: " + label);
}

async function devToolsPort(userDataRoot) {
  const portFile = path.join(userDataRoot, "DevToolsActivePort");
  if (!fs.existsSync(portFile)) return 0;
  const port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
  return Number.isInteger(port) && port > 0 ? port : 0;
}

async function closeViaCdp(userDataRoot, child) {
  const port = await devToolsPort(userDataRoot);
  if (port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000)
      });
      const version = response.ok ? await response.json() : {};
      if (version.webSocketDebuggerUrl && typeof WebSocket === "function") {
        await new Promise((resolve) => {
          const socket = new WebSocket(version.webSocketDebuggerUrl);
          const timer = setTimeout(resolve, 2000);
          socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
          socket.addEventListener("close", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.addEventListener("error", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } catch {}
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000)
  ]);
  try { child.kill(); } catch {}
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-bootstrap-persisted-repro-"));
const home = path.join(sandbox, "home");
const stableRoot = path.join(sandbox, "stable-extension");
const sourceUserDataRoot = path.join(sandbox, "source-user-data");
const sourceProfileRoot = path.join(sourceUserDataRoot, "Profile 1");
const sourceStorageRoot = path.join(sourceProfileRoot, "Local Extension Settings", extensionId);

try {
  fs.cpSync(canonicalRoot, stableRoot, { recursive: true });
  fs.mkdirSync(sourceStorageRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceStorageRoot, "000001.log"), Buffer.from(profileId));
  fs.writeFileSync(path.join(sourceProfileRoot, "Secure Preferences"), JSON.stringify({
    extensions: { settings: { [extensionId]: { path: stableRoot } } }
  }));

  const sourceBinding = findChromeProfileBinding({
    profileId,
    extensionId,
    userDataRoots: [sourceUserDataRoot]
  });
  const managedBinding = createManagerOwnedChromeBinding({
    home,
    profileId,
    extensionId,
    sourceBinding
  });
  fs.mkdirSync(managedBinding.profileRoot, { recursive: true });

  const stableChild = spawn(chromeForTesting, [
    `--user-data-dir=${managedBinding.userDataRoot}`,
    "--profile-directory=Default",
    `--load-extension=${stableRoot}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "about:blank"
  ], { stdio: "ignore", windowsHide: true });

  await waitFor(() => {
    const prefs = readJson(managedBinding.securePreferencesPath);
    const configured = String(prefs?.extensions?.settings?.[extensionId]?.path || "");
    return configured && path.resolve(configured) === path.resolve(stableRoot);
  }, 15_000, "stable same-ID persisted entry");
  await closeViaCdp(managedBinding.userDataRoot, stableChild);
  await sleep(750);

  const preferencesPath = path.join(managedBinding.profileRoot, "Preferences");
  const preferences = readJson(preferencesPath) || {};
  preferences.profile = { ...(preferences.profile || {}), exit_type: "Crashed" };
  fs.writeFileSync(preferencesPath, JSON.stringify(preferences));

  const controller = createManagerExtensionRuntimeController({
    home,
    canonicalExtensionRoot: stableRoot,
    runtimeConfig: { root: repoRoot, port: 8793, token: "fixture" },
    mcp: async (toolName, args) => {
      if (toolName === "browser_control" && args?.action === "list_profiles") return { profiles: [] };
      throw new Error("unexpected MCP call during regression: " + toolName);
    },
    userDataRoots: [sourceUserDataRoot],
    activationBrowserExecutable: chromeForTesting,
    allowNonWindows: true
  });

  try {
    await controller.prepareProfile({ profileId });
  } catch (error) {
    const diagnostics = error?.bootstrapDiagnostics || {};
    console.error(JSON.stringify({
      classification:
        error?.code === "EXTENSION_MANAGED_BOOTSTRAP_TIMEOUT" &&
        diagnostics.bootstrap_extension_loaded === true &&
        diagnostics.bootstrap_page_started !== true
          ? "B_BOOTSTRAP_ROOT_BOUND_PAGE_DID_NOT_EXECUTE"
          : "D_OTHER",
      error_code: String(error?.code || ""),
      first_failed_stage: String(diagnostics.first_failed_stage || ""),
      first_failed_error: String(diagnostics.first_failed_error || ""),
      callback_request_count: Number(diagnostics.callback_request_count || 0),
      bootstrap_extension_loaded: diagnostics.bootstrap_extension_loaded === true,
      bootstrap_page_started: diagnostics.bootstrap_page_started === true
    }, null, 2));
    throw error;
  }

  const afterFirst = readJson(preferencesPath);
  assert.equal(afterFirst?.profile?.exit_type, "Normal", "Manager-owned crash exit_type must be normalized before bootstrap");

  await controller.prepareProfile({ profileId });
  const afterSecond = readJson(preferencesPath);
  assert.equal(afterSecond?.profile?.exit_type, "Normal");
  console.log("extension-runtime-bootstrap-persisted-binding-repro: ok (crash-state recovery + two real normalizations)");
} finally {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  } catch (error) {
    console.warn("extension-runtime-bootstrap-persisted-binding-repro: cleanup warning:", error?.code || error?.message || String(error));
  }
}
