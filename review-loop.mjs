// Live reviewer runtime for THE VAN (Base Sepolia test API).
//
// This is the process the operator runs, not a library: it owns the API token
// (read from private state, never printed), the persisted instance UUID, the
// connector's heartbeat/poll/claim/receipt state machine, and the evidence
// handler that produces the verdict.
//
// Usage:
//   node review-loop.mjs --ready-seconds 120     # advertise availability, poll, idle out
//   node review-loop.mjs --once                  # single poll, claim one job if offered
//   node review-loop.mjs --dry-run               # no network at all; prints the plan
//
// Safety properties this process relies on (all enforced below, not by convention):
// - never prints the token, a dispatch token, or a receipt body
// - one process only: the connector refuses a second lock on the same state dir
// - an expired/lost lease is reported and the process stops rather than guessing
import {readFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {VanClient} from './test/vendor/src/api.mjs';
import {runReviewer} from './test/vendor/src/reviewer.mjs';
import {Store} from './test/vendor/src/store.mjs';
import {makePipelineHandler} from './handler.mjs';
import {makeJudge, makeCliRunner} from './judge.mjs';

const STATE = process.env.VAN_STATE_DIR
  ?? '/home/agent/.openclaw/workspace/scratch/van-pilot-work-20261119/state';
const args = new Set(process.argv.slice(2));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const readySeconds = flag('--ready-seconds', 120);
const once = args.has('--once');
const dryRun = args.has('--dry-run');
// Which verdict a contradicted report gets when the brief does not say. The
// venue rubric for its calibration suite demands REJECT on a factual
// contradiction, so that suite is run with `--contradiction reject`.
const contradictionAt = process.argv.indexOf('--contradiction');
const contradiction = contradictionAt === -1 ? 'auto' : process.argv[contradictionAt + 1];
if (!['auto', 'revise', 'reject'].includes(contradiction)) {
  console.error(JSON.stringify({error: 'invalid --contradiction policy'}));
  process.exit(2);
}
const execFile = promisify(execFileCb);

function log(event, fields = {}) {
  // Structured, non-sensitive. No token, no dispatch token, no report text.
  console.log(JSON.stringify({at: new Date().toISOString(), event, ...fields}));
}

async function loadIdentity() {
  const token = (await readFile(join(STATE, 'token'), 'utf8')).trim();
  if (!/^van_[a-f0-9]{64}$/.test(token)) throw Error('Token file does not contain a van_ token');
  const instanceId = (await readFile(join(STATE, 'instance-id'), 'utf8')).trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(instanceId)) throw Error('Invalid instance id');
  return {token, identity: {instanceId, minRewardAtomic: '17000', role: 'reviewer', chainId: 84532}};
}

const plan = {
  stateDir: STATE,
  stateExists: existsSync(STATE),
  mode: dryRun ? 'dry-run' : once ? 'once' : 'ready-window',
  readySeconds,
  judge: {runner: 'openclaw infer model run --local', model: 'commandcode/deepseek/deepseek-v4.1-flash'},
  contradiction,
  heartbeat: {instance: '30s', reviewer: '30s'},
  notes: [
    'A dispatch is claimed only after the handler is ready to write sources.json.',
    'A receipt is submitted only when every requested source has a terminal evidence result.',
    'Queue polling is idle-only: no polling while a dispatch is held.',
  ],
};

if (dryRun) {
  log('plan', plan);
  process.exit(0);
}

const {token, identity} = await loadIdentity();
const store = new Store(STATE);
await store.init();

const handler = makePipelineHandler({
  evaluate: makeJudge({run: makeCliRunner({execFile, promisified: true})}),
  policy: contradiction,
  log: (event) => log('handler', {event}),
});

// The connector writes the assignment handoff under <state>/<32 hex of the
// dispatch token>; the handler only ever sees that directory.
async function runHandlerForActive() {
  const active = await store.read('active.json');
  if (!active?.assignment || active.receipt) return;
  const {createHash} = await import('node:crypto');
  const handoff = createHash('sha256').update(active.dispatch.dispatchToken).digest('hex').slice(0, 32);
  const workDir = join(STATE, handoff);
  // The handler writes its control files 0600; the connector reads them from
  // this directory, so create it private rather than inheriting the umask.
  await mkdir(workDir, {recursive: true, mode: 0o700});
  await handler({workDir});
}

const client = new VanClient({token});
const controller = new AbortController();
let busy = false;
let stops = 0;

// The handler contract is file-based, so a small supervisor calls it while the
// connector's state machine is mid-flight. It never touches transport.
const supervisor = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await runHandlerForActive();
  } catch (error) {
    // A handler error must not kill the connector loop; the connector keeps the
    // assignment and will reconcile. Report the class only.
    log('handler_error', {error: String(error.message).slice(0, 120)});
  } finally {
    busy = false;
  }
}, 1500);

const readyWindow = once ? null : setTimeout(() => controller.abort(), readySeconds * 1000);

log('start', {instanceId: identity.instanceId, mode: plan.mode, readySeconds});

try {
  await runReviewer(client, store, identity, {
    once,
    interval: 1500,
    pulseMs: 30000,
    signal: controller.signal,
    log: (event) => log('connector', {event}),
  });
  const active = await store.read('active.json');
  log('stopped', {
    phase: active?.phase ?? 'idle',
    receiptSubmitted: Boolean(active?.receipt),
    verdict: active?.receipt?.verdict ?? null,
    checks: active?.receipt?.checks?.length ?? 0,
  });
} catch (error) {
  // Heartbeat loss, expired lease, or an inconsistent verdict. State is retained
  // on purpose so a human-visible reconciliation can happen instead of a retry
  // that might double-submit.
  log('stopped_with_error', {error: String(error.message).slice(0, 160)});
  process.exitCode = 2;
} finally {
  clearInterval(supervisor);
  if (readyWindow) clearTimeout(readyWindow);
  while (busy) await new Promise((r) => setTimeout(r, 10));
}
