// Every relative import in the published tree must resolve to a real file.
//
// Why this exists: `review-loop.mjs` and `readiness-probe.mjs` imported the
// connector as `./vendor/src/*` while the vendored copy ships at
// `./test/vendor/src/*`. The README tells the operator to run those two files,
// and neither could start; `npm test` stayed green because the test files
// happened to use the correct path. A suite that never resolves the entry points
// cannot notice that the entry points are broken.
//
// Three traps this test had to clear, each found by running it rather than
// reasoning about it:
//   1. `import()` on the entry points executes them — `review-loop.mjs` starts a
//      connector loop at top level, so the suite hung until the test timeout.
//   2. `import.meta.resolve` does no existence check on Node 24: it returns a URL
//      for `./nope-does-not-exist.mjs`. Resolving alone proves nothing.
//   3. `import.meta.resolve(specifier, parentUrl)` ignores `parentUrl` on Node 24
//      and resolves against this test file, which reported every import in the
//      tree as broken. Resolution is done with `path` below instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
const ENTRY_POINTS = ['review-loop.mjs', 'readiness-probe.mjs', 'handler.mjs', 'judge.mjs', 'source-plan.mjs'];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

async function resolves(specifier, fromFile) {
  const target = resolve(dirname(fromFile), specifier.split('?')[0]);
  for (const candidate of [target, `${target}.mjs`, join(target, 'index.mjs')]) {
    try {
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

test('the entry points the README tells an operator to run exist', async () => {
  const missing = [];
  for (const name of ENTRY_POINTS) {
    if (!(await resolves(`./${name}`, join(ROOT, 'package.json')))) missing.push(name);
  }
  assert.deepEqual(missing, [], `missing entry points: ${missing.join(', ')}`);
});

test('every relative import in the tree resolves to a file on disk', async () => {
  const unresolved = [];

  for (const file of await walk(ROOT)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      if (!(await resolves(match[1], file))) {
        unresolved.push(`${file.slice(ROOT.length + 1)}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(unresolved, [], `unresolved relative imports:\n${unresolved.join('\n')}`);
});
