import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyUserReportedError } from "../electron/user-reported-error.mjs";

const vietnameseReport = classifyUserReportedError({
  text: "Không có tab Chrome nào mà vẫn báo ĐANG RẢNH"
});
assert.equal(vietnameseReport.is_error, true, "an observed broken behavior in Vietnamese must be classified as a user-discovered error");
assert.equal(vietnameseReport.classification, "user_discovered_error");
assert.match(vietnameseReport.incident_fingerprint, /^[a-f0-9]{24}$/);
assert.ok(vietnameseReport.detection_signals.length > 0);

const firstTrace = classifyUserReportedError({
  text: "TypeError: Cannot read properties of undefined at 2026-09-01T05:31:22Z request 123456"
});
const repeatedTrace = classifyUserReportedError({
  text: "TypeError: Cannot read properties of undefined at 2026-09-01T05:36:09Z request 987654"
});
assert.equal(firstTrace.is_error, true);
assert.equal(firstTrace.incident_fingerprint, repeatedTrace.incident_fingerprint, "volatile timestamps and request numbers must not split one repeated error");

const logAttachment = classifyUserReportedError({
  text: "Kiểm tra file đính kèm",
  attachments: [{ name: "renderer-crash.log", mimeType: "text/plain" }]
});
assert.equal(logAttachment.is_error, true, "an explicitly named crash log attachment must be classified as user evidence");
assert.deepEqual(logAttachment.attachment_names, ["renderer-crash.log"]);

assert.equal(classifyUserReportedError({ text: "Thêm bộ lọc theo dự án trong trang tổng quan" }).is_error, false, "ordinary feature requests must not become error logs");
assert.equal(classifyUserReportedError({ text: "Viết tài liệu giải thích error handling trong JavaScript" }).is_error, false, "educational mentions of error handling must not become incidents");

const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("../src/diagnostic-log-view.jsx", import.meta.url), "utf8");
assert.match(main, /function recordUserReportedError[\s\S]*?diagnostic\("error", "user", "user-reported-error"[\s\S]*?incident_fingerprint/, "Manager must persist classified user reports with a stable incident fingerprint");
assert.match(main, /codexpro:worker-send[\s\S]*?recordUserReportedError\(prepared[\s\S]*?codexpro:send-profile-request[\s\S]*?recordUserReportedError\(payload/, "both API-worker and direct ChatGPT requests must pass through user-error classification");
assert.match(view, /user: "Người dùng"[\s\S]*?"user-reported-error": "Lỗi người dùng phát hiện"[\s\S]*?occurrence_count/, "Diagnostic UI must expose the user source, classification, and repeat count");

console.log("✓ user-reported error classification and integration smoke test passed");
