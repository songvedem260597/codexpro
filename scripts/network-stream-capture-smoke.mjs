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
  ]
];
let call = 0;

const context = {
  URL,
  Response,
  ReadableStream,
  TextDecoder,
  location: { href: "https://chatgpt.com/" },
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => {
    const events = responses[call++] || [];
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  }
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: "network-capture.js" });
assert.equal(context.__codexproNetworkStreamCaptureV1?.version, 1);

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

const patchResponse = await context.fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST" });
await patchResponse.text();
await new Promise((resolve) => setTimeout(resolve, 0));
const patch = context.__codexproNetworkStreamCaptureV1.read("conversation-patch-9012");
assert.equal(patch.available, true);
assert.equal(patch.text, "Patch stream realtime");
assert.equal(patch.event_count, 4);

assert.equal(context.__codexproNetworkStreamCaptureV1.read("missing-conversation").available, false);
console.log("✓ ChatGPT live network stream capture smoke test passed");
