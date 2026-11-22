// Guard against committing live connector state.
//
// The runtime writes dispatch tokens, API tokens and claimed assignments under
// a state directory (.tmp/ from review-loop, or VAN_STATE_DIR). Those files are
// ordinary-looking JSON, so one `git add .` ships a usable dispatch token. The
// v1.0.0 tree did exactly that: .tmp/van-e2e-hpQtZd/active.json was tracked and
// carried a live 36-character dispatchToken plus the assignment it claimed.
//
// This test reads the index, not the working tree, so a local (ignored) state
// directory does not fail it: the defect is a *tracked* state file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIRS = ['.tmp/', '.van-connector/'];
const TOKEN = /van_[0-9a-f]{64}/;
const MAX_BYTES = 2 * 1024 * 1024;

async function tracked() {
  const {stdout} = await run('git', ['ls-files', '-z'], {cwd: root, maxBuffer: 16 * 1024 * 1024});
  return stdout.split('\0').filter(Boolean);
}

test('the ignore file covers every runtime state directory', async () => {
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  const rules = ignore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const dir of STATE_DIRS) {
    const bare = dir.replace(/\/$/, '');
    assert.ok(
      rules.some((r) => r === dir || r === bare || r === `/${dir}` || r === `/${bare}`),
      `.gitignore must ignore ${dir}`,
    );
  }
});

test('no tracked file lives under a runtime state directory', async () => {
  const offenders = (await tracked()).filter((p) => STATE_DIRS.some((d) => p.startsWith(d)));
  assert.deepEqual(offenders, [], `tracked runtime state (contains dispatch tokens): ${offenders}`);
});

test('no tracked file carries a connector API token', async () => {
  const offenders = [];
  for (const path of await tracked()) {
    const full = join(root, path);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue; // deleted in the working tree; the index entry is covered above
    }
    if (!info.isFile() || info.size > MAX_BYTES) continue;
    if (TOKEN.test(await readFile(full, 'utf8'))) offenders.push(path);
  }
  assert.deepEqual(offenders, [], `files containing a van_ API token: ${offenders}`);
});
