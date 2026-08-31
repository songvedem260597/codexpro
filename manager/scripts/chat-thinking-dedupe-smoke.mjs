import assert from "node:assert/strict";
import { latestTurnHasProvisionalAssistant } from "../src/chat-transcript.js";

assert.equal(latestTurnHasProvisionalAssistant([
  { id: "user-1", role: "user", text: "Phân tích ảnh" },
  { id: "assistant-1", role: "assistant", text: "Analyzing image", provisional: true, endTurn: false }
]), true, "an in-progress image-analysis row must suppress the synthetic Thinking row");

assert.equal(latestTurnHasProvisionalAssistant([
  { id: "user-1", role: "user", text: "Làm tiếp" },
  { id: "assistant-1", role: "assistant", text: "Thinking", endTurn: false }
]), true, "an in-progress Thinking row must suppress a duplicate synthetic Thinking row");

assert.equal(latestTurnHasProvisionalAssistant([
  { id: "user-old", role: "user", text: "Turn cũ" },
  { id: "assistant-old", role: "assistant", text: "Thinking", provisional: true, endTurn: false },
  { id: "user-new", role: "user", text: "Turn mới" }
]), false, "a provisional assistant from an older turn must not hide Thinking for the newest turn");

assert.equal(latestTurnHasProvisionalAssistant([
  { id: "user-1", role: "user", text: "Xong chưa" },
  { id: "assistant-1", role: "assistant", text: "Đã xong", provisional: false, endTurn: true }
]), false, "a finalized assistant response is not a live progress row");

assert.equal(latestTurnHasProvisionalAssistant([
  { id: "user-1", role: "user", text: "Bắt đầu" }
]), false, "a turn with no assistant content still needs the synthetic Thinking row");

console.log("chat-thinking-dedupe-smoke: ok");
