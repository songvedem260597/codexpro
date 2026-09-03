import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [worker, markdownRenderer, manifestText, managerMain] = await Promise.all([
  readFile(join(root, "chrome-extension", "service-worker.js"), "utf8"),
  readFile(join(root, "manager", "src", "response-markdown.jsx"), "utf8"),
  readFile(join(root, "chrome-extension", "manifest.json"), "utf8"),
  readFile(join(root, "manager", "electron", "main.mjs"), "utf8")
]);

const manifest = JSON.parse(manifestText);
const responseReader = worker.slice(worker.indexOf("async function readChatResponsePage()"), worker.indexOf("function inspectChatSendAttemptPage"));

assert.match(responseReader, /clone\.querySelectorAll\('a\[href\]'\)\.forEach/, "DOM response text must inspect anchor hrefs before flattening HTML to text");
assert.match(responseReader, /\^\(\?:https\?:\\\/\\\/\|mailto:\)/, "only safe http, https, and mailto links may be returned");
assert.match(responseReader, /const markdown=!label\|\|label===href\?href:`\[\$\{escapedLabel\}\]\(\$\{escapedHref\}\)`/, "labeled anchors must survive as Markdown links so the Manager can render them clickable");
assert.match(responseReader, /const linksFor=root=>[\s\S]*?return \{text:[\s\S]*?href\}/, "DOM response messages must expose structured link metadata");
assert.match(responseReader, /const links=content\?linksFor\(content\):\[\]/, "assistant turns must retain their extracted links");
assert.match(responseReader, /text_length:text\.length,links,truncated:/, "the latest response payload must return its link list alongside text");
assert.match(markdownRenderer, /safeMarkdownHref[\s\S]*?https\?:\\\/\\\/[\s\S]*?mailto:/, "Manager Markdown rendering must whitelist safe clickable link schemes");
assert.match(markdownRenderer, /onClick=\{\(event\) => openExternalLink\(event, safeHref\)\}/, "Manager Markdown links must route clicks through the Electron openExternal bridge instead of a denied popup");
assert.match(markdownRenderer, /globalThis\.window\?\.codexpro\?\.openExternal[\s\S]*?event\.preventDefault\(\)/, "clickable response links must prevent the denied in-app navigation only when the external-link bridge exists");
assert.equal(manifest.version, "0.5.110", "completed network-stream fallback must be packaged in a reloadable extension version");
assert.match(managerMain, /const WORKER_EXTENSION_VERSION = "0\.5\.110";/, "Manager updater must require the worker version with completed network-stream fallback");
assert.match(managerMain, /\["http:", "https:", "mailto:"\][\s\S]*?shell\.openExternal/, "Manager external-link IPC must allow the same safe schemes rendered by response Markdown");

console.log("✓ Chat response link extraction/render smoke test passed");
