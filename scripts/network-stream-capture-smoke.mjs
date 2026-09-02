import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../chrome-extension/network-capture.js", import.meta.url), "utf8");
const encoder = new TextEncoder();
const responses = [
  [
    { conversation_id: "conversation-old-1234", message: { id: "assistant-old", author: { role: "assistant" }, status: "in_progress", content: { content_type: "text", parts: ["Đang kiểm tra"] } } },
    { conversation_id: "conversation-old-1234", message: { id: "assistant-old", author: { role: "assistant" }, status: "in_progress", content: { content_type: "text", parts: ["Đang kiểm tra xong"] } } }
  ],
  [
    { type: "response.output_text.delta", conversation_id: "conversation-new-5678", item_id: "assistant-new", delta: "Xin " },
    { type: "response.output_text.delta", conversation_id: "conversation-new-5678", item_id: "assistant-new", delta: "chào" }
  ],
  [
    { v: { message: { id: "assistant-patch", author: { role: "assistant" }, status: "in_progress", content: { content_type: "text", parts: [""] } }, conversation_id: "conversation-patch-9012" } },
    { p: "/message/content/parts/0", o: "append", v: "Patch " },
    { v: "stream" },
    { p: "", o: "patch", v: [{ p: "/message/content/parts/0", o: "append", v: " realtime" }] }
  ],
  [
    { conversation_id: "conversation-old-1234", message: { id: "assistant-current", author: { role: "assistant" }, status: "in_progress", content: { content_type: "text", parts: ["Phản hồi mới"] } } }
  ],
  [
    { conversation_id: "conversation-tools-3456", message: { id: "assistant-tool", author: { role: "assistant" }, status: "in_progress", content: { content_type: "text", parts: [JSON.stringify({ path: "/CodexPro/read", args: { path: "src/editor.js" } })] } } }
  ]
];
let call = 0;
const postedMessages = [];

const context = {
  URL,
  Response,
  ReadableStream,
  TextDecoder,
  document: { documentElement: { dataset: {} } },
  location: { href: "https://chatgpt.com/" },
  console,
  setTimeout,
  clearTimeout,
  postMessage: (payload) => postedMessages.push(payload),
  fetch: async (_input, init = {}) => {
    const events = responses[call++] || [];
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(new ReadableStream({
      start(controller) {
        const deliver = () => {
          controller.enqueue(encoder.encode(body));
          if (String(init.body || "").includes('"hold":true')) setTimeout(() => controller.close(), 20);
          else controller.close();
        };
        if (String(init.body || "").includes('"delay":true')) setTimeout(deliver, 20);
        else deliver();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: "network-capture.js" });
assert.equal(context.__codexproNetworkStreamCaptureV1?.version, 4);

const legacyResponse = await context.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST" });
await legacyResponse.text();
await new Promise((resolve) => setTimeout(resolve, 0));
const legacy = context.__codexproNetworkStreamCaptureV1.read("conversation-old-1234");
assert.equal(legacy.available, true);
assert.equal(legacy.text, "Đang kiểm tra xong");
assert.equal(legacy.messages.length, 1);
assert.equal(legacy.event_count, 2);

const responsesApi = await context.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
await responsesApi.text();
await new Promise((resolve) => setTimeout(resolve, 0));
const modern = context.__codexproNetworkStreamCaptureV1.read("conversation-new-5678");
assert.equal(modern.available, true);
assert.equal(modern.text, "Xin chào");
assert.equal(modern.messages.length, 1);
assert.equal(modern.event_count, 2);
const modernPushes = postedMessages.filter((message) => message?.event?.conversation_id === "conversation-new-5678").map((message) => message.event);
const modernDeltas = modernPushes.filter((event) => event.kind === "delta");
assert.equal(modernDeltas.length, 2, "modern response deltas should be pushed as they arrive");
assert.equal(modernDeltas.at(-1)?.text_length, "Xin chào".length, "delta push should include the accumulated text length for gap detection");
assert.ok(modernPushes.every((event, index) => index === 0 || event.revision > modernPushes[index - 1].revision), "realtime push revisions must be strictly increasing per record");

const patchResponse = await context.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST" });
await patchResponse.text();
await new Promise((resolve) => setTimeout(resolve, 0));
const patch = context.__codexproNetworkStreamCaptureV1.read("conversation-patch-9012");
assert.equal(patch.available, true);
assert.equal(patch.text, "Patch stream realtime");
assert.equal(patch.event_count, 4);

const nextResponse = await context.fetch("https://chatgpt.com/backend-api/f/conversation", {
  method: "POST",
  body: JSON.stringify({ conversation_id: "conversation-old-1234", delay: true })
});
const beforeNextChunk = context.__codexproNetworkStreamCaptureV1.read("conversation-old-1234");
assert.equal(beforeNextChunk.available, false, "a new generation must hide the previous stream before its first response chunk arrives");
await nextResponse.text();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(context.__codexproNetworkStreamCaptureV1.read("conversation-old-1234").text, "Phản hồi mới");

const toolResponse = await context.fetch("https://chatgpt.com/backend-api/f/conversation", {
  method: "POST",
  body: JSON.stringify({ conversation_id: "conversation-tools-3456", hold: true })
});
await new Promise((resolve) => setTimeout(resolve, 0));
const toolActivity = context.__codexproNetworkStreamCaptureV1.read("conversation-tools-3456");
assert.equal(toolActivity.available, true);
assert.equal(toolActivity.text, "", "raw tool-call JSON must never be exposed as assistant response text");
assert.equal(toolActivity.messages.length, 0, "raw tool-call JSON must never be exposed in the visible transcript");
assert.equal(toolActivity.activity_text, "Codex Pro đang sử dụng công cụ", "tool activity must stay generic and never expose paths or action names");
assert.equal(toolActivity.in_progress, true, "the UI must keep showing tool activity while the stream is open");
const liveToolPushes = postedMessages.filter((message) => message?.event?.conversation_id === "conversation-tools-3456").map((message) => message.event);
assert.equal(liveToolPushes.at(-1)?.kind, "activity", "tool-only chunks should publish generic activity instead of raw assistant text");
assert.equal(liveToolPushes.at(-1)?.activity_text, "Codex Pro đang sử dụng công cụ");
assert.ok(!JSON.stringify(liveToolPushes).includes("/CodexPro/"), "realtime tool pushes must not leak CodexPro action paths");
assert.ok(!JSON.stringify(liveToolPushes).includes("src/editor.js"), "realtime tool pushes must not leak tool arguments");
await toolResponse.text();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(context.__codexproNetworkStreamCaptureV1.read("conversation-tools-3456").in_progress, false);
const settledToolPush = postedMessages.filter((message) => message?.event?.conversation_id === "conversation-tools-3456").map((message) => message.event).at(-1);
assert.equal(settledToolPush?.kind, "settled");
assert.equal(settledToolPush?.text, "", "terminal tool-only events must not republish raw tool-call JSON");
assert.equal(settledToolPush?.activity_text, "", "terminal tool-only events must clear the live activity label");

const callsBeforeLock = call;
context.document.documentElement.dataset.codexproHeadlessLocked = "1";
context.document.documentElement.dataset.codexproHeadlessWorkerId = "headless-test-worker";
await assert.rejects(
  context.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ conversation_id: "conversation-blocked-7890" })
  }),
  /khóa gửi ChatGPT.*headless-test-worker/,
  "source profile generation must be blocked while its headless worker owns the session"
);
assert.equal(call, callsBeforeLock, "blocked source generation must never reach the original fetch");

context.document.documentElement.dataset.codexproHeadlessLocked = "0";
delete context.document.documentElement.dataset.codexproHeadlessWorkerId;

assert.equal(context.__codexproNetworkStreamCaptureV1.read("missing-conversation").available, false);
console.log("✓ ChatGPT live network stream capture smoke test passed");
