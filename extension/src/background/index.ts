import type {
  ClassifyRequest,
  ClassifyResponse,
  EngineInfo,
  GetEngineInfoRequest,
  Message,
  TabStats,
} from '../shared/messages';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';

/**
 * Service worker: routes classify requests to the offscreen document (creating it on
 * demand), aggregates per-tab stats for the badge. Holds no state that matters across
 * restarts — the SW can be killed at any time.
 */

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// ---------------------------------------------------------------- offscreen lifecycle

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
      justification: 'Decode images and run the local NSFW classifier (canvas + WebGL).',
    })
    .finally(() => (creating = null));
  await creating;
}

async function sendToOffscreen<T>(msg: ClassifyRequest | GetEngineInfoRequest): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await ensureOffscreen();
    try {
      return await chrome.runtime.sendMessage<Message, T>({ ...msg, target: 'offscreen' });
    } catch (e) {
      // Document may still be booting (or was just closed); retry briefly.
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------------- per-tab stats / badge

const STATS_KEY = 'tabStats';
type StatsStore = Record<string, Record<string, TabStats>>; // tabId -> frameId -> stats

async function readStats(): Promise<StatsStore> {
  return ((await chrome.storage.session.get(STATS_KEY))[STATS_KEY] as StatsStore) ?? {};
}

function sumStats(frames: Record<string, TabStats> | undefined): TabStats {
  const total: TabStats = { checked: 0, blocked: 0, pending: 0, errors: 0 };
  for (const s of Object.values(frames ?? {})) {
    total.checked += s.checked;
    total.blocked += s.blocked;
    total.pending += s.pending;
    total.errors += s.errors;
  }
  return total;
}

// Serialize read-modify-write of the session store.
let statsChain: Promise<unknown> = Promise.resolve();
function updateStats(fn: (store: StatsStore) => number | null): void {
  statsChain = statsChain.then(async () => {
    const store = await readStats();
    const tabId = fn(store);
    await chrome.storage.session.set({ [STATS_KEY]: store });
    if (tabId != null) {
      const blocked = sumStats(store[tabId]).blocked;
      await chrome.action.setBadgeText({ tabId, text: blocked ? String(blocked) : '' }).catch(() => {});
    }
  });
}

chrome.tabs.onRemoved.addListener((tabId) =>
  updateStats((s) => {
    delete s[tabId];
    return null;
  }),
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    updateStats((s) => {
      delete s[tabId];
      return tabId;
    });
  }
});

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.target !== 'background') return false;

  switch (msg.kind) {
    case 'classify':
      sendToOffscreen<ClassifyResponse>(msg).then(sendResponse, (e) =>
        sendResponse({ ok: false, error: `offscreen: ${e?.message ?? e}`, fetchFailed: false } satisfies ClassifyResponse),
      );
      return true;

    case 'stats': {
      const tabId = sender.tab?.id;
      if (tabId == null) return false;
      const frameId = sender.frameId ?? 0;
      updateStats((s) => {
        (s[tabId] ??= {})[frameId] = msg.stats;
        return tabId;
      });
      return false;
    }

    case 'getTabStats':
      readStats().then((s) => sendResponse(sumStats(s[msg.tabId])));
      return true;

    case 'engineInfo':
      sendToOffscreen<EngineInfo>(msg).then(sendResponse, (e) =>
        sendResponse({
          ready: false, backend: 'none', model: '', loadMs: -1, classified: 0, avgInferMs: 0, cacheSize: 0, warnings: [], warming: false,
          error: String(e?.message ?? e),
        } satisfies EngineInfo),
      );
      return true;
  }
  return false;
});

// ---------------------------------------------------------------- site blocklist

const ADULT_RULESET = 'adult';

/** Keeps the declarativeNetRequest ruleset in step with the setting. */
async function syncRulesets(): Promise<void> {
  const { settings } = await chrome.storage.local.get('settings');
  const wanted = (settings as Settings | undefined)?.blockAdultSites ?? DEFAULT_SETTINGS.blockAdultSites;
  const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  if (wanted === enabled.includes(ADULT_RULESET)) return;
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    wanted ? { enableRulesetIds: [ADULT_RULESET] } : { disableRulesetIds: [ADULT_RULESET] },
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void syncRulesets();
});

// ---------------------------------------------------------------- install / startup

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await syncRulesets();

  // Pages open before install/update have no (or an orphaned) content script.
  // Inject into them so protection covers existing tabs immediately.
  const manifest = chrome.runtime.getManifest();
  const [mainWorld, isolated] = manifest.content_scripts ?? [];
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !/^(https?|file):/.test(tab.url ?? '')) continue;
    const target = { tabId: tab.id, allFrames: true };
    try {
      await chrome.scripting.insertCSS({ target, files: isolated.css ?? [] });
      await chrome.scripting.executeScript({ target, files: mainWorld.js ?? [], world: 'MAIN' });
      await chrome.scripting.executeScript({ target, files: isolated.js ?? [] });
    } catch {
      // Restricted page (web store, etc.) — nothing to do.
    }
  }
});

// Spin the model up eagerly so the first page load doesn't pay the load cost.
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
  void syncRulesets();
});
chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
