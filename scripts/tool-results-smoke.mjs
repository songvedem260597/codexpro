import assert from "node:assert/strict";
import {
  STRUCTURED_STRING_MAX_CHARS,
  compactStructuredContent,
  errorEnvelope,
  errorResult,
  errorText,
  textResult
} from "../src/toolResults.js";

const longText = "x".repeat(30_001);
const truncated = `${"x".repeat(30_000)}\n...[structured field truncated to 30000 chars]`;

assert.equal(STRUCTURED_STRING_MAX_CHARS, 30_000);
assert.equal(compactStructuredContent(longText), truncated);

const depthFixture = {};
let depthCursor = depthFixture;
for (let index = 0; index < 9; index += 1) {
  depthCursor.next = {};
  depthCursor = depthCursor.next;
}
depthCursor.value = longText;
const depthResult = compactStructuredContent(depthFixture);
let depthResultCursor = depthResult;
for (let index = 0; index < 9; index += 1) depthResultCursor = depthResultCursor.next;
assert.equal(depthResultCursor.value, longText, "depth > 8 must preserve the original nested string without truncation");

const circular = { label: "root" };
circular.self = circular;
const circularResult = compactStructuredContent(circular);
let circularCursor = circularResult;
for (let index = 0; index < 9; index += 1) circularCursor = circularCursor.self;
assert.equal(circularCursor, circular, "depth cutoff must preserve the original circular object reference at depth 9");

assert.equal(errorText(new TypeError("boom")), "TypeError: boom");
assert.equal(errorText("plain failure"), "plain failure");

const codedError = new Error("broken");
codedError.name = "FixtureError";
codedError.code = "E_FIXTURE";
codedError.details = { note: "details", long: longText };
codedError.cause = new Error("root cause");
const envelope = errorEnvelope(codedError);
assert.equal(envelope.name, "FixtureError");
assert.equal(envelope.message, "FixtureError: broken");
assert.equal(envelope.code, "E_FIXTURE");
assert.equal(envelope.cause, "Error: root cause");
assert.equal(envelope.details.note, "details");
assert.equal(envelope.details.long, truncated);
assert.deepEqual(errorEnvelope("plain failure"), { name: "Error", message: "plain failure" });

const secret = ["sk", "1234567890ABCDE"].join("-");
assert.deepEqual(textResult(`hello ${secret}`, { nested: `value ${secret}` }, { marker: true }), {
  content: [{ type: "text", text: "hello [REDACTED_SECRET]" }],
  structuredContent: { nested: "value [REDACTED_SECRET]" },
  _meta: { marker: true }
});

const result = errorResult(codedError);
assert.equal(result.isError, true);
assert.deepEqual(result.content, [{ type: "text", text: "FixtureError: broken" }]);
assert.equal(result.structuredContent.error.code, "E_FIXTURE");
assert.equal(result.structuredContent.error.message, "FixtureError: broken");
assert.equal("_meta" in result, false);

console.log("tool-results smoke passed");
