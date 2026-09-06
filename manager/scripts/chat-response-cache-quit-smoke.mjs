import assert from "node:assert/strict";
import fs from "node:fs";

import { createChatResponseCacheQuitCoordinator } from "../electron/chat-response-cache-quit.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sent = [];
let mainFlushCalls = 0;
const coordinator = createChatResponseCacheQuitCoordinator({
  listRenderers: () => [{ id: 11 }, { id: 22 }],
  sendFlushRequest: (renderer, payload) => sent.push({ id: renderer.id, payload }),
  flushMainCache: async ({ timeoutMs }) => {
    mainFlushCalls += 1;
    assert.equal(timeoutMs, 300);
    return { flushed: true, timedOut: false, pending: 0, inFlight: 0 };
  }
});

const flush = coordinator.flushBeforeQuit({ rendererTimeoutMs: 200, mainTimeoutMs: 300 });
await sleep(5);
assert.equal(sent.length, 2);
assert.equal(sent[0].payload.requestId, sent[1].payload.requestId);
assert.equal(coordinator.acknowledge(11, { requestId: sent[0].payload.requestId }), true);
assert.equal(coordinator.acknowledge(11, { requestId: sent[0].payload.requestId }), false, "duplicate acknowledgements must be ignored");
assert.equal(coordinator.acknowledge(22, { requestId: sent[0].payload.requestId }), true);
const result = await flush;
assert.equal(result.flushed, true);
assert.equal(result.renderer.expected, 2);
assert.equal(result.renderer.acknowledged, 2);
assert.equal(result.renderer.timedOut, false);
assert.equal(mainFlushCalls, 1);

let timeoutMainFlushCalls = 0;
const timeoutCoordinator = createChatResponseCacheQuitCoordinator({
  listRenderers: () => [{ id: 33 }],
  sendFlushRequest: () => {},
  flushMainCache: async () => {
    timeoutMainFlushCalls += 1;
    return { flushed: true, timedOut: false };
  }
});
const timeoutResult = await timeoutCoordinator.flushBeforeQuit({ rendererTimeoutMs: 10, mainTimeoutMs: 50 });
assert.equal(timeoutResult.renderer.timedOut, true, "quit must stop waiting for a stuck renderer after the finite timeout");
assert.equal(timeoutResult.flushed, false);
assert.equal(timeoutMainFlushCalls, 1, "main cache must still flush after renderer acknowledgement timeout");

const sendFailureCoordinator = createChatResponseCacheQuitCoordinator({
  listRenderers: () => [{ id: 44 }],
  sendFlushRequest: () => { throw new Error("renderer gone"); },
  flushMainCache: async () => ({ flushed: true, timedOut: false })
});
const sendFailure = await sendFailureCoordinator.flushBeforeQuit({ rendererTimeoutMs: 50, mainTimeoutMs: 50 });
assert.equal(sendFailure.renderer.failedToSend, 1);
assert.equal(sendFailure.renderer.timedOut, false, "a destroyed renderer must not burn the whole quit timeout");
assert.equal(sendFailure.main.flushed, true);

const mainSource = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const preloadSource = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
const cacheHookSource = fs.readFileSync(new URL("../src/hooks/use-chat-response-cache.js", import.meta.url), "utf8");
assert.match(mainSource, /createChatResponseCacheQuitCoordinator\(/, "main process must own the normal-quit cache flush coordinator");
assert.match(mainSource, /ipcMain\.on\("codexpro:chat-response-cache-flush-ack"/, "main process must receive renderer cache flush acknowledgements");
assert.match(mainSource, /rendererTimeoutMs:\s*1000/, "normal quit renderer wait must stay bounded");
assert.match(mainSource, /mainTimeoutMs:\s*1200/, "normal quit main cache wait must stay bounded");
assert.match(mainSource, /event\.preventDefault\(\)/, "normal quit must wait for bounded cache flush before exiting");
assert.match(mainSource, /codexpro:get-chat-response-cache-metrics/, "runtime QA must be able to inspect sanitized cache metrics");
assert.match(preloadSource, /onChatResponseCacheFlushRequest/, "preload must expose renderer flush requests");
assert.match(preloadSource, /ackChatResponseCacheFlush/, "preload must expose renderer flush acknowledgements");
assert.match(preloadSource, /getChatResponseCacheMetrics/, "preload must expose sanitized cache metrics");
assert.match(cacheHookSource, /onChatResponseCacheFlushRequest/, "renderer cache hook must subscribe to app quit flush requests");
assert.match(cacheHookSource, /flushResponseCache\("app-before-quit"\)/, "renderer must drain its coalesced queue before app quit");
assert.match(cacheHookSource, /ackChatResponseCacheFlush/, "renderer must acknowledge completion back to main");

console.log("chat-response-cache-quit-smoke: ok");
