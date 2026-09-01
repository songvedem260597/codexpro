import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({ root: managerRoot, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });

try {
  const { ResponseText, partitionStreamingMarkdown } = await vite.ssrLoadModule("/src/response-markdown.jsx");
  assert.equal(typeof partitionStreamingMarkdown, "function", "streaming Markdown must expose an append-aware partition helper");
  const fixture = `# Heading

**bold** *italic* ~~strike~~ \`inline\` https://example.com

> quote

- parent
  - nested
- [x] done
- [ ] todo

1. first
2. second

| Name | State |
| --- | ---: |
| CodexPro | **OK** |

---

\`\`\`js
console.log("code");
\`\`\`

Inline math $E = mc^2$.

$$\\int_0^1 x^2 dx = \\frac{1}{3}$$

[unsafe](javascript:alert(1))

<script>alert("raw html")</script>`;

  const html = renderToStaticMarkup(React.createElement(ResponseText, { text: fixture, truncated: true }));
  const required = [
    "<h1", "<strong", "<em", "<del", "response-inline-code", "response-code-block",
    "<blockquote", "<ul", "<ol", "type=\"checkbox\"", "<table", "<thead", "<tbody",
    "response-rule", "target=\"_blank\"", "katex", "Đã rút gọn khi hiển thị"
  ];
  for (const marker of required) assert.ok(html.includes(marker), `missing rendered marker: ${marker}`);
  assert.ok(!html.includes("javascript:alert"), "unsafe javascript link leaked into rendered HTML");
  assert.ok(!html.includes("<script"), "raw script HTML was rendered");

  const streamingBase = `# Stable heading\n\nFirst settled paragraph.\n\nSecond settled paragraph.\n\nLive tail`;
  const firstPartition = partitionStreamingMarkdown(streamingBase, { mutableBlocks: 2 });
  const secondPartition = partitionStreamingMarkdown(`${streamingBase} keeps growing`, { mutableBlocks: 2 });
  assert.deepEqual(
    secondPartition.frozen.map((block) => ({ key: block.key, text: block.text })),
    firstPartition.frozen.map((block) => ({ key: block.key, text: block.text })),
    "append-only growth must retain stable source keys for frozen Markdown blocks"
  );
  assert.equal(secondPartition.tail.text.endsWith("Live tail keeps growing"), true, "only the live Markdown tail should absorb appended text");

  const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");
  assert.match(styles, /\.chat-message-text\.response-rich-text \{ line-height: 1\.72; \}/, "long responses must use a relaxed reading line-height");
  assert.match(styles, /\.response-rich-text \{ max-width: min\(100%, 1060px\)/, "long responses must cap prose width for readable line length");
  assert.doesNotMatch(styles, /\.response-rich-text p:last-child \{ margin-bottom: 0; \}/, "streaming Markdown wrappers must not collapse paragraph spacing at every frozen block boundary");
  assert.match(styles, /\.response-markdown-tail:last-child > p:last-child \{ margin-bottom: 0; \}/, "only the final streaming paragraph should drop trailing paragraph space");
  console.log("✓ ChatGPT rich response Markdown/GFM/math smoke test passed");
} finally {
  await vite.close();
}
