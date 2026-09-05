import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createManagerChatCache } from "../electron/manager-chat-cache.mjs";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-chat-cache-"));
let tick = 0;
const nextNow = () => new Date(Date.UTC(2026, 8, 5, 0, tick++, 0)).toISOString();

try {
  const cache = createManagerChatCache({ home: tempHome, now: nextNow });
  assert.deepEqual(cache.read(), []);
  assert.equal(cache.get({ profileId: "bad profile", conversationId: "conv-0001" }), null);
  assert.equal(cache.save({ profileId: "profile-a", conversationId: "short", text: "invalid" }), null);

  for (let index = 1; index <= 4; index += 1) {
    const saved = cache.save({
      profileId: "profile-a",
      conversationId: `conv-000${index}`,
      messages: [{ role: "assistant", text: `answer-${index}` }],
      text: `answer-${index}`,
      repoTaskId: index === 4 ? "cpt_1234567890abcdef12345678" : "invalid",
      completedLogicalTaskIds: ["cpt_aaaaaaaaaaaaaaaaaaaaaaaa", "bad", "cpt_aaaaaaaaaaaaaaaaaaaaaaaa"],
      logicalTaskStatus: index === 4 ? "COMPLETED" : "unknown"
    });
    assert.equal(saved?.conversationId, `conv-000${index}`);
  }

  cache.save({
    profileId: "profile-b",
    conversationId: "conv-b001",
    messages: Array.from({ length: 15 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `message-${index}` })),
    text: "x".repeat(40_100),
    logicalTaskCount: 7.9
  });

  const entries = cache.read();
  const profileA = entries.filter((entry) => entry.profileId === "profile-a");
  assert.equal(profileA.length, 3);
  assert.deepEqual(profileA.map((entry) => entry.conversationId), ["conv-0002", "conv-0003", "conv-0004"]);
  assert.equal(cache.get({ profileId: "profile-a", conversationId: "conv-0001" }), null);

  const latest = cache.get({ profileId: "profile-a", conversationId: "conv-0004" });
  assert.equal(latest?.repoTaskId, "cpt_1234567890abcdef12345678");
  assert.equal(latest?.logicalTaskStatus, "completed");
  assert.deepEqual(latest?.completedLogicalTaskIds, ["cpt_aaaaaaaaaaaaaaaaaaaaaaaa"]);

  const profileB = cache.get({ profileId: "profile-b", conversationId: "conv-b001" });
  assert.equal(profileB?.messages.length, 12);
  assert.equal(profileB?.messages[0]?.text, "message-3");
  assert.equal(profileB?.text.length, 40_000);
  assert.equal(profileB?.logicalTaskCount, 7);

  const cacheFile = path.join(tempHome, "manager-chat-cache.json");
  const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.entries.length, 4);

  const reloaded = createManagerChatCache({ home: tempHome });
  assert.equal(reloaded.get({ profileId: "profile-a", conversationId: "conv-0004" })?.text, "answer-4");
  assert.equal(reloaded.get({ profileId: "profile-b", conversationId: "conv-b001" })?.messages.length, 12);

  const mainSource = fs.readFileSync(path.resolve("electron/main.mjs"), "utf8");
  assert.ok(mainSource.includes('from "./manager-chat-cache.mjs"'));
  assert.ok(!mainSource.includes("function normalizeChatCacheEntry("));
  assert.ok(!mainSource.includes("managerChatCacheFile"));

  console.log("manager-chat-cache-smoke: ok");
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
