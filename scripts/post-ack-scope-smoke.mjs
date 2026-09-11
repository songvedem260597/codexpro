import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('service-worker.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const name = 'stabilizeSubmittedSendAfterAck';
const definitions = [];
const calls = [];

function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === name) definitions.push(node);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node);
  ts.forEachChild(node, visit);
}

visit(ast);
assert.equal(definitions.length, 1, 'post-ACK helper must have exactly one definition');
assert.ok(definitions[0].parent === ast, 'post-ACK helper must be top-level, not nested in a tab callback');
assert.equal(calls.length, 1, 'successful send path must have exactly one post-ACK helper callsite');
assert.match(source, /const WORKER_RUNTIME_BUILD_ID = 'send-post-ack-scope-v2';/, 'runtime identity must advance when the service worker artifact changes');
assert.match(source, /async function publishExtensionRuntimeIdentity\(profile\)/, 'runtime identity publication must receive the exact worker profile');
assert.match(source, /extensionRuntimeIdentityDetails=\{profile_id:String\(profile\?\.id\|\|''\),artifact_name:'service-worker\.js'/, 'runtime identity trace must attribute the service-worker SHA to the exact profile id');
assert.match(source, /const profile=await profileInfo\(\);[\s\S]*?publishExtensionRuntimeIdentity\(profile\)/, 'poll loop must publish identity for the same profile that produced the heartbeat');
assert.match(source, /async function extensionRuntimeIdentity\(profile\)[\s\S]*?runtime_build_id:WORKER_RUNTIME_BUILD_ID/, 'runtime identity helper must bind exact worker build id to the service-worker SHA');
assert.match(source, /if\(action==='list_tabs'\)[\s\S]*?runtime_identity:await extensionRuntimeIdentity\(profile\)/, 'list_tabs must expose exact running service-worker identity from the targeted worker');

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
