import http from "node:http";
import { getSharedBrowserAutomation } from "../dist/browserOps.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const html = `<!doctype html>
<html>
  <head><title>CodexPro Browser Smoke</title></head>
  <body>
    <label>Name <input id="name" placeholder="Name"></label>
    <label>Theme
      <select id="theme">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
    <button id="apply">Apply</button>
    <div id="result">idle</div>
    <script>
      document.querySelector("#apply").addEventListener("click", () => {
        document.querySelector("#result").textContent =
          document.querySelector("#name").value + "-" + document.querySelector("#theme").value;
      });
    </script>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const browser = getSharedBrowserAutomation();
const reconnectedBrowser = getSharedBrowserAutomation();

try {
  const opened = await browser.open(`http://127.0.0.1:${port}`);
  assert(opened.title === "CodexPro Browser Smoke", "browser_open did not return the test page");
  assert(opened.elements.length === 3, "browser_snapshot did not expose the expected interactive elements");
  assert(reconnectedBrowser === browser, "browser state is not shared across MCP server wrappers");

  await reconnectedBrowser.type({ selector: "#name", value: "codexpro" });
  await browser.select({ selector: "#theme", value: "dark" });
  const clicked = await reconnectedBrowser.click({ selector: "#apply" });
  assert(clicked.text.includes("codexpro-dark"), "browser actions did not update the rendered page");

  const screenshot = await browser.screenshot();
  assert(screenshot.data.length > 1_000, "browser_screenshot returned an unexpectedly small PNG");

  for (const blockedUrl of ["http://192.168.1.1", "http://[::ffff:c0a8:101]", "http://[64:ff9b::c0a8:101]"]) {
    let privateNetworkBlocked = false;
    try {
      await browser.open(blockedUrl);
    } catch {
      privateNetworkBlocked = true;
    }
    assert(privateNetworkBlocked, `browser network guard allowed private destination ${blockedUrl}`);
  }

  console.log("browser smoke passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
