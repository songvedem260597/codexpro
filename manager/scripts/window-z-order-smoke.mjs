import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(here, "..");
const main = fs.readFileSync(path.join(managerRoot, "electron", "main.mjs"), "utf8");
const shortcut = fs.readFileSync(path.join(managerRoot, "electron", "return-to-manager-shortcut.mjs"), "utf8");

const createWindowStart = main.indexOf("function createWindow()");
const createWindowEnd = main.indexOf("function startBrowserProfileEventStream", createWindowStart);
const createWindow = main.slice(createWindowStart, createWindowEnd > createWindowStart ? createWindowEnd : createWindowStart + 18000);
const focusStart = main.indexOf("async function focusChromeWindow");
const focusEnd = main.indexOf("function rendererNeedsForegroundError", focusStart);
const focusChromeWindow = main.slice(focusStart, focusEnd);
const openStart = main.indexOf("async function openProfileChat");
const openEnd = main.indexOf("async function recoverProfileChatTab", openStart);
const openProfileChat = main.slice(openStart, openEnd);

assert.ok(createWindowStart >= 0, "createWindow source must exist");
assert.match(createWindow, /new BrowserWindow\(\{[\s\S]*?alwaysOnTop:\s*false/, "Manager BrowserWindow must explicitly be normal, never always-on-top");
assert.match(createWindow, /ready-to-show[\s\S]*?win\.setAlwaysOnTop\(false\)[\s\S]*?win\.show\(\)/, "Manager must normalize its z-order before first visible show");
assert.doesNotMatch(createWindow, /setAlwaysOnTop\(true\)/, "Manager creation must never promote itself to always-on-top");
assert.doesNotMatch(main, /(?:win|owner)\.setAlwaysOnTop\(true\)/, "Manager runtime must not promote its BrowserWindow to always-on-top");

assert.ok(focusStart >= 0, "focusChromeWindow source must exist");
assert.match(focusChromeWindow, /ProcessName -eq 'chrome'/, "native focus must only target Chrome windows");
assert.match(focusChromeWindow, /windowTitle -eq \(\$target\+' - Google Chrome'\)|windowTitle\.StartsWith\(\$target\+' - '\)/, "native focus must select the intended Chrome title");
const topmostPulse = focusChromeWindow.indexOf("[IntPtr](-1)");
const notTopmost = focusChromeWindow.indexOf("[IntPtr](-2)");
assert.ok(topmostPulse >= 0 && notTopmost > topmostPulse, "Chrome topmost pulse must always be followed by HWND_NOTOPMOST");
assert.match(focusChromeWindow, /foregroundMatch=\(\$foreground -eq \$found\)/, "focus success must be verified from the actual Windows foreground HWND");
assert.match(focusChromeWindow, /ok=\(\[bool\]\$foregroundMatch -and \[bool\]\$maximized\)/, "failed native foreground transfer must not be reported as success");

assert.match(openProfileChat, /activate_tab[\s\S]*?focusChromeWindow\(title \|\| createdTab\?\.title \|\| "ChatGPT"\)/, "open-profile must activate the intended tab before native window focus verification");
assert.doesNotMatch(openProfileChat, /BrowserWindow\.getAllWindows\(\)[\s\S]*?\.focus\(\)/, "open-profile completion must not refocus Manager after Chrome activation");

assert.match(shortcut, /isMinimized[\s\S]*?restore\(\)[\s\S]*?show\(\)[\s\S]*?focus\(\)[\s\S]*?moveTop\(\)/, "return-to-Manager shortcut must still restore/focus/moveTop the Manager");
assert.doesNotMatch(shortcut, /setAlwaysOnTop\(true\)/, "return-to-Manager shortcut must not make Manager always-on-top");

console.log("window-z-order-smoke: PASS");
