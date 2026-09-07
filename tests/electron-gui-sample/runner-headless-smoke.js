const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const bootstrap = read('main-auto-runner.js');
const patch = read('runner-headless-patch.js');
const autoRunner = read('main-auto-runner-fast.js');

assert.ok(
  bootstrap.indexOf("require('./runner-headless-patch.js')") >= 0 &&
  bootstrap.indexOf("require('./runner-headless-patch.js')") < bootstrap.indexOf("require('./main-auto-runner-fast.js')"),
  'headless patch must load before any runner launcher captures child_process.spawn'
);

assert.match(patch, /wscript\.exe/);
assert.match(patch, /shell\.Run Chr\(34\).*?, 0, False/);
assert.match(patch, /run\.cmd/);
assert.match(patch, /Runner\.Listener\.exe/);
assert.match(patch, /Start-Service/);
assert.match(patch, /stdio: 'ignore'/);
assert.match(patch, /windowsHide: true/);
assert.match(patch, /commandIndex < 0 \|\| normalized\[commandIndex \+ 1\] !== 'run\.cmd'/);

assert.match(autoRunner, /TAKEOVER_IDLE_MS = 20000/);
assert.match(autoRunner, /if \(state\.busy\)/);
assert.match(autoRunner, /isWindowsServiceRunner/);
assert.match(autoRunner, /taskkill\.exe/);
assert.match(autoRunner, /HEADLESS TAKEOVER/);
assert.match(autoRunner, /inspectRunnerProcess\(runner\.root, \{ force: true \}\)/);

console.log('RUNNER_HEADLESS_SMOKE=PASS');
