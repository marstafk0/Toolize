import { DEFAULT_SETTINGS, saveSettingsLocal, type Settings } from '../shared/settings';

/**
 * Link to the Toolize desktop app, over Chrome's native messaging.
 *
 * The app is the source of truth for settings; chrome.storage is a cache. When the app
 * is reachable, every change is a *request* it may refuse (phase 4 refuses anything
 * that weakens protection while the USB key is absent). When it isn't reachable, the
 * extension keeps working on its own cached settings — this phase ships no enforcement,
 * so an absent app must not mean an unprotected browser.
 */

const HOST = 'com.toolize.host';
const HEARTBEAT_ALARM = 'toolize-heartbeat';
const HEARTBEAT_MINUTES = 0.5;

interface PipeResponse {
  id: string;
  ok: boolean;
  data?: { settings?: Settings; service?: string };
  error?: string;
  code?: string;
}

export interface CompanionStats {
  blocked: number;
  checked: number;
}

let port: chrome.runtime.Port | null = null;
let connected = false;
let seq = 0;
const pending = new Map<string, { resolve: (r: PipeResponse) => void; reject: (e: Error) => void }>();

function connect(): chrome.runtime.Port | null {
  if (port) return port;
  try {
    const p = chrome.runtime.connectNative(HOST);
    p.onMessage.addListener((msg: PipeResponse) => {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    });
    p.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message ?? 'disconnected';
      for (const [, w] of pending) w.reject(new Error(why));
      pending.clear();
      port = null;
      connected = false;
    });
    port = p;
    return p;
  } catch {
    // Host not installed: the extension runs standalone.
    port = null;
    connected = false;
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

/** Handshake: announce ourselves, adopt the app's settings as authoritative. */
export async function hello(): Promise<Settings | null> {
  try {
    const version = chrome.runtime.getManifest().version;
    const res = await send('extension-hello', { version });
    connected = res.ok;
    if (res.ok && res.data?.settings) return saveSettingsLocal(res.data.settings);
    return null;
  } catch {
    connected = false;
    return null;
  }
}

export async function heartbeat(stats: CompanionStats): Promise<void> {
  try {
    const version = chrome.runtime.getManifest().version;
    const res = await send('extension-heartbeat', { version, ...stats });
    connected = res.ok;
    if (res.ok && res.data?.settings) await saveSettingsLocal(res.data.settings);
  } catch {
    connected = false;
  }
}

/**
 * Asks the app to change settings. Returns what the app decided, or throws with its
 * refusal. With no app installed the change is applied locally.
 */
export async function requestSettings(patch: Partial<Settings>, current: Settings): Promise<Settings> {
  const next = { ...DEFAULT_SETTINGS, ...current, ...patch };
  if (!connect()) return saveSettingsLocal(next);

  const res = await send('set-settings', { settings: next });
  if (!res.ok) throw Object.assign(new Error(res.error ?? 'the app refused the change'), { code: res.code });
  return saveSettingsLocal((res.data as unknown as Settings) ?? next);
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
