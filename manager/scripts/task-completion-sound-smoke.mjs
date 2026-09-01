import assert from "node:assert/strict";
import fs from "node:fs";

import { playTaskCompletionSound, TASK_COMPLETION_SOUND } from "../src/task-completion-sound.js";

class FakeAudioParam {
  constructor() {
    this.events = [];
  }

  setValueAtTime(value, time) {
    this.events.push({ type: "set", value, time });
  }

  linearRampToValueAtTime(value, time) {
    this.events.push({ type: "linear", value, time });
  }

  exponentialRampToValueAtTime(value, time) {
    this.events.push({ type: "exponential", value, time });
  }
}

class FakeAudioContext {
  static latest = null;

  constructor() {
    this.currentTime = 4;
    this.destination = { name: "destination" };
    this.frequency = new FakeAudioParam();
    this.gain = new FakeAudioParam();
    this.oscillator = {
      frequency: this.frequency,
      connect: (target) => { this.oscillatorTarget = target; },
      start: (time) => { this.startedAt = time; },
      stop: (time) => { this.stoppedAt = time; }
    };
    this.gainNode = {
      gain: this.gain,
      connect: (target) => { this.gainTarget = target; }
    };
    FakeAudioContext.latest = this;
  }

  createOscillator() {
    return this.oscillator;
  }

  createGain() {
    return this.gainNode;
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

const timers = [];
assert.equal(playTaskCompletionSound({
  AudioContextClass: FakeAudioContext,
  setTimer(callback, delay) {
    timers.push({ callback, delay });
    return timers.length;
  }
}), true, "supported renderers should schedule the completion click");

const context = FakeAudioContext.latest;
assert.equal(context.oscillatorTarget, context.gainNode, "the oscillator must feed the quiet gain envelope");
assert.equal(context.gainTarget, context.destination, "the quiet envelope must feed the audio output");
assert.equal(context.startedAt, 4);
assert.ok(context.stoppedAt - context.startedAt <= 0.1, "the click must remain shorter than 100 ms");
assert.ok(Math.max(...context.gain.events.map((event) => event.value)) <= 0.04, "the click must stay at a gentle volume");
assert.deepEqual(context.frequency.events, [
  { type: "set", value: TASK_COMPLETION_SOUND.startFrequency, time: 4 },
  { type: "exponential", value: TASK_COMPLETION_SOUND.endFrequency, time: 4 + TASK_COMPLETION_SOUND.duration }
]);
assert.equal(timers.length, 1);
assert.ok(timers[0].delay <= 250, "the temporary audio context should close promptly");
await timers[0].callback();
assert.equal(context.closed, true);
assert.equal(playTaskCompletionSound({ AudioContextClass: null }), false, "unsupported renderers should fail silently");

const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(
  main,
  /Task hoàn tất[\s\S]{0,400}silent:\s*true[\s\S]{0,200}playTaskCompletionSound\(\)/,
  "only the existing task-complete transition should show a silent Windows notification and play the soft click"
);

console.log("✓ Gentle task-completion sound smoke test passed");
