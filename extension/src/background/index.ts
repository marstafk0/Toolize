import type {
  ClassifyRequest,
  ClassifyResponse,
  CompanionState,
  EngineInfo,
  GetEngineInfoRequest,
  LearnSiteResult,
  Message,
  SetSettingsResult,
  TabStats,
  UnlearnSiteResult,
} from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../shared/settings';
import { hello, isConnected, requestSettings, startHeartbeat } from './companion';
import { learn, scheduleListUpdates, syncDynamicRules, unlearn, updateList } from './blocklist';

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

    case 'setSettings':
      // The desktop app decides when it's installed; otherwise we apply it locally.
      loadSettings()
        .then((current) => requestSettings(msg.patch as Partial<Settings>, current))
        .then(
          (settings) => sendResponse({ ok: true, settings, viaCompanion: isConnected() } satisfies SetSettingsResult),
          (e: Error & { code?: string }) =>
            sendResponse({ ok: false, error: e.message, code: e.code } satisfies SetSettingsResult),
        );
      return true;

    case 'companion':
      sendResponse({ installed: isConnected() } satisfies CompanionState);
      return false;

    case 'learnSite':
      // The frame's own URL as Chrome reports it, not anything the page could claim.
      learn(sender.url ?? '', msg.reason).then(
        (blockedUrl) => sendResponse({ blockedUrl } satisfies LearnSiteResult),
        () => sendResponse({ blockedUrl: null } satisfies LearnSiteResult),
      );
      return true;

    case 'unlearnSite':
      // Only our own blocked page may ask, and it still needs the key.
      if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('blocked/'))) return false;
      unlearn(msg.site).then(sendResponse, (e) =>
        sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies UnlearnSiteResult),
      );
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
  if (area === 'local' && changes.settings) {
    void syncRulesets();
    void syncDynamicRules();
  }
});

scheduleListUpdates();
if (__DEV__) (self as unknown as Record<string, unknown>).__tz = { updateList, learn, syncDynamicRules };

// ---------------------------------------------------------------- install / startup

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // A browser update fires this too, but our scripts in open tabs are still alive then:
  // nothing to redo. (Redoing it re-checked every image in every tab at once.)
  if (reason !== chrome.runtime.OnInstalledReason.INSTALL && reason !== chrome.runtime.OnInstalledReason.UPDATE) return;

  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await syncRulesets();
  // A new release ships a newer static list; the stored difference was against the old
  // one, so drop it and fetch afresh rather than apply a stale delta.
  await chrome.storage.local.remove('blocklistUpdate');
  await syncDynamicRules();
  void updateList().catch((e) => console.warn('[toolize]', e?.message ?? e));

  // Pages open before install/update have no (or an orphaned) content script. Every
  // one gets the blur sheet now, which is cheap and keeps them safe. The engine itself
  // goes into the tabs on screen; the rest get it when they're next looked at, so an
  // update doesn't classify every image in every tab at the same moment.
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id != null && /^(https?|file):/.test(t.url ?? ''));
  const css = chrome.runtime.getManifest().content_scripts?.[1]?.css ?? [];
  for (const tab of tabs) {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id!, allFrames: true }, files: css }).catch(() => {});
  }
  const later = tabs.filter((t) => !t.active).map((t) => t.id!);
  await chrome.storage.session.set({ [REVIVE_KEY]: later });
  for (const tab of tabs) if (tab.active) await reviveTab(tab.id!);
});

/** Tabs opened before an update whose content scripts haven't been re-injected yet. */
const REVIVE_KEY = 'reviveTabs';

async function reviveTab(tabId: number): Promise<void> {
  const [mainWorld, isolated] = chrome.runtime.getManifest().content_scripts ?? [];
  const target = { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({ target, files: mainWorld.js ?? [], world: 'MAIN' });
    await chrome.scripting.executeScript({ target, files: isolated.js ?? [] });
  } catch {
    // Restricted page (web store, etc.), or the tab has gone.
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const pending = ((await chrome.storage.session.get(REVIVE_KEY))[REVIVE_KEY] as number[] | undefined) ?? [];
  if (!pending.includes(tabId)) return;
  await chrome.storage.session.set({ [REVIVE_KEY]: pending.filter((id) => id !== tabId) });
  await reviveTab(tabId);
});

// ---------------------------------------------------------------- desktop app link

/** Totals across every tab, for the app's status display. */
async function companionStats(): Promise<{ blocked: number; checked: number }> {
  const store = await readStats();
  const totals = Object.values(store).map((frames) => sumStats(frames));
  return {
    blocked: totals.reduce((n, s) => n + s.blocked, 0),
    checked: totals.reduce((n, s) => n + s.checked, 0),
  };
}

function connectCompanion(): void {
  void hello().then((settings) => {
    if (settings) console.info('[toolize] settings adopted from the desktop app');
  });
  startHeartbeat(companionStats);
}

// Spin the model up eagerly so the first page load doesn't pay the load cost.
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
  void syncRulesets();
  connectCompanion();
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen();
  connectCompanion();
});
// The service worker also wakes on plain events; make sure the link is re-established.
connectCompanion();
