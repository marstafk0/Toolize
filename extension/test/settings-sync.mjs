// Native messaging races without contacting the installed service.
// Run with: node test/settings-sync.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/background/companion.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', define: { __DEV__: 'true' },
});
const flush = () => new Promise((r) => setImmediate(r));

function fixture(enforced = false) {
  const store = { settings: { enabled: true, preset: 'balanced', feeds: {} }, enforcement: { enforced, lastSeen: 0 } };
  const session = {};
  const messages = [];
  const listeners = {};
  const port = {
    onMessage: { addListener: (fn) => (listeners.message = fn) },
    onDisconnect: { addListener: (fn) => (listeners.disconnect = fn) },
    postMessage: (msg) => messages.push(msg),
  };
  const chrome = {
    runtime: { connectNative: () => port, getManifest: () => ({ version: '0.0.0' }) },
    storage: {
      local: {
        get: async (key) => ({ [key]: structuredClone(store[key]) }),
        set: async (values) => Object.assign(store, structuredClone(values)),
      },
      session: {
        get: async (key) => ({ [key]: structuredClone(session[key]) }),
        set: async (values) => Object.assign(session, structuredClone(values)),
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, chrome, navigator: { userAgent: 'test' }, console,
    setTimeout: () => {}, // Responses/disconnects are explicitly driven by each test.
  });
  return {
    api: module.exports, store, session, messages,
    reply: (request, data, ok = true, error) => listeners.message({ id: request.id, data, ok, error }),
    push: (settings, enforced = false, locked) =>
      listeners.message({ id: 'push', ok: true, data: { settings, enforced, ...(locked !== undefined ? { locked } : {}) } }),
    disconnect: () => {
      chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
      listeners.disconnect();
      delete chrome.runtime.lastError;
    },
  };
}

let passed = 0;
async function check(name, run) {
  await run();
  console.log(`PASS  ${name}`);
  passed++;
}

await check('set-settings sends only the requested fields and adopts service settings', async () => {
  const f = fixture();
  const request = f.api.requestSettings({ preset: 'strict' });
  await flush();
  assert.equal(JSON.stringify(f.messages[0].args), JSON.stringify({ settings: { preset: 'strict' } }));
  f.reply(f.messages[0], { ...f.store.settings, preset: 'strict', feeds: { 'youtube.home': true } });
  const result = await request;
  assert.equal(result.preset, 'strict');
  assert.equal(result.feeds['youtube.home'], true);
});

for (const verb of ['hello', 'heartbeat']) {
  await check(`an older ${verb} cannot revert an accepted change`, async () => {
    const f = fixture();
    const old = verb === 'hello' ? f.api.hello() : f.api.heartbeat({ blocked: 0, checked: 0 });
    const oldSettings = structuredClone(f.store.settings);
    const change = f.api.requestSettings({ preset: 'strict' });
    await flush();
    f.reply(f.messages[1], { ...oldSettings, preset: 'strict' });
    await change;
    f.reply(f.messages[0], { settings: oldSettings, enforced: false });
    await old;
    assert.equal(f.store.settings.preset, 'strict');
  });
}

await check('an unsolicited push updates settings/enforcement and invalidates older responses', async () => {
  const f = fixture();
  const old = f.api.heartbeat({ blocked: 0, checked: 0 });
  const oldSettings = structuredClone(f.store.settings);
  f.push({ ...oldSettings, preset: 'strict' }, true);
  f.reply(f.messages[0], { settings: oldSettings, enforced: false });
  await old;
  await flush();
  assert.equal(f.store.settings.preset, 'strict');
  assert.equal(f.store.enforcement.enforced, true);
});

await check('hello, heartbeat, and unsolicited push track locked state in memory and session storage', async () => {
  const f = fixture();
  const hello = f.api.hello();
  await flush();
  f.reply(f.messages[0], { settings: f.store.settings, enforced: true, locked: true });
  await hello;
  assert.equal(f.api.isLocked(), true);
  assert.equal(f.session.companionLock, true);
  let state = await f.api.getCompanionState();
  assert.equal(state.installed, true);
  assert.equal(state.locked, true);

  // Unsolicited push carrying locked: false (key plugged in) updates immediately and persists to session.
  f.push(f.store.settings, true, false);
  await flush();
  await flush();
  assert.equal(f.api.isLocked(), false);
  assert.equal(f.session.companionLock, false);
  state = await f.api.getCompanionState();
  assert.equal(state.installed, true);
  assert.equal(state.locked, false);

  // Push carrying locked: true (key removed) re-locks immediately.
  f.push(f.store.settings, true, true);
  await flush();
  await flush();
  assert.equal(f.api.isLocked(), true);
  assert.equal(f.session.companionLock, true);
  state = await f.api.getCompanionState();
  assert.equal(state.installed, true);
  assert.equal(state.locked, true);
});

await check('a push wins over a set-settings response already in flight', async () => {
  const f = fixture();
  const change = f.api.requestSettings({ preset: 'relaxed' });
  await flush();
  f.push({ ...f.store.settings, preset: 'strict' }, true);
  f.reply(f.messages[0], { ...f.store.settings, preset: 'relaxed' });
  await change;
  assert.equal(f.store.settings.preset, 'strict');
  assert.equal(f.store.enforcement.enforced, true);
});

await check('asynchronous missing-host disconnect applies standalone changes locally', async () => {
  const f = fixture();
  const change = f.api.requestSettings({ enabled: false });
  await flush();
  f.disconnect();
  assert.equal((await change).enabled, false);
});

await check('a missing host cannot weaken enforced protection', async () => {
  const f = fixture(true);
  const change = f.api.requestSettings({ enabled: false });
  const rejected = assert.rejects(change, /host not found/);
  await flush();
  f.disconnect();
  await rejected;
  assert.equal(f.store.settings.enabled, true);
});

await check('a service refusal containing "not found" never falls back locally', async () => {
  const f = fixture();
  const change = f.api.requestSettings({ enabled: false });
  const rejected = assert.rejects(change, /key not found/);
  await flush();
  f.reply(f.messages[0], undefined, false, 'verified key not found');
  await rejected;
  assert.equal(f.store.settings.enabled, true);
});

console.log(`${passed} passed, 0 failed`);
