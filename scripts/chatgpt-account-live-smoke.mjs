import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = process.env.CODEXPRO_HOME
  ? path.resolve(process.env.CODEXPRO_HOME)
  : path.join(os.homedir(), ".codexpro");
const token = (await readFile(path.join(home, "http-token"), "utf8")).trim();

async function runtimeCandidates() {
  const found = [];
  try {
    const runtimeDir = path.join(home, "runtime");
    const names = (await readdir(runtimeDir)).filter((name) => name.endsWith(".json"));
    for (const name of names) {
      try {
        const record = JSON.parse(await readFile(path.join(runtimeDir, name), "utf8"));
        const updatedAt = Date.parse(String(record.updatedAt || "")) || 0;
        if (record.localBase) found.push({ base: String(record.localBase).replace(/\/$/, ""), updatedAt });
        else if (record.localStatusUrl) {
          const url = new URL(String(record.localStatusUrl));
          found.push({ base: url.origin, updatedAt });
        }
      } catch {}
    }
  } catch {}
  found.push({ base: "http://127.0.0.1:8793", updatedAt: 0 });
  const seen = new Set();
  return found
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((item) => item.base.startsWith("http://127.0.0.1:") && !seen.has(item.base) && seen.add(item.base));
}

async function findRuntime() {
  for (const candidate of await runtimeCandidates()) {
    try {
      const response = await fetch(`${candidate.base}/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(2500)
      });
      if (response.ok) return candidate.base;
    } catch {}
  }
  throw new Error("No running local CodexPro runtime was found.");
}

const baseUrl = await findRuntime();
const mcpUrl = `${baseUrl}/mcp`;
let sessionId = "";
let requestId = 0;

function parseMcpPayload(text) {
  const data = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(data || text || "{}");
}

async function mcpRequest(method, params = {}, timeoutMs = 90_000) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(method.startsWith("notifications/") ? {} : { id: ++requestId }),
      method,
      params
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  assert.equal(response.ok, true, `Local runtime HTTP ${response.status}`);
  sessionId = response.headers.get("mcp-session-id") || sessionId;
  const payload = parseMcpPayload(await response.text());
  if (payload.error) throw new Error(payload.error.message || "Local runtime request failed");
  return payload.result || {};
}

async function browserControl(args, timeoutMs = 90_000) {
  const normalizedArgs = {
    ...args,
    ...(args.target_id !== undefined ? { target_id: String(args.target_id) } : {})
  };
  const result = await mcpRequest("tools/call", {
    name: "browser_control",
    arguments: normalizedArgs
  }, timeoutMs);
  if (result.isError) {
    const error = result.structuredContent?.error;
    throw new Error(typeof error === "object"
      ? String(error.message || JSON.stringify(error))
      : result.content?.[0]?.text || String(error));
  }
  return result.structuredContent || {};
}

let targetId = "";
try {
  await mcpRequest("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "CodexPro ChatGPT account smoke", version: "1.0" }
  });
  await mcpRequest("notifications/initialized");

  const listed = await browserControl({ action: "list_profiles" });
  const profiles = Array.isArray(listed.profiles) ? listed.profiles : [];
  const profile = profiles.find((item) => item?.connected && item?.active)
    || profiles.find((item) => item?.connected && item?.activity === "idle")
    || profiles.find((item) => item?.connected);
  assert.ok(profile?.profile_id, "No connected CodexPro Chrome profile is available.");

  const args = { profile_id: profile.profile_id };
  const opened = await browserControl({ ...args, action: "open_tab", url: "https://chatgpt.com/" });
  targetId = String(opened.target_id || "");
  assert.ok(targetId, "CodexPro did not return a target id for the ChatGPT test tab.");

  await browserControl({
    ...args,
    action: "wait_for",
    target_id: targetId,
    selector: "#prompt-textarea",
    timeout_ms: 30_000
  }, 45_000);

  const marker = "CodexPro bridge smoke test - not sent";
  let typed = null;
  try {
    typed = await browserControl({
      ...args,
      action: "type",
      target_id: targetId,
      selector: "#prompt-textarea",
      text: marker
    });
  } catch {
    const snapshot = await browserControl({
      ...args,
      action: "snapshot",
      target_id: targetId,
      max_chars: 6_000
    });
    const textbox = Array.isArray(snapshot.elements)
      ? snapshot.elements.find((item) => item?.role === "textbox")
      : null;
    assert.ok(textbox?.name, "ChatGPT composer was found but could not be addressed for typing.");
    typed = await browserControl({
      ...args,
      action: "type",
      target_id: targetId,
      role: "textbox",
      name: textbox.name,
      text: marker
    });
  }
  assert.equal(typed?.ok, true, "CodexPro could not type into the ChatGPT composer.");

  console.log(JSON.stringify({
    ok: true,
    connected_profile: true,
    active_profile: Boolean(profile.active),
    extension_version: String(profile.extension_version || "unknown"),
    chatgpt_session_ready: true,
    composer_found: true,
    typed_without_sending: true,
    current_chat_untouched: true
  }, null, 2));
} finally {
  if (targetId) {
    try {
      const listed = await browserControl({ action: "list_profiles" });
      const profiles = Array.isArray(listed.profiles) ? listed.profiles : [];
      const profile = profiles.find((item) => item?.connected && item?.active)
        || profiles.find((item) => item?.connected);
      if (profile?.profile_id) {
        await browserControl({ action: "close_tab", profile_id: profile.profile_id, target_id: targetId }).catch(() => {});
      }
    } catch {}
  }
}
