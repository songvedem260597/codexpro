import assert from "node:assert/strict";
import { focusManagerWindow, registerReturnToManagerShortcut, RETURN_TO_MANAGER_ACCELERATOR } from "../electron/return-to-manager-shortcut.mjs";

assert.equal(RETURN_TO_MANAGER_ACCELERATOR, "CommandOrControl+Shift+M");

const calls = [];
const fakeWindow = {
  destroyed: false,
  minimized: true,
  isDestroyed() { return this.destroyed; },
  isMinimized() { return this.minimized; },
  restore() { calls.push("restore"); this.minimized = false; },
  show() { calls.push("show"); },
  focus() { calls.push("focus"); },
  moveTop() { calls.push("moveTop"); }
};
assert.equal(focusManagerWindow(fakeWindow), true);
assert.deepEqual(calls, ["restore", "show", "focus", "moveTop"]);

let registeredAccelerator = "";
let registeredHandler = null;
let unregisteredAccelerator = "";
const fakeGlobalShortcut = {
  register(accelerator, handler) {
    registeredAccelerator = accelerator;
    registeredHandler = handler;
    return true;
  },
  unregister(accelerator) {
    unregisteredAccelerator = accelerator;
  }
};

const registration = registerReturnToManagerShortcut({ globalShortcut: fakeGlobalShortcut, getWindow: () => fakeWindow });
assert.equal(registration.registered, true);
assert.equal(registeredAccelerator, RETURN_TO_MANAGER_ACCELERATOR);
assert.equal(typeof registeredHandler, "function");
registeredHandler();
registration.unregister();
registration.unregister();
assert.equal(unregisteredAccelerator, RETURN_TO_MANAGER_ACCELERATOR);

fakeWindow.destroyed = true;
assert.equal(focusManagerWindow(fakeWindow), false);

console.log("✓ Return-to-Manager shortcut smoke passed");
