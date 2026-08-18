import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

async function waitForJson(url, init = {}, timeoutMs = 15000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, init);
      const body = await response.json();
      if (response.ok) return body;
      last = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

async function runCaptured(command, args, options = {}, timeoutMs = 30000) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return await new Promise((resolve) => {
    const timer = setTimeout(async () => {
      await stopChild(child);
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

async function readJsonRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function resolveOpenCodeCommand() {
  if (process.platform !== 'win32') return 'opencode';
  const found = spawnSync('where.exe', ['opencode'], { encoding: 'utf8' });
  const candidates = String(found.stdout ?? '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const npmDir = path.dirname(candidate);
    const exe = path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(exe)) return exe;
  }
  return candidates.find((item) => item.toLowerCase().endsWith('.exe')) ?? candidates[0] ?? 'opencode';
}

const opencodeCommand = resolveOpenCodeCommand();
const upstreamPort = await getFreePort();
const codexPort = await getFreePort();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-openai-root-'));
const openCodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-opencode-provider-'));
const apiToken = 'codexpro-openai-local-smoke-token-123456789';
const upstreamApiKey = 'upstream-local-smoke-key';
const upstreamRequests = [];

await fs.writeFile(path.join(root, 'fixture.txt'), 'openai compatible local smoke\n', 'utf8');

const upstreamServer = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  const body = await readJsonRequest(req);
  upstreamRequests.push({ body, authorization: req.headers.authorization ?? null });
  const created = Math.floor(Date.now() / 1000);
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const chunks = [
      { id: 'chatcmpl-codexpro-smoke', object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { id: 'chatcmpl-codexpro-smoke', object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: 'codexpro-openai-ok' }, finish_reason: null }] },
      { id: 'chatcmpl-codexpro-smoke', object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ];
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-codexpro-smoke',
    object: 'chat.completion',
    created,
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'codexpro-openai-ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }));
});
await new Promise((resolve, reject) => {
  upstreamServer.listen(upstreamPort, '127.0.0.1', resolve);
  upstreamServer.on('error', reject);
});

const codex = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(codexPort),
    CODEXPRO_HTTP_TOKEN: apiToken,
    CODEXPRO_BASH_MODE: 'off',
    CODEXPRO_WRITE_MODE: 'handoff',
    CODEXPRO_TOOL_MODE: 'standard',
    CODEXPRO_TOOL_CARDS: '0',
    CODEXPRO_OPENAI_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    CODEXPRO_OPENAI_UPSTREAM_API_KEY: upstreamApiKey,
    CODEXPRO_OPENAI_UPSTREAM_MODEL: 'upstream-sol-model'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let codexStderr = '';
codex.stderr.on('data', (chunk) => { codexStderr += String(chunk); });

try {
  const base = `http://127.0.0.1:${codexPort}`;
  await waitForJson(`${base}/v1/health`, { headers: { Authorization: `Bearer ${apiToken}` } });

  const models = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${apiToken}` } });
  const modelsBody = await models.json();
  if (models.status !== 200 || modelsBody.data?.length !== 1 || modelsBody.data[0]?.id !== 'gpt-5.6-sol') {
    throw new Error(`unexpected /v1/models response: ${models.status} ${JSON.stringify(modelsBody)}`);
  }

  const medium = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], stream: false })
  });
  const mediumBody = await medium.json();
  if (medium.status !== 200 || mediumBody.choices?.[0]?.message?.content !== 'codexpro-openai-ok') {
    throw new Error(`non-stream completion failed: ${medium.status} ${JSON.stringify(mediumBody)}`);
  }
  if (upstreamRequests.at(-1)?.body?.reasoning_effort !== 'medium' || upstreamRequests.at(-1)?.body?.model !== 'upstream-sol-model') {
    throw new Error(`default variant/model mapping failed: ${JSON.stringify(upstreamRequests.at(-1))}`);
  }
  if (upstreamRequests.at(-1)?.authorization !== `Bearer ${upstreamApiKey}`) {
    throw new Error('upstream Authorization bearer token was not forwarded');
  }

  const light = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      'x-codexpro-variant': 'light'
    },
    body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], stream: false })
  });
  await light.text();
  if (light.status !== 200 || upstreamRequests.at(-1)?.body?.reasoning_effort !== 'low') {
    throw new Error(`light variant mapping failed: ${light.status} ${JSON.stringify(upstreamRequests.at(-1))}`);
  }

  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      codexpro: {
        npm: '@ai-sdk/openai-compatible',
        name: 'CodexPro (local)',
        options: {
          baseURL: `${base}/v1`,
          apiKey: apiToken
        },
        models: {
          'gpt-5.6-sol': {
            name: 'GPT-5.6 Sol',
            variants: {
              light: { headers: { 'X-CodexPro-Variant': 'light' } },
              medium: { headers: { 'X-CodexPro-Variant': 'medium' } },
              high: { headers: { 'X-CodexPro-Variant': 'high' } }
            }
          }
        }
      }
    }
  };
  await fs.writeFile(path.join(openCodeDir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), 'utf8');

  const debug = spawnSync(opencodeCommand, ['debug', 'config'], { cwd: openCodeDir, encoding: 'utf8', timeout: 15000 });
  if (debug.status !== 0 || !debug.stdout.includes('CodexPro (local)') || !debug.stdout.includes('gpt-5.6-sol')) {
    throw new Error(`OpenCode did not resolve CodexPro provider config:\n${debug.stdout}\n${debug.stderr}`);
  }

  const run = await runCaptured(
    opencodeCommand,
    ['run', '--format', 'json', '--model', 'codexpro/gpt-5.6-sol', '--variant', 'high', 'Reply with the model output only.'],
    { cwd: openCodeDir },
    30000
  );
  if (run.status !== 0 || !run.stdout.includes('codexpro-openai-ok')) {
    throw new Error(`OpenCode provider chat failed (timedOut=${run.timedOut}):\n${run.stdout}\n${run.stderr}\nupstream=${JSON.stringify(upstreamRequests)}`);
  }
  if (upstreamRequests.at(-1)?.body?.reasoning_effort !== 'high') {
    throw new Error(`OpenCode High variant did not map to upstream high reasoning: ${JSON.stringify(upstreamRequests.at(-1))}`);
  }

  console.log('✓ OpenAI-compatible CodexPro + OpenCode provider smoke test passed');
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}${codexStderr ? `\nCodexPro:\n${codexStderr}` : ''}`);
} finally {
  await stopChild(codex);
  await new Promise((resolve) => upstreamServer.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(openCodeDir, { recursive: true, force: true });
}
