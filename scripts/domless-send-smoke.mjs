import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const worker = await readFile(join(root, "chrome-extension", "service-worker.js"), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = worker.indexOf(marker);
  assert.notEqual(start, -1, `${name} must remain defined in the profile bridge worker`);
  const bodyStart = worker.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let regex = false;
  let characterClass = false;
  for (let index = bodyStart; index < worker.length; index += 1) {
    const character = worker[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (regex) {
      if (character === "\\") escaped = true;
      else if (character === "[" && !characterClass) characterClass = true;
      else if (character === "]" && characterClass) characterClass = false;
      else if (character === "/" && !characterClass) regex = false;
      continue;
    }
    if (["'", "\"", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "/" && worker[index - 1] !== "*") {
      const previous = worker.slice(0, index).trimEnd().at(-1) ?? "";
      if (["(", "=", ":", "!", "&", "|", ","].includes(previous)) {
        regex = true;
        continue;
      }
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return worker.slice(start, index + 1);
    }
  }
  assert.fail(`Could not find the end of ${name}`);
}

const generationSource = extractFunction("isChatGenerationRequest");
const isChatGenerationRequest = Function(`${generationSource}; return isChatGenerationRequest;`)();

assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://chatgpt.com/backend-api/conversation"
}), true);
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://chatgpt.com/backend-api/codex/responses"
}), true);
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "GET",
  url: "https://chatgpt.com/backend-api/conversation"
}), false);
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://example.com/backend-api/conversation"
}), false);

const sendStart = worker.indexOf("if(action==='send_chat_request'){");
const sendEnd = worker.indexOf("if(action==='rename_chat'){", sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, "send_chat_request command block must exist");
const sendBlock = worker.slice(sendStart, sendEnd);
const timeoutCatch = sendBlock.indexOf("}catch(error){");
const networkRecovery = sendBlock.indexOf("waitForNetworkGeneration(tab.id,submitStartedAt-100,5000)", timeoutCatch);
const acknowledgedReturn = sendBlock.indexOf("if(networkAck)return await resultForNetwork", networkRecovery);
const cleanup = sendBlock.indexOf("await cleanupAttempt()", timeoutCatch);

assert.ok(timeoutCatch >= 0, "DOM send timeout must be handled");
assert.ok(networkRecovery > timeoutCatch, "DOM timeout must check the network tracker");
assert.ok(acknowledgedReturn > networkRecovery, "a tracked generation must count as submitted");
assert.ok(cleanup > acknowledgedReturn, "draft cleanup must only happen after network recovery fails");
assert.match(sendBlock, /SEND_UNCERTAIN: Đã bấm gửi nhưng chưa thấy generation request/);
assert.match(sendBlock, /submitted_by:'network'/);
assert.match(worker, /const currentComposer=findComposer\(\)/, "composer verification must survive ChatGPT replacing the React node");
assert.match(worker, /const currentRoot=composerRootFor\(currentComposer\)\|\|root/, "send lookup must use the latest composer tree");

console.log("✓ DOM-less ChatGPT send recovery smoke test passed");
