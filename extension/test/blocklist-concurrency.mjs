// Storage snapshots and delayed authorization reproduce the learned-site races.
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = { settings: { enabled: true, blockAdultSites: true }, learnedSites: [] };
let rules = [];
let writes = 0;
let maxWrites = 0;
globalThis.chrome = {
  storage: { local: {
    async get(key) { const value = structuredClone(state[key]); await tick(); return { [key]: value }; },
    async set(values) { await tick(); Object.assign(state, structuredClone(values)); },
  } },
  runtime: { getURL: (path) => `chrome-extension://test${path}` },
  declarativeNetRequest: {
    async getDynamicRules() { await tick(); return structuredClone(rules); },
    async updateDynamicRules({ removeRuleIds, addRules }) {
      writes++;
      maxWrites = Math.max(maxWrites, writes);
      await tick();
      rules = rules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
      writes--;
    },
  },
};
globalThis.authorizeForTest = async () => { await tick(); return { ok: true }; };
const bundle = await esbuild.build({
  entryPoints: [join(root, 'src/background/blocklist.ts')], bundle: true, format: 'esm', write: false,
  define: { __DEV__: 'false' }, logLevel: 'silent',
  plugins: [{
    name: 'authorization-stub', setup(build) {
      build.onResolve({ filter: /^\.\/companion$/ }, () => ({ path: 'authorization', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const authorizeWeakening = (...args) => globalThis.authorizeForTest(...args);' }));
    },
  }],
});
const { learn, unlearn, reconcileDnr, syncDynamicRules } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const sites = () => state.learnedSites.map((site) => site.site).sort();
const assertRules = () => assert.deepEqual(rules.flatMap((rule) => rule.condition.requestDomains).sort(), sites());

await Promise.all(Array.from({ length: 24 }, (_, i) => learn(`https://site${i}.test/page`, 'images')));
assert.equal(sites().length, 24, 'concurrent learns retain every site');
assertRules();
await Promise.all([
  learn('https://site0.test/duplicate', 'label'), learn('https://newsite.test/', 'label'),
  unlearn('site1.test'), unlearn('site2.test'), syncDynamicRules(),
]);
assert.equal(sites().length, 23);
assert.ok(!sites().includes('site1.test') && !sites().includes('site2.test'));
assertRules();

let authorize;
let started;
const authStarted = new Promise((resolve) => { started = resolve; });
globalThis.authorizeForTest = () => { started(); return new Promise((resolve) => { authorize = resolve; }); };
const removal = unlearn('site0.test');
await authStarted;
await learn('https://duringauth.test/', 'images');
authorize({ ok: true });
assert.deepEqual(await removal, { ok: true });
assert.ok(sites().includes('duringauth.test'), 'authorization delay must not overwrite a newer learn');
assert.ok(!sites().includes('site0.test'));
assertRules();

globalThis.authorizeForTest = async () => ({ ok: false, error: 'key required' });
assert.deepEqual(await unlearn('duringauth.test'), { ok: false, error: 'key required' });
assert.ok(sites().includes('duringauth.test'));
globalThis.authorizeForTest = async () => ({ ok: true });
await Promise.all([learn('https://queued.test/', 'images'), unlearn('queued.test')]);
assert.ok(!sites().includes('queued.test'), 'unlearn sees a preceding queued learn');

// Evaluate enabled state when the queued operation actually runs.
let release;
const barrier = reconcileDnr(() => new Promise((resolve) => { release = resolve; }));
await tick();
const pendingLearn = learn('https://disabled.test/', 'images');
state.settings.enabled = false;
release();
await barrier;
assert.equal(await pendingLearn, null);
assert.ok(!sites().includes('disabled.test'));
await syncDynamicRules();
assert.equal(rules.length, 0);
assert.equal(maxWrites, 1, 'DNR writes remain serialized');
console.log('PASS learned-site concurrency, delayed/denied authorization, queue ordering and disabled protection');
