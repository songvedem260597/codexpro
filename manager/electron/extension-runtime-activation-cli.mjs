#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import {
  activateExtensionRuntime,
  rollbackExtensionRuntime
} from "./extension-runtime-activation.mjs";
import {
  createManagerExtensionRuntimeController,
  discoverCodexProRuntimeConfig
} from "./extension-runtime-manager.mjs";

function readArguments(argv) {
  const values = [...argv];
  const command = values.shift() || "";
  const options = {};
  while (values.length) {
    const token = values.shift();
    if (token === "--authorize-profile-override") {
      options.authorizeProfileOverride = true;
      continue;
    }
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = values.shift();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[token.slice(2)] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = String(options[name] || "").trim();
  if (!value) throw new Error(`Missing required --${name} argument.`);
  return value;
}

function safeResult(value) {
  return JSON.stringify({
    ok: true,
    ...value
  }, null, 2);
}

async function main() {
  const parsed = readArguments(process.argv.slice(2));
  if (!["activate", "rollback"].includes(parsed.command)) {
    throw new Error("Usage: extension-runtime-activation-cli.mjs <activate|rollback> [options]");
  }
  const home = process.env.CODEXPRO_HOME
    ? path.resolve(process.env.CODEXPRO_HOME)
    : path.join(os.homedir(), ".codexpro");
  const runtimeConfig = await discoverCodexProRuntimeConfig({ home });
  const canonicalExtensionRoot = path.join(runtimeConfig.root, "chrome-extension");
  const targetProfileId = required(parsed.options, "profile-id");
  const controller = createManagerExtensionRuntimeController({
    home,
    canonicalExtensionRoot,
    runtimeConfig
  });

  if (parsed.command === "rollback") {
    const result = await rollbackExtensionRuntime({
      home,
      targetProfileId,
      canonicalExtensionRoot,
      inspectRuntime: controller.inspectRuntime,
      prepareProfile: controller.prepareProfile,
      stopProfile: controller.stopProfile,
      startProfile: controller.startProfile
    });
    console.log(safeResult({ operation: "rollback", ...result }));
    return;
  }

  const result = await activateExtensionRuntime({
    home,
    canonicalExtensionRoot,
    request: {
      taskId: required(parsed.options, "task-id"),
      taskOwnerProfileId: required(parsed.options, "task-owner-profile-id"),
      targetProfileId,
      artifactRoot: required(parsed.options, "artifact-root"),
      sourceCommit: required(parsed.options, "source-commit"),
      expectedSha256: required(parsed.options, "expected-sha256"),
      managerAuthorizedProfileOverride: parsed.options.authorizeProfileOverride === true
    },
    loadTask: controller.loadTask,
    getGitHead: controller.getGitHead,
    getGitBranch: controller.getGitBranch,
    getGitStatus: controller.getGitStatus,
    prepareProfile: controller.prepareProfile,
    inspectRuntime: controller.inspectRuntime,
    stopProfile: controller.stopProfile,
    startProfile: controller.startProfile
  });
  console.log(safeResult({ operation: "activate", ...result }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: String(error?.code || "EXTENSION_ACTIVATION_FAILED"),
    message: error?.message || String(error),
    rollback: error?.rollback || null
  }, null, 2));
  process.exitCode = 1;
});
