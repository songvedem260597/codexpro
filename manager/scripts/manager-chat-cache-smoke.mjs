import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createManagerChatCache } from "../electron/manager-chat-cache.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-chat-cache-"));
let tick = 0;
const nextNow = () => new Date(Date.UTC(2026, 8, 5, 0, tick++, 0)).toISOString();

try {
  const cache = createManagerChatCache({ home: tempHome, now: nextNow, sampleEventLoopLag: async () => 2.5 });
  assert.deepEqual(cache.read(), []);
  assert.equal(cache.get({ profileId: "bad profile", conversationId: "conv-0001" }), null);
  assert.equal(await cache.save({ profileId: "profile-a", conversationId: "short", text: "invalid" }), null);

  for (let index = 1; index <= 4; index += 1) {
    const saved = await cache.save({
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

  await cache.save({
    profileId: "profile-b",
    conversationId: "conv-b001",
    messages: Array.from({ length: 15 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `message-${index}` })),
    text: "x".repeat(40_100),
    logicalTaskCount: 7.9
  });
  assert.equal((await cache.flush()).flushed, true);

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
  assert.equal(cache.metrics().lastEventLoopLagMs, 2.5);
  assert.ok(cache.metrics().lastPayloadBytes > 0);
  assert.equal(cache.metrics().lastPayloadBytes, cache.metrics().lastFileBytes);

  const reloaded = createManagerChatCache({ home: tempHome });
  assert.equal(reloaded.get({ profileId: "profile-a", conversationId: "conv-0004" })?.text, "answer-4");
  assert.equal(reloaded.get({ profileId: "profile-b", conversationId: "conv-b001" })?.messages.length, 12);

  const burstHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-chat-cache-burst-"));
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const writeOrder = [];
  const burstCache = createManagerChatCache({
    home: burstHome,
    sampleEventLoopLag: async () => 1,
    io: {
      writeFile: async (file, data, encoding) => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        writeOrder.push(JSON.parse(data).entries.map((entry) => `${entry.conversationId}:${entry.text}`).join("|"));
        await sleep(25);
        try {
          return await fs.promises.writeFile(file, data, encoding);
        } finally {
          activeWrites -= 1;
        }
      }
    }
  });
  const burstSaves = [];
  for (let index = 1; index <= 20; index += 1) {
    burstSaves.push(burstCache.save({
      profileId: "profile-burst",
      conversationId: "conv-burst-001",
      messages: [{ role: "assistant", text: `burst-${index}` }],
      text: `burst-${index}`
    }));
  }
  await Promise.all(burstSaves);
  assert.equal((await burstCache.flush({ timeoutMs: 500 })).flushed, true);
  const burstMetrics = burstCache.metrics();
  assert.equal(burstMetrics.saveRequestsReceived, 20);
  assert.equal(burstMetrics.saveRequestsCompleted, 20);
  assert.ok(burstMetrics.saveRequestsCoalesced >= 18, `expected burst coalescing, got ${burstMetrics.saveRequestsCoalesced}`);
  assert.ok(burstMetrics.writesCompleted <= 2, `expected at most two physical writes, got ${burstMetrics.writesCompleted}`);
  assert.equal(maxActiveWrites, 1, "cache file writes must be serialized");
  assert.equal(burstMetrics.inFlight, 0);
  assert.equal(burstMetrics.pending, 0);
  const burstPersisted = JSON.parse(fs.readFileSync(path.join(burstHome, "manager-chat-cache.json"), "utf8"));
  assert.equal(burstPersisted.entries[0].text, "burst-20", "old snapshots must never overwrite the newest snapshot");
  assert.ok(writeOrder.at(-1).includes("burst-20"));
  assert.equal(fs.readdirSync(burstHome).some((name) => name.includes(".tmp-")), false, "successful atomic writes must not leave temp files");

  const multiHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-chat-cache-multi-"));
  const multiCache = createManagerChatCache({ home: multiHome, sampleEventLoopLag: async () => 0 });
  await Promise.all([
    multiCache.save({ profileId: "profile-multi", conversationId: "conv-multi-a", text: "multi-a-1", messages: [{ role: "assistant", text: "multi-a-1" }] }),
    multiCache.save({ profileId: "profile-multi", conversationId: "conv-multi-b", text: "multi-b-1", messages: [{ role: "assistant", text: "multi-b-1" }] }),
    multiCache.save({ profileId: "profile-multi", conversationId: "conv-multi-a", text: "multi-a-2", messages: [{ role: "assistant", text: "multi-a-2" }] })
  ]);
  await multiCache.flush();
  const multiPersisted = JSON.parse(fs.readFileSync(path.join(multiHome, "manager-chat-cache.json"), "utf8"));
  const byConversation = new Map(multiPersisted.entries.map((entry) => [entry.conversationId, entry.text]));
  assert.equal(byConversation.get("conv-multi-a"), "multi-a-2");
  assert.equal(byConversation.get("conv-multi-b"), "multi-b-1");

  const errorHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-chat-cache-error-"));
  let failNextWrite = true;
  const errorCache = createManagerChatCache({
    home: errorHome,
    sampleEventLoopLag: async () => 0,
    io: {
      writeFile: async (file, data, encoding) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("synthetic cache write failure");
        }
        return fs.promises.writeFile(file, data, encoding);
      }
    }
  });
  await assert.rejects(() => errorCache.save({ profileId: "profile-error", conversationId: "conv-error-001", text: "first", messages: [{ role: "assistant", text: "first" }] }), /synthetic cache write failure/);
  assert.equal(errorCache.metrics().writesFailed, 1);
  assert.equal(errorCache.metrics().saveRequestsFailed, 1);
  await errorCache.save({ profileId: "profile-error", conversationId: "conv-error-001", text: "recovered", messages: [{ role: "assistant", text: "recovered" }] });
  assert.equal((await errorCache.flush({ timeoutMs: 500 })).flushed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(errorHome, "manager-chat-cache.json"), "utf8")).entries[0].text, "recovered");

  const slowHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-chat-cache-flush-"));
  const slowCache = createManagerChatCache({
    home: slowHome,
    sampleEventLoopLag: async () => 0,
    io: {
      writeFile: async (file, data, encoding) => {
        await sleep(80);
        return fs.promises.writeFile(file, data, encoding);
      }
    }
  });
  const slowSave = slowCache.save({ profileId: "profile-flush", conversationId: "conv-flush-001", text: "final", messages: [{ role: "assistant", text: "final" }] });
  const timed = await slowCache.flush({ timeoutMs: 10 });
  assert.equal(timed.flushed, false);
  assert.equal(timed.timedOut, true, "flush must respect a finite timeout");
  await slowSave;
  const finalFlush = await slowCache.flush({ timeoutMs: 500 });
  assert.equal(finalFlush.flushed, true, "final flush must drain the newest snapshot");
  assert.equal(JSON.parse(fs.readFileSync(path.join(slowHome, "manager-chat-cache.json"), "utf8")).entries[0].text, "final");

  const cacheSource = fs.readFileSync(new URL("../electron/manager-chat-cache.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(cacheSource, /writeFileSync|mkdirSync/, "main-process chat cache must not perform synchronous file writes");
  assert.match(cacheSource, /\.tmp-\$\{process\.pid\}/, "chat cache writes must use a same-directory temp file");
  assert.match(cacheSource, /await rename\(tempFile, managerChatCacheFile\)/, "chat cache writes must atomically replace the destination");

  const mainSource = fs.readFileSync(path.resolve("electron/main.mjs"), "utf8");
  assert.ok(mainSource.includes('from "./manager-chat-cache.mjs"'));
  assert.ok(!mainSource.includes("function normalizeChatCacheEntry("));
  assert.ok(!mainSource.includes("managerChatCacheFile"));

  for (const dir of [burstHome, multiHome, errorHome, slowHome]) fs.rmSync(dir, { recursive: true, force: true });
  console.log("manager-chat-cache-smoke: ok");
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
