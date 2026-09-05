import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { materializeApiWorkerRequest, mimeTypeForFile, requestFilePreview } from "../electron/request-attachments.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-request-attachments-"));

try {
  const markdownPath = path.join(temp, "notes.md");
  fs.writeFileSync(markdownPath, "# Smoke\nrequest attachment text", "utf8");

  assert.equal(mimeTypeForFile(markdownPath), "text/markdown");
  assert.equal(mimeTypeForFile(path.join(temp, "archive.unknown")), "application/octet-stream");

  const preview = await requestFilePreview(markdownPath);
  assert.equal(preview.kind, "text");
  assert.equal(preview.mimeType, "text/markdown");
  assert.match(preview.text, /request attachment text/);
  assert.equal(preview.truncated, false);

  const largeTextPath = path.join(temp, "large.txt");
  fs.writeFileSync(largeTextPath, Buffer.alloc(600 * 1024, 65));
  const largePreview = await requestFilePreview(largeTextPath);
  assert.equal(largePreview.kind, "text");
  assert.equal(largePreview.truncated, true);
  assert.equal(largePreview.text.length, 512 * 1024);

  const prepared = await materializeApiWorkerRequest({
    text: "Summarize this file",
    attachments: [{ path: markdownPath }]
  });
  assert.equal(prepared.text, "Summarize this file");
  assert.equal(prepared.attachments, undefined);
  assert.deepEqual(prepared.attachment_names, ["notes.md"]);
  assert.equal(prepared.messages?.[0]?.role, "user");
  assert.match(prepared.messages?.[0]?.content?.[0]?.text || "", /<attachment name="notes\.md" mime="text\/markdown">/);
  assert.match(prepared.messages?.[0]?.content?.[0]?.text || "", /request attachment text/);

  await assert.rejects(() => materializeApiWorkerRequest({ text: "", attachments: [] }), /Hãy nhập yêu cầu/);

  const tooLargePath = path.join(temp, "too-large.txt");
  fs.writeFileSync(tooLargePath, Buffer.alloc((8 * 1024 * 1024) + 1, 66));
  await assert.rejects(() => requestFilePreview(tooLargePath), /8 MB/);

  console.log("request-attachments-smoke: ok");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.exit(0);
