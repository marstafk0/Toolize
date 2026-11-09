import { loadSettings, saveSettingsLocal, type Settings } from '../shared/settings';

/**
 * Link to the Toolize desktop app, over Chrome's native messaging.
 *
 * The app is the source of truth for settings; chrome.storage is a cache. When the app
 * is reachable, every change is a *request* it may refuse: anything that weakens
 * protection needs the USB key plugged in. When it isn't reachable the extension keeps
 * working from its cached settings — and if the app had told us this machine is
 * enforced, a sustained absence makes the content scripts block pages instead (see
 * content/failclosed.ts).
 */

const HOST = 'com.toolize.host';
const HEARTBEAT_ALARM = 'toolize-heartbeat';
const HEARTBEAT_MINUTES = 0.5;

interface PipeResponse {
  id: string;
  ok: boolean;
  data?: { settings?: Settings; service?: string; enforced?: boolean; locked?: boolean };
  error?: string;
  code?: string;
}

/**
 * Enforcement state, cached so it survives service-worker restarts.
 *
 * When the desktop app says protection is enforced, losing contact with it is not a
 * reason to carry on as normal — it is the signal that something has been switched off.
 * After a grace period the content scripts block pages instead. Without this, killing
 * the app would be the easiest bypass in the product.
 */
const ENFORCED_KEY = 'enforcement';
const LOCK_KEY = 'companionLock';

export interface EnforcementCache {
  enforced: boolean;
  lastSeen: number;
}

export async function readEnforcement(): Promise<EnforcementCache> {
  const got = await chrome.storage.local.get(ENFORCED_KEY);
  return (got[ENFORCED_KEY] as EnforcementCache) ?? { enforced: false, lastSeen: 0 };
}

async function noteEnforcement(enforced: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENFORCED_KEY]: { enforced, lastSeen: Date.now() } satisfies EnforcementCache });
}

async function noteLocked(next: boolean): Promise<void> {
  locked = next;
  await chrome.storage.session?.set({ [LOCK_KEY]: next });
}

/**
 * Which browser this is, so the app can tell Chrome checking in apart from Edge, where
 * the extension may be disabled. Brave and Edge both identify as Chrome in the plain
 * user agent; the client-hint brands and Brave's own navigator.brave are what differ.
 */
type Browser = 'chrome' | 'edge' | 'brave';

function detectBrowser(): Browser {
  const nav = navigator as Navigator & {
    brave?: unknown;
    userAgentData?: { brands?: { brand: string }[] };
  };
  const brands = nav.userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (nav.brave !== undefined || brands.includes('Brave')) return 'brave';
  if (brands.includes('Microsoft Edge') || / Edg\//.test(navigator.userAgent)) return 'edge';
  return 'chrome';
}

const BROWSER = detectBrowser();

export interface CompanionStats {
  blocked: number;
  checked: number;
}

let port: chrome.runtime.Port | null = null;
let connected = false;
let locked: boolean | undefined;
let seq = 0;
let generation = 0;
let cacheChain: Promise<unknown> = Promise.resolve();
let settingsChain: Promise<unknown> = Promise.resolve();
const pending = new Map<string, { resolve: (r: PipeResponse) => void; reject: (e: Error) => void }>();

/** Check the generation at write time too: storage writes themselves are asynchronous. */
function adopt(data: PipeResponse['data'], expected: number): Promise<Settings | null> {
  const write = cacheChain.catch(() => {}).then(async () => {
    if (generation !== expected) return null;
    if (data?.enforced !== undefined) await noteEnforcement(data.enforced === true);
    if (data?.locked !== undefined) await noteLocked(data.locked === true);
    if (generation !== expected || !data?.settings) return null;
    return saveSettingsLocal(data.settings);
  });
  cacheChain = write;
  return write;
}

function connect(): chrome.runtime.Port | null {
  if (port) return port;
  try {
    const p = chrome.runtime.connectNative(HOST);
    p.onMessage.addListener((msg: PipeResponse) => {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      } else if (msg.id === 'push' && msg.ok && msg.data) {
        // The authority's latest state wins over every response already in flight.
        connected = true;
        if (msg.data.locked !== undefined) locked = msg.data.locked === true;
        void adopt({ ...msg.data, enforced: msg.data.enforced === true }, ++generation)
          .catch((e) => console.warn('[toolize] settings push failed', e));
      }
    });
    p.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message ?? 'disconnected';
      for (const [, w] of pending) w.reject(new Error(why));
      pending.clear();
      port = null;
      connected = false;
      locked = false;
    });
    port = p;
    return p;
  } catch {
    // Host not installed: the extension runs standalone.
    port = null;
    connected = false;
    locked = false;
    return null;
  }
}

function send(verb: string, args?: unknown): Promise<PipeResponse> {
  const p = connect();
  if (!p) return Promise.reject(new Error('companion app not installed'));
  const id = `e${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      p.postMessage({ id, verb, args });
    } catch (e) {
      pending.delete(id);
      reject(e as Error);
    }
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${verb} timed out`));
    }, 5000);
  });
}

export const isConnected = (): boolean => connected;
export const isLocked = (): boolean => connected && locked === true;

export async function getCompanionState(): Promise<{ installed: boolean; locked: boolean }> {
  if (locked === undefined && chrome.storage.session) {
    const got = await chrome.storage.session.get(LOCK_KEY);
    if (typeof got[LOCK_KEY] === 'boolean' && locked === undefined) locked = got[LOCK_KEY] as boolean;
  }
  return { installed: connected, locked: connected && locked === true };
}

/**
 * Asks the desktop app to allow a weakening change made on the extension's side. With
 * no app installed there is no key to ask for, as with every other setting. With the
 * app installed but not answering, the answer is no: stopping the service must not be
 * the way to unlock anything.
 */
export async function authorizeWeakening(what: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await send('authorize-weakening', { what });
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'the Toolize app refused' };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/not installed|not found|forbidden/i.test(msg)) return { ok: true };
    return { ok: false, error: `the Toolize app didn't answer (${msg})` };
  }
}

/** Handshake: announce ourselves, adopt the app's settings as authoritative. */
export async function hello(): Promise<Settings | null> {
  const started = generation;
  try {
    const version = chrome.runtime.getManifest().version;
    const res = await send('extension-hello', { version, browser: BROWSER });
    connected = res.ok;
    if (!res.ok) return null;
    return await adopt({ ...res.data, enforced: res.data?.enforced === true }, started);
  } catch {
    connected = false;
    return null;
  }
}

export async function heartbeat(stats: CompanionStats): Promise<void> {
  const started = generation;
  try {
    const version = chrome.runtime.getManifest().version;
    const res = await send('extension-heartbeat', { version, browser: BROWSER, ...stats });
    connected = res.ok;
    if (!res.ok) return;
    await adopt({ ...res.data, enforced: res.data?.enforced === true }, started);
  } catch {
    connected = false;
  }
}

/**
 * Asks the app to change settings. Returns what the app decided, or throws with its
 * refusal. With no app installed the change is applied locally.
 */
export function requestSettings(patch: Partial<Settings>): Promise<Settings> {
  const change = settingsChain.catch(() => {}).then(async () => {
    const started = generation;
    let settings: Settings | undefined;
    let res: PipeResponse | undefined;
    try {
      res = await send('set-settings', { settings: patch });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (!/not installed|not found|forbidden/i.test(message) || (await readEnforcement()).enforced) throw e;
      settings = { ...(await loadSettings()), ...patch };
    }
    // A refusal from a reachable service is authoritative, even if its error happens
    // to contain one of the missing-host phrases used for standalone detection.
    if (res) {
      if (!res.ok) throw Object.assign(new Error(res.error ?? 'the app refused the change'), { code: res.code });
      settings = res.data?.settings ?? (res.data as unknown as Settings);
    }
    if (!settings) throw new Error('the app returned no settings');
    // A push received while waiting already contains the authority's newer state.
    if (generation === started) await adopt({ settings }, ++generation);
    await cacheChain;
    return loadSettings();
  });
  settingsChain = change;
  return change;
}

export function startHeartbeat(getStats: () => Promise<CompanionStats>): void {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM) return;
    if (!connected) {
      await hello(); // reconnect after a service restart or a late install
      if (!connected) return;
    }
    await heartbeat(await getStats());
  });
}
