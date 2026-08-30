import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15000);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout waiting for process exit\n${stderr}`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

async function waitForHealthJson(url, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${url}\n${lastError}`);
}

async function expectHttpTokenRequired(name, overrides = {}, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `codexpro-http-no-token-${name}-`));
  const port = await getFreePort();
  const env = {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'handoff',
    ...overrides
  };
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  if (!options.keepAllowNoToken) delete env.CODEXPRO_ALLOW_NO_HTTP_TOKEN;

  const child = spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await waitForExit(child);
  if (result.code === 0) {
    throw new Error(`expected ${name} HTTP server without token to fail closed`);
  }
  if (!result.stderr.includes('CODEXPRO_HTTP_TOKEN is required')) {
    throw new Error(`expected ${name} missing-token failure, got:\n${result.stderr}`);
  }
}

async function expectWeakHttpTokenRejected() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-weak-token-'));
  const port = await getFreePort();
  const child = spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_HOST: '127.0.0.1',
      CODEXPRO_PORT: String(port),
      CODEXPRO_HTTP_TOKEN: 'short-token'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await waitForExit(child);
  if (result.code === 0 || !result.stderr.includes('CODEXPRO_HTTP_TOKEN must be at least 24 bytes')) {
    throw new Error(`expected weak HTTP token startup to fail closed, got:\n${result.stderr}`);
  }
}

async function listTools(url, token) {
  const client = new Client({ name: 'codexpro-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close();
  }
}

async function expectActiveSessionPreservedUnderCapacityPressure() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-active-session-'));
  const codexProHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-gate-home-'));
  const taskRoot = path.join(root, 'task-workspace');
  await fs.mkdir(taskRoot, { recursive: true });
  await fs.writeFile(path.join(taskRoot, 'gate.txt'), 'gate initial\n', 'utf8');
  const port = await getFreePort();
  const token = 'codexpro-http-active-session-smoke-token';
  const child = spawn(process.execPath, ['dist/http.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_HOST: '127.0.0.1',
      CODEXPRO_PORT: String(port),
      CODEXPRO_HTTP_TOKEN: token,
      CODEXPRO_BASH_MODE: 'full',
      CODEXPRO_WRITE_MODE: 'workspace',
      CODEXPRO_MAX_HTTP_SESSIONS: '3',
      CODEXPRO_HOME: codexProHome
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const clients = [];
  try {
    await waitForListening(child);
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const createClient = async (name, profileId = '') => {
      const client = new Client({ name, version: '0.0.0' });
      const clientUrl = new URL(url);
      if (profileId) clientUrl.searchParams.set('codexpro_profile', profileId);
      const transport = new StreamableHTTPClientTransport(clientUrl, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    };

    const manager = await createClient('repo-task-manager');
    const gated = await createClient('repo-task-gate', 'gate-smoke');
    const gatedSibling = await createClient('repo-task-gate-sibling', 'gate-smoke');
    const direct = await createClient('repo-task-direct-chatgpt', 'direct-smoke');
    const directBegan = await callTool(direct, 'begin_repo_task', { task_title: 'Inspect direct request' });
    if (!directBegan.structuredContent.verified || !/^cpt_[a-f0-9]{24}$/.test(String(directBegan.structuredContent.task_id || ''))) {
      throw new Error(`direct profile task did not receive a server-generated id: ${JSON.stringify(directBegan.structuredContent)}`);
    }
    if (directBegan.structuredContent.task_title !== 'Inspect direct request' || directBegan.structuredContent.task_source !== 'chatgpt_direct') {
      throw new Error(`direct profile task did not preserve the AI title/source: ${JSON.stringify(directBegan.structuredContent)}`);
    }
    if (directBegan.structuredContent.task_title_requested_by !== 'mcp_server' || directBegan.structuredContent.task_title_returned_by !== 'ai') {
      throw new Error(`direct profile task did not identify who requested/returned the title: ${JSON.stringify(directBegan.structuredContent)}`);
    }
    const directRead = await callTool(direct, 'read', { path: 'task-workspace/gate.txt' });
    if (!directRead.structuredContent.text.includes('gate initial')) throw new Error('direct profile task remained blocked after begin_repo_task');
    await direct.close();
    clients.splice(clients.indexOf(direct), 1);
    const actions = await callTool(gated, 'codexpro', { action: 'list_actions' });
    const actionNames = Array.isArray(actions?.structuredContent?.actions) ? actions.structuredContent.actions : [];
    if (actionNames.includes('prepare_repo_task')) throw new Error('gated ChatGPT session must not expose prepare_repo_task');
    await expectToolErrorCode(gated, 'read', { path: 'gate.txt' }, 'BEGIN_REPO_TASK_REQUIRED');
    await expectToolErrorCode(gated, 'begin_repo_task', { task_id: 'cpt_aaaaaaaaaaaaaaaaaaaaaaaa', task_title: 'Verify repo gate', root: taskRoot, scope: 'workspace' }, 'REPO_TASK_NOT_PREPARED');

    const preparedA = await callTool(manager, 'prepare_repo_task', {
      profile_id: 'gate-smoke',
      task_id: 'cpt_aaaaaaaaaaaaaaaaaaaaaaaa',
      root: taskRoot,
      scope: 'workspace'
    });
    if (!preparedA.structuredContent.prepared) throw new Error('manager could not prepare repo task A');
    await expectToolErrorCode(gatedSibling, 'read', { path: 'gate.txt' }, 'BEGIN_REPO_TASK_REQUIRED');
    for (const action of actionNames) {
      if (action === 'begin_repo_task' || action === 'repo_task_status') continue;
      await expectToolErrorCode(gated, 'codexpro', { action, args: {} }, 'BEGIN_REPO_TASK_REQUIRED');
    }
    await expectToolErrorCode(gated, 'edit', { path: 'gate.txt', old_text: 'gate initial', new_text: 'gate changed' }, 'BEGIN_REPO_TASK_REQUIRED');
    await expectToolErrorCode(gated, 'bash', { command: 'node -e "console.log(\'blocked\')"' }, 'BEGIN_REPO_TASK_REQUIRED');
    await expectToolErrorCode(gated, 'codexpro', { action: 'read', args: { path: 'gate.txt' } }, 'BEGIN_REPO_TASK_REQUIRED');
    await expectToolErrorCode(gated, 'begin_repo_task', { task_id: 'cpt_cccccccccccccccccccccccc', task_title: 'Wrong repo task', root: taskRoot, scope: 'workspace' }, 'REPO_TASK_MISMATCH');
    const missingProof = await callTool(gated, 'repo_task_status', { task_id: 'cpt_000000000000000000000000' });
    if (missingProof.structuredContent.verified !== false) throw new Error('repo_task_status must remain available before begin_repo_task');

    const began = await callTool(gated, 'codexpro', {
      action: 'begin_repo_task',
      args: { task_id: 'cpt_aaaaaaaaaaaaaaaaaaaaaaaa', task_title: 'Verify repo gate', root: taskRoot, scope: 'workspace' }
    });
    if (!began.structuredContent.verified || !began.structuredContent.global_rules_sha256) {
      throw new Error(`begin_repo_task did not activate the gated MCP session: ${JSON.stringify(began.structuredContent)}`);
    }
    const siblingStatus = await callTool(gatedSibling, 'repo_task_status', { task_id: 'cpt_aaaaaaaaaaaaaaaaaaaaaaaa' });
    if (!siblingStatus.structuredContent.verified || !siblingStatus.structuredContent.gate_active) {
      throw new Error(`profile sibling did not observe the active repo task: ${JSON.stringify(siblingStatus.structuredContent)}`);
    }
    const siblingRead = await callTool(gatedSibling, 'read', { path: 'gate.txt' });
    if (!siblingRead.structuredContent.text.includes('gate initial')) throw new Error('sibling MCP session remained blocked after profile task activation');
    if (began.structuredContent.task_title !== 'Verify repo gate') throw new Error('begin_repo_task did not preserve the AI-generated task title');
    if (began.structuredContent.task_title_source !== 'ai') throw new Error('begin_repo_task did not identify the AI as the task title source');
    const titledProof = await callTool(gated, 'repo_task_status', { task_id: 'cpt_aaaaaaaaaaaaaaaaaaaaaaaa' });
    if (titledProof.structuredContent.task_title !== 'Verify repo gate') throw new Error('repo_task_status did not return the AI-generated task title');
    if (titledProof.structuredContent.task_title_source !== 'ai') throw new Error('repo_task_status did not identify the AI task title source');
    const persistedProfileTasks = JSON.parse(await fs.readFile(path.join(codexProHome, 'browser-profile-tasks.json'), 'utf8'));
    const persistedProfileTask = persistedProfileTasks?.profiles?.['gate-smoke'];
    if (persistedProfileTask?.task_id !== 'cpt_aaaaaaaaaaaaaaaaaaaaaaaa' || persistedProfileTask?.task_title !== 'Verify repo gate') {
      throw new Error(`AI task title was not persisted for Manager restart recovery: ${JSON.stringify(persistedProfileTasks)}`);
    }
    const taskEvents = (await fs.readFile(path.join(codexProHome, 'profile-task-events.jsonl'), 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    if (!taskEvents.some((event) => event.event === 'mcp_session_initialized' && event.profile_id === 'direct-smoke' && event.profile_bound === true)) {
      throw new Error(`profile-bound MCP session initialization was not logged: ${JSON.stringify(taskEvents)}`);
    }
    if (!taskEvents.some((event) => event.event === 'repo_task_started' && event.profile_id === 'direct-smoke' && event.task_source === 'chatgpt_direct' && event.task_title_returned_by === 'ai')) {
      throw new Error(`direct AI task title was not logged: ${JSON.stringify(taskEvents)}`);
    }
    const gatedSelfTest = await callTool(gated, 'codexpro_self_test', {
      write_probe: false,
      bash_probe: false,
      pro_context_probe: false,
      include_global_skills: false
    });
    if (gatedSelfTest.structuredContent.status === 'fail') {
      throw new Error(`gated codexpro_self_test failed: ${JSON.stringify(gatedSelfTest.structuredContent)}`);
    }
    if (gatedSelfTest.structuredContent.expected_tools?.includes?.('prepare_repo_task')) {
      throw new Error('gated codexpro_self_test must exclude prepare_repo_task from its expected tool set');
    }
    if (JSON.stringify([...(gatedSelfTest.structuredContent.expected_tools ?? [])].sort()) !== JSON.stringify([...(gatedSelfTest.structuredContent.registered_tools ?? [])].sort())) {
      throw new Error(`gated codexpro_self_test expected/registered tools mismatch: ${JSON.stringify(gatedSelfTest.structuredContent)}`);
    }
    const activeRead = await callTool(gated, 'read', { path: 'gate.txt' });
    if (!activeRead.structuredContent.text.includes('gate initial')) throw new Error('read remained blocked after begin_repo_task');
    await callTool(gated, 'edit', { path: 'gate.txt', old_text: 'gate initial', new_text: 'gate changed' });
    const activeBash = await callTool(gated, 'bash', { command: 'node -e "console.log(\'active\')"' });
    if (!String(activeBash.structuredContent.stdout || '').includes('active')) throw new Error('bash did not run after begin_repo_task');

    const preparedB = await callTool(manager, 'prepare_repo_task', {
      profile_id: 'gate-smoke',
      task_id: 'cpt_bbbbbbbbbbbbbbbbbbbbbbbb',
      task_title: 'Replace repo task',
      root: taskRoot,
      scope: 'workspace'
    });
    if (!preparedB.structuredContent.prepared) throw new Error('manager could not prepare repo task B');
    await expectToolErrorCode(gated, 'read', { path: 'gate.txt' }, 'BEGIN_REPO_TASK_REQUIRED');
    await expectToolErrorCode(gatedSibling, 'read', { path: 'gate.txt' }, 'BEGIN_REPO_TASK_REQUIRED');
    const beganB = await callTool(gated, 'begin_repo_task', {
      task_id: 'cpt_bbbbbbbbbbbbbbbbbbbbbbbb',
      task_title: 'Replace repo task',
      root: taskRoot,
      scope: 'workspace'
    });
    if (!beganB.structuredContent.verified) throw new Error('new Manager task did not invalidate and replace the previous active task');
    const siblingReadB = await callTool(gatedSibling, 'read', { path: 'gate.txt' });
    if (!siblingReadB.structuredContent.text.includes('gate changed')) throw new Error('sibling MCP session did not adopt replacement profile task');

    await fs.writeFile(path.join(codexProHome, 'CODEXPRO.md'), '# changed during task\n- require fresh begin\n', 'utf8');
    await expectToolErrorCode(gated, 'read', { path: 'gate.txt' }, 'BEGIN_REPO_TASK_RULES_CHANGED');
    const siblingInvalidStatus = await callTool(gatedSibling, 'repo_task_status', { task_id: 'cpt_bbbbbbbbbbbbbbbbbbbbbbbb' });
    if (siblingInvalidStatus.structuredContent.verified !== false || siblingInvalidStatus.structuredContent.gate_active !== false) {
      throw new Error(`repo_task_status stayed verified after the shared profile gate was invalidated: ${JSON.stringify(siblingInvalidStatus.structuredContent)}`);
    }
    const reactivated = await callTool(gated, 'begin_repo_task', {
      task_id: 'cpt_bbbbbbbbbbbbbbbbbbbbbbbb',
      task_title: 'Replace repo task',
      root: taskRoot,
      scope: 'workspace'
    });
    if (!reactivated.structuredContent.verified) throw new Error('begin_repo_task did not reactivate after global rules changed');
    const changedRead = await callTool(gated, 'read', { path: 'gate.txt' });
    if (!changedRead.structuredContent.text.includes('gate changed')) throw new Error('gated session did not resume after re-begin');
    const siblingChangedRead = await callTool(gatedSibling, 'read', { path: 'gate.txt' });
    if (!siblingChangedRead.structuredContent.text.includes('gate changed')) throw new Error('sibling MCP session did not resume after shared gate reactivation');
    await gated.close();
    clients.splice(clients.indexOf(gated), 1);

    const gatedAgain = await createClient('repo-task-gate-new-session', 'gate-smoke');
    const resumedRead = await callTool(gatedAgain, 'read', { path: 'gate.txt' });
    if (!resumedRead.structuredContent.text.includes('gate changed')) throw new Error('new MCP session did not adopt the active profile task');
    await gatedAgain.close();
    clients.splice(clients.indexOf(gatedAgain), 1);
    await gatedSibling.close();
    clients.splice(clients.indexOf(gatedSibling), 1);
    await manager.close();
    clients.splice(clients.indexOf(manager), 1);

    const primary = await createClient('active-session-primary');
    const longCall = callTool(primary, 'bash', { command: 'node -e "setTimeout(()=>console.log(\'active-ok\'),2500)"' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (let index = 0; index < 5; index += 1) await createClient(`active-session-pressure-${index}`);
    await longCall;
    const tools = await primary.listTools();
    if (!tools.tools.length) throw new Error('active MCP session disappeared after capacity pressure');
  } finally {
    for (const client of clients.reverse()) await client.close().catch(() => {});
    child.kill('SIGTERM');
    await waitForExit(child).catch(() => {});
  }
}

function toolNames(tools) {
  return tools.map((tool) => tool.name);
}

function hasWidgetMeta(tools, name, uri) {
  const tool = tools.find((item) => item.name === name);
  const meta = tool?._meta ?? {};
  return meta.ui?.resourceUri === uri && meta['openai/outputTemplate'] === uri;
}

function hasToolCardStatusMeta(tools, name) {
  const tool = tools.find((item) => item.name === name);
  const meta = tool?._meta ?? {};
  return Boolean(meta['openai/toolInvocation/invoking'] || meta['openai/toolInvocation/invoked']);
}

await expectHttpTokenRequired('loopback-default');
await expectHttpTokenRequired('non-loopback', { CODEXPRO_HOST: '0.0.0.0' });
await expectHttpTokenRequired('non-loopback-allow-no-token', { CODEXPRO_HOST: '0.0.0.0', CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1' }, { keepAllowNoToken: true });
await expectHttpTokenRequired('tunnel-mode', { CODEXPRO_TUNNEL_MODE: '1' });
await expectWeakHttpTokenRejected();
await expectActiveSessionPreservedUnderCapacityPressure();

async function withClient(url, fn) {
  const client = new Client({ name: 'codexpro-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    return await fn(client, transport);
  } finally {
    await client.close();
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${text}`);
  }
  return result;
}

async function expectToolErrorCode(client, name, args, expectedCode) {
  const result = await client.callTool({ name, arguments: args });
  const actualCode = String(result?.structuredContent?.error?.code || '');
  if (!result?.isError || actualCode !== expectedCode) {
    throw new Error(`expected ${name} to fail with ${expectedCode}, got ${actualCode || 'no-code'} ${JSON.stringify(result?.structuredContent)}`);
  }
  return result;
}

async function expectSessionNotFound(response, label) {
  const body = await response.json();
  if (
    response.status !== 404 ||
    !response.headers.get('content-type')?.includes('application/json') ||
    body.error?.code !== -32001 ||
    body.error?.message !== 'Session not found'
  ) {
    throw new Error(`expected ${label} to return JSON-RPC session-not-found 404, got ${response.status} ${JSON.stringify(body)}`);
  }
}

function postToolsListWithSession(baseUrl, token, sessionId) {
  return fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 404, method: 'tools/list', params: {} })
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-smoke-'));
const alternateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-alternate-'));
await fs.writeFile(path.join(alternateRoot, 'selected.txt'), 'http alternate workspace\n', 'utf8');
const nestedRoot = path.join(root, 'nested-project');
await fs.mkdir(nestedRoot, { recursive: true });
await fs.writeFile(path.join(nestedRoot, 'nested.txt'), 'http nested workspace\n', 'utf8');
const profileHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-profile-home-'));
await fs.mkdir(path.join(root, '.codex', 'skills', 'http-smoke-skill'), { recursive: true });
await fs.writeFile(path.join(root, '.codex', 'skills', 'http-smoke-skill', 'SKILL.md'), [
  '---',
  'name: http-smoke-skill',
  'description: HTTP smoke test skill discovery.',
  '---',
  '',
  '# HTTP Smoke Skill',
  ''
].join('\n'), 'utf8');
await fs.writeFile(path.join(root, 'session-checkpoint.txt'), 'checkpoint initial\n', 'utf8');
for (const args of [
  ['init'],
  ['add', '.codex/skills/http-smoke-skill/SKILL.md', 'session-checkpoint.txt'],
  ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke Test', 'commit', '-m', 'http smoke fixture']
]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}
await fs.writeFile(path.join(root, 'session-checkpoint.txt'), 'checkpoint changed\n', 'utf8');
const port = await getFreePort();
const genericPort = await getFreePort();
const token = 'codexpro-http-smoke-token';
const runtimeQuerySecret = 'runtimequerysecret1234567890';
const runtimeAccessSecret = 'runtimeaccesssecret1234567890';
const runtimeCloudflareSecret = 'eyJhbGciOiJIUzI1NiJ9.eyJ0dW5uZWwiOiJodHRwLXNtb2tlIn0.signature1234567890';
const staleCloudflareToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ0dW5uZWwiOiJzdGFsZS1odHRwLXNtb2tlIn0.signature1234567890';
const runtimeId = createHash('sha256').update(root).digest('hex').slice(0, 24);
const realAlternateRoot = await fs.realpath(alternateRoot);
await fs.mkdir(path.join(profileHome, 'runtime'), { recursive: true });
await fs.writeFile(path.join(profileHome, 'runtime', `${runtimeId}.json`), JSON.stringify({
  version: 1,
  root,
  endpoint: `https://runtime.example/mcp?token=${runtimeQuerySecret}`,
  localStatusUrl: `http://127.0.0.1:${port}/?codexpro_token=${token}&access_token=${runtimeAccessSecret}`,
  note: `cloudflared tunnel run --token ${runtimeCloudflareSecret}`
}, null, 2), 'utf8');
const child = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    HOST: '0.0.0.0',
    PORT: String(genericPort),
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: [root, alternateRoot].join(path.delimiter),
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'handoff',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_TOOL_CARDS: '0',
    CODEXPRO_WIDGET_DOMAIN: 'https://widgets.codexpro.test',
    CODEXPRO_HOME: profileHome
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForListening(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const unauthorized = await fetch(`${baseUrl}/healthz`);
  if (unauthorized.status !== 401) {
    throw new Error(`expected unauthenticated healthz to return 401, got ${unauthorized.status}`);
  }

  const authorized = await fetch(`${baseUrl}/healthz`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (authorized.status !== 200) {
    throw new Error(`expected authenticated healthz to return 200, got ${authorized.status}`);
  }
  const authorizedJson = await authorized.json();
  if (authorizedJson.authRequired !== true) {
    throw new Error(`expected authenticated healthz to report authRequired=true, got ${JSON.stringify(authorizedJson)}`);
  }

  for (const header of [`bearer ${token}`, `Bearer    ${token}`]) {
    const variant = await fetch(`${baseUrl}/healthz`, {
      headers: { Authorization: header }
    });
    if (variant.status !== 200) {
      throw new Error(`expected authorization header variant ${JSON.stringify(header)} to return 200, got ${variant.status}`);
    }
  }

  const queryAuthorized = await fetch(`${baseUrl}/healthz?codexpro_token=${encodeURIComponent(token)}`);
  if (queryAuthorized.status !== 200) {
    throw new Error(`expected URL-token healthz to return 200, got ${queryAuthorized.status}`);
  }

  let throttled;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    throttled = await fetch(`${baseUrl}/healthz?codexpro_token=wrong-token-${attempt}`);
    if (throttled.status === 429) break;
  }
  if (throttled?.status !== 429 || !throttled.headers.get('retry-after')) {
    throw new Error(`expected repeated failed authentication to return 429 with Retry-After, got ${throttled?.status}`);
  }
  const validAfterThrottle = await fetch(`${baseUrl}/healthz`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (validAfterThrottle.status !== 200) {
    throw new Error(`authentication throttling blocked a valid token, got ${validAfterThrottle.status}`);
  }

  const badAdminJson = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"tunnel":'
  });
  const badAdminBody = await badAdminJson.json();
  if (badAdminJson.status !== 400 || badAdminBody.error?.code !== 'invalid_json') {
    throw new Error(`expected invalid admin JSON to return structured 400, got ${badAdminJson.status} ${JSON.stringify(badAdminBody)}`);
  }

  const badMcpJson = await fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":'
  });
  const badMcpBody = await badMcpJson.json();
  if (badMcpJson.status !== 400 || badMcpBody.error?.code !== -32700) {
    throw new Error(`expected invalid MCP JSON to return JSON-RPC parse error, got ${badMcpJson.status} ${JSON.stringify(badMcpBody)}`);
  }

  const hugeMcpJson = await fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { filler: 'x'.repeat(21 * 1024 * 1024) } })
  });
  const hugeMcpBody = await hugeMcpJson.json();
  if (hugeMcpJson.status !== 413 || hugeMcpBody.error?.code !== -32000) {
    throw new Error(`expected oversized MCP body to return JSON-RPC payload error, got ${hugeMcpJson.status} ${JSON.stringify(hugeMcpBody)}`);
  }

  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  if (favicon.status !== 200 || !favicon.headers.get('content-type')?.includes('image/svg+xml')) {
    throw new Error(`expected unauthenticated favicon to return SVG 200, got ${favicon.status} ${favicon.headers.get('content-type')}`);
  }

  const home = await fetch(`${baseUrl}/?codexpro_token=${encodeURIComponent(token)}`);
  const homeText = await home.text();
  if (home.status !== 200 || !home.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`expected authenticated onboarding page to return HTML 200, got ${home.status}`);
  }
  if (
    home.headers.get('cache-control') !== 'no-store' ||
    home.headers.get('referrer-policy') !== 'no-referrer' ||
    home.headers.get('x-content-type-options') !== 'nosniff'
  ) {
    throw new Error('authenticated onboarding page did not set no-store, no-referrer, and nosniff headers');
  }
  if (!homeText.includes('CodexPro Local Control') || !homeText.includes('CLI controls') || !homeText.includes('Connect ChatGPT') || !homeText.includes('Runtime guardrails')) {
    throw new Error('onboarding page did not include expected admin setup copy');
  }
  if (!homeText.includes('Connection profile') || !homeText.includes('data-profile-form')) {
    throw new Error('onboarding page did not include the saved profile editor');
  }
  if (!homeText.includes('history.replaceState') || !homeText.includes('initialUrl.searchParams.delete("codexpro_token")')) {
    throw new Error('onboarding page did not remove query credentials from browser history');
  }
  for (const fieldName of ['tunnelName', 'ngrokConfig', 'cloudflareConfig', 'cloudflareTokenFile', 'toolCards', 'noInstallCloudflared']) {
    if (!homeText.includes(`name="${fieldName}"`)) {
      throw new Error(`onboarding page did not include profile field ${fieldName}`);
    }
  }
  if (homeText.includes(token)) {
    throw new Error('onboarding page leaked the raw auth token');
  }
  for (const leaked of [runtimeQuerySecret, runtimeAccessSecret, runtimeCloudflareSecret]) {
    if (homeText.includes(leaked)) throw new Error(`onboarding page leaked runtime secret: ${leaked}`);
  }

  const profileBefore = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`);
  const profileBeforeJson = await profileBefore.json();
  if (profileBefore.status !== 200 || profileBeforeJson.exists !== false) {
    throw new Error(`expected empty admin profile response, got ${profileBefore.status} ${JSON.stringify(profileBeforeJson)}`);
  }
  if (JSON.stringify(profileBeforeJson).includes(token)) {
    throw new Error('admin profile GET leaked the raw auth token');
  }
  for (const leaked of [runtimeQuerySecret, runtimeAccessSecret, runtimeCloudflareSecret]) {
    if (JSON.stringify(profileBeforeJson).includes(leaked)) throw new Error(`admin profile GET leaked runtime secret: ${leaked}`);
  }

  const invalidProfile = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tunnel: 'ngrok',
      hostname: 'codexpro-http-smoke.ngrok-free.app',
      requireBashSession: true,
      bashSession: ''
    })
  });
  if (invalidProfile.status !== 400) {
    throw new Error(`expected invalid guarded profile to return 400, got ${invalidProfile.status}`);
  }
  await fs.mkdir(path.join(profileHome, 'profiles'), { recursive: true });
  await fs.writeFile(path.join(profileHome, 'profiles', `${runtimeId}.json`), JSON.stringify({
    version: 1,
    root,
    tunnel: 'cloudflare-named',
    hostname: 'stale.example.com',
    cloudflareToken: staleCloudflareToken,
    cloudflareTokenFile: path.join(root, 'stale-cloudflare-token')
  }, null, 2), 'utf8');

  const profileSave = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tunnel: 'ngrok',
      hostname: 'https://codexpro-http-smoke.ngrok-free.app/mcp',
      port,
      mode: 'agent',
      bash: 'safe',
      bashTranscript: 'full',
      codexSessions: 'metadata',
      codexDir: path.join(root, '.codex'),
      bashSession: 'http-main',
      requireBashSession: true,
      write: 'workspace',
      toolMode: 'full',
      toolCards: true,
      widgetDomain: 'https://widgets.codexpro.test',
      ngrokConfig: path.join(root, 'ngrok.yml'),
      cloudflareTokenFile: 'cloudflare-token',
      noInstallCloudflared: true
    })
  });
  const profileSaveJson = await profileSave.json();
  if (profileSave.status !== 200 || profileSaveJson.saved !== true) {
    throw new Error(`expected admin profile save to pass, got ${profileSave.status} ${JSON.stringify(profileSaveJson)}`);
  }
  if (JSON.stringify(profileSaveJson).includes(token)) {
    throw new Error('admin profile save response leaked the raw auth token');
  }
  const savedProfile = JSON.parse(await fs.readFile(profileSaveJson.profile_path, 'utf8'));
  if (
    savedProfile.tunnel !== 'ngrok' ||
    savedProfile.hostname !== 'codexpro-http-smoke.ngrok-free.app' ||
    savedProfile.bashTranscript !== 'full' ||
    savedProfile.codexSessions !== 'metadata' ||
    savedProfile.bashSession !== 'http-main' ||
    savedProfile.requireBashSession !== true ||
    savedProfile.toolCards !== true ||
    savedProfile.ngrokConfig !== path.join(root, 'ngrok.yml') ||
    savedProfile.noInstallCloudflared !== true ||
    savedProfile.token !== token
  ) {
    throw new Error(`admin profile save wrote unexpected profile: ${JSON.stringify(savedProfile)}`);
  }
  if (savedProfile.cloudflareToken || savedProfile.cloudflareTokenFile) {
    throw new Error(`admin profile save kept cloudflare token config on ngrok profile: ${JSON.stringify(savedProfile)}`);
  }
  await fs.writeFile(profileSaveJson.profile_path, JSON.stringify({
    ...savedProfile,
    allowedRoots: [realAlternateRoot]
  }, null, 2), 'utf8');

  const localProfile = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tunnel: 'none' })
  });
  const localProfileJson = await localProfile.json();
  const localSavedProfile = JSON.parse(await fs.readFile(localProfileJson.profile_path, 'utf8'));
  if (
    localProfile.status !== 200 ||
    localSavedProfile.hostname ||
    localSavedProfile.ngrokConfig ||
    localSavedProfile.tunnelName ||
    localSavedProfile.cloudflareConfig ||
    localSavedProfile.cloudflareToken ||
    localSavedProfile.cloudflareTokenFile ||
    JSON.stringify(localSavedProfile.allowedRoots) !== JSON.stringify([realAlternateRoot]) ||
    localProfileJson.profile?.hostname ||
    localProfileJson.profile?.ngrokConfig ||
    localProfileJson.profile?.cloudflareToken ||
    localProfileJson.profile?.cloudflareTokenFile ||
    localProfileJson.effective?.hostname ||
    localProfileJson.effective?.ngrokConfig ||
    localProfileJson.effective?.cloudflareToken ||
    localProfileJson.effective?.cloudflareTokenFile
  ) {
    throw new Error(`admin profile local-only save kept stale tunnel config: ${JSON.stringify(localProfileJson)} ${JSON.stringify(localSavedProfile)}`);
  }

  const queryTools = await listTools(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`);
  const queryToolNames = toolNames(queryTools);
  for (const expected of ['server_config', 'codexpro_self_test', 'codexpro_inventory', 'open_current_workspace', 'open_workspace', 'workspace_snapshot', 'tree', 'search', 'load_skill', 'git_status', 'git_diff', 'show_changes', 'read_handoff', 'wait_for_handoff', 'codex_context', 'handoff_to_agent', 'handoff_to_codex', 'export_pro_context']) {
    if (!queryToolNames.includes(expected)) {
      throw new Error(`URL-token MCP tools/list missing ${expected}; got ${queryToolNames.join(', ')}`);
    }
  }
  for (const hidden of ['write', 'edit']) {
    if (queryToolNames.includes(hidden)) {
      throw new Error(`HTTP handoff mode should not advertise ${hidden}; got ${queryToolNames.join(', ')}`);
    }
  }
  const toolCardUri = 'ui://widget/codexpro-tool-card-v10.html';
  for (const visualTool of queryToolNames) {
    if (hasWidgetMeta(queryTools, visualTool, toolCardUri) || hasToolCardStatusMeta(queryTools, visualTool)) {
      throw new Error(`${visualTool} exposed widget metadata while CODEXPRO_TOOL_CARDS is off`);
    }
  }

  const headerTools = await listTools(`${baseUrl}/mcp`, token);
  const headerToolNames = toolNames(headerTools);
  if (!headerToolNames.includes('server_config')) {
    throw new Error(`bearer MCP tools/list missing server_config; got ${headerToolNames.join(', ')}`);
  }

  const mcpUrl = `${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`;
  await withClient(mcpUrl, async (firstClient) => {
    const opened = await callTool(firstClient, 'open_current_workspace', { include_tree: false });
    const changes = await callTool(firstClient, 'show_changes', {
      workspace_id: opened.structuredContent.workspace_id,
      path: 'session-checkpoint.txt'
    });
    if (!changes.structuredContent.changed || changes.structuredContent.review_checkpoint_hit) {
      throw new Error(`first HTTP session did not receive its workspace changes: ${JSON.stringify(changes.structuredContent)}`);
    }
  });
  await withClient(mcpUrl, async (secondClient) => {
    const opened = await callTool(secondClient, 'open_current_workspace', { include_tree: false });
    const changes = await callTool(secondClient, 'show_changes', {
      workspace_id: opened.structuredContent.workspace_id,
      path: 'session-checkpoint.txt'
    });
    if (!changes.structuredContent.changed || changes.structuredContent.review_checkpoint_hit) {
      throw new Error(`show_changes checkpoint leaked across HTTP sessions: ${JSON.stringify(changes.structuredContent)}`);
    }
  });
  const unknownSession = '00000000-0000-4000-8000-000000000000';
  await expectSessionNotFound(await postToolsListWithSession(baseUrl, token, unknownSession), 'unknown POST session');
  await expectSessionNotFound(await fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    headers: {
      accept: 'text/event-stream',
      'mcp-session-id': unknownSession
    }
  }), 'unknown GET session');
  await withClient(mcpUrl, async (client, transport) => {
    await client.listTools();
    const staleSession = transport.sessionId;
    if (!staleSession) throw new Error('HTTP MCP client did not receive a session id');
    await transport.terminateSession();
    await expectSessionNotFound(await postToolsListWithSession(baseUrl, token, staleSession), 'stale POST session');
  });

  await withClient(mcpUrl, async (client) => {
    const resources = await client.listResources();
    const toolCard = resources.resources.find((resource) => resource.uri === toolCardUri);
    if (!toolCard) throw new Error(`HTTP MCP resources/list missing ${toolCardUri}`);
    if (toolCard.mimeType !== 'text/html;profile=mcp-app') {
      throw new Error(`unexpected HTTP tool-card mime type: ${toolCard.mimeType}`);
    }
    const legacyToolCardUris = ['ui://widget/codexpro-tool-card-v9.html', 'ui://widget/codexpro-tool-card-v8.html'];
    for (const legacyToolCardUri of legacyToolCardUris) {
      const legacyToolCard = resources.resources.find((resource) => resource.uri === legacyToolCardUri);
      if (!legacyToolCard) throw new Error(`HTTP MCP resources/list missing legacy ${legacyToolCardUri}`);
    }
    const widget = await client.readResource({ uri: toolCardUri });
    const widgetText = widget.contents?.[0]?.text ?? '';
    const widgetMeta = widget.contents?.[0]?._meta ?? {};
    for (const required of ['extractStructuredContent', 'renderWorkspace', 'renderBash', 'details class="fold"', 'ui/notifications/tool-result', 'copy-card-output', 'applyHostTheme', 'Result unavailable', 'Connected workspace', 'Verification completed']) {
      if (!widgetText.includes(required)) throw new Error(`HTTP tool-card widget resource missing ${required}`);
    }
    if (widgetText.includes('Waiting for tool result') || widgetText.includes('codexpro-sheen')) {
      throw new Error('HTTP tool-card widget retained the v9 loading treatment');
    }
    if (!widgetText.includes('renderChangeAnalysis')) {
      throw new Error('HTTP tool-card widget resource did not include expected Apps bridge code');
    }
    if (!widgetMeta.ui?.csp || !widgetMeta['openai/widgetCSP']) {
      throw new Error('HTTP tool-card widget resource did not expose standard and ChatGPT CSP metadata');
    }
    if (widgetMeta.ui?.domain !== 'https://widgets.codexpro.test' || widgetMeta['openai/widgetDomain'] !== 'https://widgets.codexpro.test') {
      throw new Error('HTTP tool-card widget resource did not expose standard and ChatGPT widget domain metadata');
    }
    for (const legacyToolCardUri of legacyToolCardUris) {
      const legacyWidget = await client.readResource({ uri: legacyToolCardUri });
      if (legacyWidget.contents?.[0]?.uri !== legacyToolCardUri) {
        throw new Error('HTTP legacy tool-card widget resource did not preserve requested URI');
      }
      if (!(legacyWidget.contents?.[0]?.text ?? '').includes('Result unavailable')) {
        throw new Error('HTTP legacy tool-card widget resource did not serve v10 HTML');
      }
    }
  });

  const currentOpened = await withClient(mcpUrl, async (client) => {
    const result = await callTool(client, 'open_current_workspace', { include_tree: false });
    if (result.structuredContent.codexpro_tool !== 'open_current_workspace') {
      throw new Error('HTTP tool result was not tagged for widget rendering');
    }
    if (result.structuredContent.tool_mode !== 'full') {
      throw new Error(`open_current_workspace did not expose tool_mode: ${result.structuredContent.tool_mode}`);
    }
    if (result.structuredContent.skill_inventory?.length) {
      throw new Error('HTTP open_current_workspace discovered skills by default');
    }
    const withSkills = await callTool(client, 'open_current_workspace', {
      include_tree: false,
      include_skills: true
    });
    if (!withSkills.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'http-smoke-skill')) {
      throw new Error('HTTP open_current_workspace did not discover workspace skill inventory when requested');
    }
    return result.structuredContent.workspace_id;
  });

  await withClient(mcpUrl, async (client) => {
    const result = await callTool(client, 'open_workspace', {
      root,
      include_tree: false
    });
    if (result.structuredContent.skill_inventory?.length) {
      throw new Error('HTTP open_workspace discovered skills by default');
    }
    const withSkills = await callTool(client, 'open_workspace', {
      root,
      include_tree: false,
      include_skills: true
    });
    if (!withSkills.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'http-smoke-skill')) {
      throw new Error('HTTP open_workspace did not discover workspace skill inventory when requested');
    }
  });

  const nestedWorkspaceId = await withClient(mcpUrl, async (client) => {
    const nested = await callTool(client, 'open_workspace', {
      root: nestedRoot,
      include_tree: false
    });
    return nested.structuredContent.workspace_id;
  });

  await withClient(mcpUrl, async (reconnectedClient) => {
    const nestedRead = await callTool(reconnectedClient, 'read', {
      workspace_id: nestedWorkspaceId,
      path: 'nested.txt'
    });
    const nestedText = nestedRead.content?.find?.((part) => part.type === 'text')?.text ?? '';
    if (!nestedText.includes('http nested workspace')) {
      throw new Error(`new HTTP session could not reuse nested workspace id: ${nestedText}`);
    }
    const list = await callTool(reconnectedClient, 'list_workspaces');
    if (list.structuredContent.selected_workspace_id === nestedWorkspaceId) {
      throw new Error('resolving a shared workspace id changed the new HTTP session selection');
    }
  });

  await withClient(mcpUrl, async (client) => {
    const inventory = await callTool(client, 'codexpro_inventory', {
      include_global_skills: false,
      include_mcp_servers: false
    });
    if (inventory.structuredContent.codexpro_tool !== 'codexpro_inventory') {
      throw new Error('HTTP inventory result was not tagged for widget rendering');
    }
    const loadedSkill = await callTool(client, 'load_skill', {
      name: 'http-smoke-skill',
      source: 'workspace'
    });
    if (loadedSkill.structuredContent.skill?.name !== 'http-smoke-skill' || !loadedSkill.structuredContent.text?.includes('# HTTP Smoke Skill')) {
      throw new Error('HTTP load_skill did not return bounded SKILL.md content');
    }
  });

  const opened = await withClient(mcpUrl, async (client) => {
    const result = await callTool(client, 'open_workspace', { include_tree: false });
    return result.structuredContent.workspace_id;
  });
  if (opened !== currentOpened) {
    throw new Error(`open_current_workspace returned ${currentOpened}, open_workspace default returned ${opened}`);
  }

  await withClient(mcpUrl, async (firstClient) => {
    const alternate = await callTool(firstClient, 'open_workspace', {
      root: alternateRoot,
      include_tree: false
    });
    const firstSelected = await callTool(firstClient, 'read', { path: 'selected.txt' });
    const firstText = firstSelected.content?.find?.((part) => part.type === 'text')?.text ?? '';
    if (!firstText.includes('http alternate workspace')) {
      throw new Error(`first HTTP session did not retain selected workspace: ${firstText}`);
    }

    await withClient(mcpUrl, async (secondClient) => {
      const secondList = await callTool(secondClient, 'list_workspaces');
      if (
        secondList.structuredContent.selected_workspace_id === alternate.structuredContent.workspace_id
        || secondList.structuredContent.workspaces.some((workspace) => workspace.root === alternateRoot)
      ) {
        throw new Error(`HTTP workspace selection leaked between MCP sessions: ${JSON.stringify(secondList.structuredContent)}`);
      }
    });

    const firstList = await callTool(firstClient, 'list_workspaces');
    if (firstList.structuredContent.selected_workspace_id !== alternate.structuredContent.workspace_id) {
      throw new Error(`first HTTP session lost its workspace selection: ${JSON.stringify(firstList.structuredContent)}`);
    }
  });

  await withClient(mcpUrl, async (client) => {
    const list = await callTool(client, 'list_workspaces');
    const ids = list.structuredContent.workspaces.map((workspace) => workspace.id);
    if (!ids.includes(opened)) {
      throw new Error(`session list_workspaces missing configured workspace ${opened}; got ${ids.join(', ')}`);
    }

    const snapshot = await callTool(client, 'workspace_snapshot', { workspace_id: opened, max_depth: 1 });
    if (snapshot.structuredContent.workspace_id !== opened) {
      throw new Error(`workspace_snapshot returned ${snapshot.structuredContent.workspace_id}, expected ${opened}`);
    }

    const tree = await callTool(client, 'tree', { workspace_id: opened, max_depth: 1, max_entries: 10 });
    if (tree.structuredContent.workspace_id !== opened) {
      throw new Error(`tree returned ${tree.structuredContent.workspace_id}, expected ${opened}`);
    }

    const codexContext = await callTool(client, 'codex_context', { workspace_id: opened });
    if (codexContext.structuredContent.workspace_id !== opened) {
      throw new Error(`codex_context returned ${codexContext.structuredContent.workspace_id}, expected ${opened}`);
    }
  });

  try {
    await fs.stat(path.join(root, '.ai-bridge'));
    throw new Error('read-only HTTP smoke path created .ai-bridge unexpectedly');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await withClient(mcpUrl, async (client) => {
    const exported = await callTool(client, 'export_pro_context', {
      workspace_id: opened,
      max_files: 4,
      max_total_bytes: 80000
    });
    if (exported.structuredContent.path !== '.ai-bridge/pro-context.md') {
      throw new Error(`unexpected pro context path: ${exported.structuredContent.path}`);
    }
  });
  await fs.stat(path.join(root, '.ai-bridge', 'pro-context.md'));
} finally {
  child.kill('SIGTERM');
  await waitForExit(child).catch(() => {});
}

const disabledRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-disabled-tools-'));
const disabledPort = await getFreePort();
const disabledToken = 'codexpro-http-disabled-token';
const disabledChild = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: disabledRoot,
    CODEXPRO_ALLOWED_ROOTS: disabledRoot,
    CODEXPRO_PORT: String(disabledPort),
    CODEXPRO_HTTP_TOKEN: disabledToken,
    CODEXPRO_BASH_MODE: 'off',
    CODEXPRO_WRITE_MODE: 'off',
    CODEXPRO_TOOL_MODE: 'full'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForListening(disabledChild);
  const disabledBase = `http://127.0.0.1:${disabledPort}`;
  const disabledTools = await listTools(`${disabledBase}/mcp?codexpro_token=${encodeURIComponent(disabledToken)}`);
  const disabledToolNames = toolNames(disabledTools);
  for (const hiddenTool of ['bash', 'write', 'edit']) {
    if (disabledToolNames.includes(hiddenTool)) {
      throw new Error(`HTTP disabled mode should not advertise ${hiddenTool}; got ${disabledToolNames.join(', ')}`);
    }
  }
  await withClient(`${disabledBase}/mcp?codexpro_token=${encodeURIComponent(disabledToken)}`, async (client) => {
    const config = await callTool(client, 'server_config');
    if (config.structuredContent.bashMode !== 'off' || config.structuredContent.writeMode !== 'off') {
      throw new Error(`HTTP disabled mode server_config mismatch: ${JSON.stringify(config.structuredContent)}`);
    }
  });
} finally {
  disabledChild.kill('SIGTERM');
  await waitForExit(disabledChild).catch(() => {});
}

const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-http-smoke-'));
await fs.mkdir(path.join(cliRoot, '.codex'), { recursive: true });
const cliPort = await getFreePort();
const badNoAuth = spawn(process.execPath, [
  'scripts/codexpro.mjs',
  'start',
  '--root',
  cliRoot,
  '--tunnel',
  'none',
  '--no-auth',
  '--host',
  '0.0.0.0',
  '--port',
  String(cliPort)
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-http-bad-home-'))
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const badNoAuthExit = await waitForExit(badNoAuth);
if (badNoAuthExit.code === 0 || !badNoAuthExit.stderr.includes('--no-auth is only allowed')) {
  throw new Error(`non-loopback --no-auth was not rejected\n${badNoAuthExit.stderr}`);
}
const cliChild = spawn(process.execPath, [
  'scripts/codexpro.mjs',
  'start',
  '--root',
  cliRoot,
  '--tunnel',
  'none',
  '--no-auth',
  '--port',
  String(cliPort),
  '--codex-sessions',
  'metadata',
  '--codex-dir',
  '.codex'
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-http-home-'))
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForHealthJson(`http://127.0.0.1:${cliPort}/healthz`);
  const expectedCliCodexDir = await fs.realpath(path.join(cliRoot, '.codex'));
  await withClient(`http://127.0.0.1:${cliPort}/mcp`, async (client) => {
    const config = await callTool(client, 'server_config');
    const actualCliCodexDir = await fs.realpath(config.structuredContent.codexDir);
    const comparableActual = process.platform === 'win32' ? actualCliCodexDir.toLowerCase() : actualCliCodexDir;
    const comparableExpected = process.platform === 'win32' ? expectedCliCodexDir.toLowerCase() : expectedCliCodexDir;
    if (comparableActual !== comparableExpected) {
      throw new Error(`relative --codex-dir resolved to ${config.structuredContent.codexDir}, expected ${expectedCliCodexDir}`);
    }
  });
} finally {
  cliChild.kill('SIGTERM');
  await waitForExit(cliChild).catch(() => {});
}

const connectionTestPort = await getFreePort();
let connectionTestStderr = '';
const connectionTestChild = spawn(process.execPath, [
  'scripts/codexpro.mjs',
  'connection-test',
  '--root',
  cliRoot,
  '--tunnel',
  'none',
  '--no-auth',
  '--no-profile',
  '--port',
  String(connectionTestPort)
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-connection-test-home-'))
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
connectionTestChild.stderr.on('data', (chunk) => {
  connectionTestStderr += String(chunk);
});
try {
  await waitForHealthJson(`http://127.0.0.1:${connectionTestPort}/healthz`);
  const tools = await listTools(`http://127.0.0.1:${connectionTestPort}/mcp`);
  const names = toolNames(tools);
  for (const expected of ['read', 'tree', 'search', 'load_skill']) {
    if (!names.includes(expected)) throw new Error(`connection-test missing ${expected}; got ${names.join(', ')}`);
  }
  for (const hidden of ['codexpro', 'codexpro_self_test', 'write', 'edit', 'apply_patch', 'bash', 'export_pro_context', 'handoff_to_agent', 'handoff_to_codex']) {
    if (names.includes(hidden)) throw new Error(`connection-test exposed ${hidden}; got ${names.join(', ')}`);
  }
  for (const tool of tools) {
    const annotations = tool.annotations ?? {};
    if (annotations.readOnlyHint !== true || annotations.openWorldHint !== false || annotations.destructiveHint !== false) {
      throw new Error(`connection-test exposed non-read-only annotations for ${tool.name}: ${JSON.stringify(annotations)}`);
    }
  }
  await withClient(`http://127.0.0.1:${connectionTestPort}/mcp`, async (client) => {
    const config = await callTool(client, 'server_config');
    if (config.structuredContent.connectionTest !== true || config.structuredContent.toolCards !== false) {
      throw new Error(`unexpected connection-test config: ${JSON.stringify(config.structuredContent)}`);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!connectionTestStderr.includes('[CodexPro] POST /mcp received')) {
    throw new Error(`connection-test did not print request-arrival logs\n${connectionTestStderr}`);
  }
} finally {
  connectionTestChild.kill('SIGTERM');
  await waitForExit(connectionTestChild).catch(() => {});
}

console.log('✓ http smoke test passed');
