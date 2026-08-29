import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({ root: managerRoot, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true } });

try {
  const { ResponseText } = await vite.ssrLoadModule("/src/response-markdown.jsx");
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
  console.log("✓ ChatGPT rich response Markdown/GFM/math smoke test passed");
} finally {
  await vite.close();
}
