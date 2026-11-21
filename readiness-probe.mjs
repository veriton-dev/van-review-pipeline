// Bounded readiness probe for THE VAN reviewer path.
//
// Proves, against the real server with the real credential: instance heartbeat,
// reviewer heartbeat, and one /reviews/next poll. It never claims a job and
// never submits a receipt, so it cannot burn a dispatch attempt's review lease.
// Prints only non-sensitive fields (ids, status codes, booleans).
import {readFile} from 'node:fs/promises';
import {VanClient, ApiError} from './vendor/src/api.mjs';

const STATE = process.env.VAN_STATE_DIR
  ?? '/home/agent/.openclaw/workspace/scratch/van-pilot-work-20261119/state';
const token = (await readFile(`${STATE}/token`, 'utf8')).trim();
const instanceId = (await readFile(`${STATE}/instance-id`, 'utf8')).trim();
const minRewardAtomic = '17000'; // server requires a decimal string, not a number

const client = new VanClient({token});
const out = {instanceId, startedAt: new Date().toISOString(), steps: []};

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    out.steps.push({step: name, ok: true, ms: Date.now() - t0, ...summarize(name, value)});
    return value;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : null;
    const code = error instanceof ApiError ? error.code : error.name;
    out.steps.push({step: name, ok: false, ms: Date.now() - t0, status, code: String(code).slice(0, 60)});
    return null;
  }
}

function summarize(name, value) {
  if (name === 'me') return {agentId: value?.agentId, role: value?.role};
  if (name === 'instance-heartbeat') return {accepted: value != null, keys: Object.keys(value ?? {}).slice(0, 8)};
  if (name === 'reviewer-heartbeat') return {accepted: value != null, keys: Object.keys(value ?? {}).slice(0, 8)};
  if (name === 'reviews-next') return {dispatch: value?.dispatch ? 'present' : null};
  return {};
}

await step('me', () => client.me());
await step('instance-heartbeat', () =>
  client.request('/agents/instances/heartbeat', {instanceId, slots: 1, minRewardAtomic}));
await step('reviewer-heartbeat', () => client.request('/reviews/heartbeat', {}));
// Second instance heartbeat a few seconds later: proves the loop is live, not a
// single cold request.
await new Promise((r) => setTimeout(r, 5000));
const second = await step('instance-heartbeat-2', () =>
  client.request('/agents/instances/heartbeat', {instanceId, slots: 1, minRewardAtomic}));
await step('reviews-next', () => client.request('/reviews/next', {instanceId}));

out.finishedAt = new Date().toISOString();
out.allOk = out.steps.every((s) => s.ok);
console.log(JSON.stringify(out, null, 1));
