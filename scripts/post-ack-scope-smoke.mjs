import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('service-worker.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const name = 'stabilizeSubmittedSendAfterAck';
const definitions = [];

function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === name) definitions.push(node);
  ts.forEachChild(node, visit);
}

visit(ast);
assert.equal(definitions.length, 1, 'post-ACK helper must have exactly one definition');
assert.ok(definitions[0].parent === ast, 'post-ACK helper must be top-level, not nested in a tab callback');

// Current helper returns this lexical stability source in addition to the historical post-ACK fields.
const stabilitySource = 'post_ack_scope_smoke';
const helper = vm.runInNewContext(
  `${definitions[0].getText(ast)}; ${name}`,
  { SEND_CONFIRMED_STABILITY_SOURCE: stabilitySource }
);

for (const [budget, expectedWait] of [[5000, 650], [120, 120], [0, 0], [-100, 0]]) {
  const waits = [];
  const result = await helper(budget, true, async ms => waits.push(ms));
  assert.deepEqual(waits, expectedWait ? [expectedWait] : []);
  assert.equal(result.send_stabilized, true);
  assert.equal(result.send_stability_source, stabilitySource);
  assert.equal(result.followup_while_generating, true);
}

await assert.rejects(
  helper(650, false, async () => { throw new Error('sleep failed'); }),
  /sleep failed/
);
assert.match(
  source,
  /const stabilizeSubmittedSend=async\(\)=>await stabilizeSubmittedSendAfterAck\(/,
  'send path must invoke the scoped helper'
);

console.log('post-ACK scope smoke passed');
