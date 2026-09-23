const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');

const installer = readFileSync(path.resolve(__dirname, '../../chrome-extension/connector-installer.js'), 'utf8');

async function check(win, html) {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win.webContents.executeJavaScript(`(async () => {
    window.chrome = {runtime: {onMessage: {addListener: callback => { window.__connectorListener = callback; }}}};
    ${installer}
    return new Promise(resolve => window.__connectorListener({type: 'codexpro-check-connector'}, {}, resolve));
  })()`, true);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false, webPreferences: {offscreen: true}});
  try {
    const card = await check(win, `<!doctype html><html><body><main>
      <input id="plugin-search" value="CodexPro">
      <button aria-label="Create app">Create app</button>
      <article class="plugin-card"><a href="/plugins/plugin_existing" aria-label="Open CodexPro"></a><span>CodexPro</span><button aria-label="More">...</button></article>
    </main></body></html>`);
    assert.equal(card.installed, true, 'a card with a CodexPro span and separate action button is installed');
    assert.equal(card.definition_state, 'installed');

    const unknown = await check(win, `<!doctype html><html><body>
      <input id="plugin-search" value="CodexPro">
      <button aria-label="Create app">Create app</button>
      <div>Loading plugins...</div>
    </body></html>`);
    assert.equal(unknown.definition_state, 'inconclusive', 'Create app and search input alone cannot prove absence');
    assert.equal(unknown.installed, false);

    const absent = await check(win, `<!doctype html><html><body><main>
      <input id="plugin-search" value="CodexPro"><button aria-label="Create app">Create app</button>
      <section><div>No plugins match that search right now.</div></section>
    </main></body></html>`);
    assert.equal(absent.definition_state, 'absent', 'explicit empty search result proves absence');

    const unrelated = await check(win, `<!doctype html><html><body>
      <button>CodexPro conversation</button><main><input id="plugin-search" value="CodexPro">
      <section><div>No plugins match that search right now.</div></section></main>
    </body></html>`);
    assert.equal(unrelated.definition_state, 'absent', 'a CodexPro button outside the plugin list is not an installed definition');
    console.log('connector verification DOM smoke passed');
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
