// Run every test, stop on the first failure (CLAUDE.md rule 10).   Usage: node n8n/tests/run-all.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'snippets')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(root, 'snippets', f)),
  ...fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(__dirname, f)),
  path.join(root, 'merged', 'validate-merged.js'),
  ...fs.readdirSync(path.join(root, 'merged')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(root, 'merged', f)),
  ...fs.readdirSync(path.join(root, 'w2')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(root, 'w2', f)),
  ...fs.readdirSync(path.join(root, 'w13')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(root, 'w13', f)),
  path.join(root, 'integrated', 'validate-integrated.js'),
  path.join(root, 'integrated', 'validate-ai-os.js'),
  path.join(root, 'integrated', 'validate-ai-context.js'),
  path.join(root, 'integrated', 'validate-handoff-gate.js'),
  path.join(root, 'integrated', 'validate-w7-w10.js'),
  path.join(root, 'integrated', 'validate-quiet-hours-switch.js'),
  path.join(root, 'integrated', 'validate-w13-prompt.js'),
  ...fs.readdirSync(path.join(root, 'integrated')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(root, 'integrated', f)),
];

for (const file of files) {
  const rel = path.relative(path.join(root, '..'), file);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  if (r.status !== 0) {
    console.error(`FAIL  ${rel}\n${r.stdout}\n${r.stderr}`);
    process.exit(1);
  }
  console.log(`pass  ${rel}  (${last.trim()})`);
}
console.log(`\nAll ${files.length} test files pass.`);
