import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../src/browserExtensionBridge.ts", import.meta.url);
let source = await readFile(file, "utf8");

function replaceOnce(label, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Audit patch target not found: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Audit patch target is ambiguous: ${label}`);
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

replaceOnce(
  "CORS must trust only the signed extension",
  `function setCors(req: IncomingMessage, res: ServerResponse): void {\n  const origin = extensionOrigin(req);\n  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);`,
  `function setCors(req: IncomingMessage, res: ServerResponse): void {\n  const origin = extensionOrigin(req);\n  if (origin === CODEXPRO_EXTENSION_ORIGIN) res.setHeader("Access-Control-Allow-Origin", origin);`
);

replaceOnce(
  "POST bridge origin guard",
  `  return Boolean(extensionOrigin(req)) && req.headers["x-codexpro-extension"] === "profile-bridge-v1";`,
  `  return trustedConnectorRequest(req) && req.headers["x-codexpro-extension"] === "profile-bridge-v1";`
);

replaceOnce(
  "preflight origin guard",
  `  if (req.method === "OPTIONS") {\n    if (!extensionOrigin(req)) {`,
  `  if (req.method === "OPTIONS") {\n    if (!trustedConnectorRequest(req)) {`
);

replaceOnce(
  "disabled profile activation guard",
  `  if (req.url === "/activate") {\n    const profile = profileFromBody(state, body);\n    state.activeProfileId = profile.id;\n    scheduleProfileNotification(state);\n    syncWaiters(state);\n    sendJson(req, res, 200, { ok: true, active_profile_id: profile.id });\n    return;\n  }`,
  `  if (req.url === "/activate") {\n    const profile = profileFromBody(state, body);\n    if (!profile.enabled) {\n      if (state.activeProfileId === profile.id) state.activeProfileId = undefined;\n      scheduleProfileNotification(state);\n      syncWaiters(state);\n      sendJson(req, res, 409, { error: "Browser extension profile is disabled.", profile_id: profile.id });\n      return;\n    }\n    state.activeProfileId = profile.id;\n    scheduleProfileNotification(state);\n    syncWaiters(state);\n    sendJson(req, res, 200, { ok: true, active_profile_id: profile.id });\n    return;\n  }`
);

replaceOnce(
  "disabled profile poll activation guard",
  `    if (body.active === true && !state.activeProfileId) state.activeProfileId = profile.id;`,
  `    if (profile.enabled && body.active === true && !state.activeProfileId) state.activeProfileId = profile.id;`
);

replaceOnce(
  "disabled profile command fast-fail",
  `  if (!profile) {\n    throw new CodexProError("The selected Chrome profile bridge is offline. Open that profile and verify the CodexPro extension is enabled.");\n  }\n  const waitingForReconnect = Date.now() - profile.lastSeen > PROFILE_TTL_MS;`,
  `  if (!profile) {\n    throw new CodexProError("The selected Chrome profile bridge is offline. Open that profile and verify the CodexPro extension is enabled.");\n  }\n  if (!profile.enabled) {\n    throw new CodexProError(\`Chrome profile \${profile.label || profile.id} is disabled.\`, {\n      code: "PROFILE_DISABLED",\n      details: { profile_id: profile.id }\n    });\n  }\n  const waitingForReconnect = Date.now() - profile.lastSeen > PROFILE_TTL_MS;`
);

if (!source.includes(`return trustedConnectorRequest(req) && req.headers["x-codexpro-extension"] === "profile-bridge-v1";`)) {
  throw new Error("Audit patch verification failed: trusted POST origin guard missing.");
}
if (!source.includes(`if (!profile.enabled) {\n    throw new CodexProError(\`Chrome profile \${profile.label || profile.id} is disabled.\``)) {
  throw new Error("Audit patch verification failed: disabled command guard missing.");
}

await writeFile(file, source, "utf8");
console.log("audit-fix-browser-bridge: patched");
