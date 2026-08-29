import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-usage-log-'));
const logPath = path.join(tempRoot, 'usage.jsonl');
process.env.CODEXPRO_USAGE_LOG = logPath;
process.env.CODEXPRO_USAGE_LOG_MAX_BYTES = '2048';

try {
  const { flushMcpUsage, recordMcpUsage } = await import('../dist/mcpUsage.js');
  const payload = { text: 'x'.repeat(900) };
  for (let index = 0; index < 12; index += 1) {
    recordMcpUsage('smoke', { index, payload }, { ok: true, payload }, 'ok', index);
  }
  await flushMcpUsage();
  const files = await fs.readdir(tempRoot);
  assert(files.includes('usage.jsonl'), 'current usage log was not written');
  assert(files.includes('usage.jsonl.1'), 'usage log did not rotate');
  assert(files.length <= 4, `usage log retained too many files: ${files.join(', ')}`);
  const current = await fs.readFile(logPath, 'utf8');
  assert(current.trim().length > 0, 'current usage log is empty after rotation');
  console.log('✓ usage log smoke test passed');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
