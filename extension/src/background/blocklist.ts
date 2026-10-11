import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { ADULT_DOMAINS, canLearn, NEVER_BLOCK, siteOf } from '../shared/sites';
import { authorizeWeakening } from './companion';

/**
 * Everything about site blocking that changes after install, as dynamic
 * declarativeNetRequest rules on top of the static list baked into the release:
 *
 * - List updates. The OISD NSFW list changes daily. Once a day we fetch it and apply
 *   the difference from what the release shipped: new domains are blocked, and domains
 *   the maintainers dropped as false positives are let through again. This and the app
 *   update check are the only network requests the product makes, and this one carries
 *   nothing about the user — it is a plain download of a public file.
 * - Learned sites. A site whose own pages show several explicit images, or that labels
 *   itself as adult, is blocked from then on. Kept on this machine only; the desktop
 *   app is told that a site was unblocked, never which.
 *
 * All of it is switched off with blockAdultSites, like the static list.
 */

const LIST_URL = 'https://nsfw.oisd.nl/domainswild2';
const UPDATE_KEY = 'blocklistUpdate';
const LEARNED_KEY = 'learnedSites';
const UPDATE_ALARM = 'blocklist-update';
const UPDATE_EVERY_MIN = 24 * 60;

/** A fresh list smaller than this fraction of the shipped one is treated as broken. */
const MIN_RATIO = 0.8;
/** More removals than this fraction of the shipped list are not believed either. */
const MAX_REMOVED_RATIO = 0.05;

// Dynamic rule ids and priorities. The static list is priority 2, the keyword rule 1.
const ADDED_ID = 2;
const REMOVED_ID = 3;
const LEARNED_BASE_ID = 1000;
const PRIO_ADDED = 2;
const PRIO_REMOVED = 3; // beats the static list and the keyword rule for dropped domains
const PRIO_LEARNED = 4; // beats everything: a learned block is never undone by a list

const ALL_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  'main_frame' as chrome.declarativeNetRequest.ResourceType,
  'sub_frame' as chrome.declarativeNetRequest.ResourceType,
  'image' as chrome.declarativeNetRequest.ResourceType,
  'media' as chrome.declarativeNetRequest.ResourceType,
  'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
];

export type LearnReason = 'images' | 'label';

interface ListUpdate {
  added: string[];
  removed: string[];
  at: number;
}

interface LearnedSite {
  site: string;
  reason: LearnReason;
  at: number;
}

export function blockedPageUrl(reason: string, site?: string): string {
  const q = new URLSearchParams({ reason, ...(site ? { site } : {}) });
  return `/blocked/blocked.html?${q}`;
}

async function blockingEnabled(): Promise<boolean> {
  const { settings } = await chrome.storage.local.get('settings');
  return (settings as Settings | undefined)?.blockAdultSites ?? DEFAULT_SETTINGS.blockAdultSites;
}

async function readLearned(): Promise<LearnedSite[]> {
  return ((await chrome.storage.local.get(LEARNED_KEY))[LEARNED_KEY] as LearnedSite[] | undefined) ?? [];
}

/** Rebuilds every dynamic rule from storage. Idempotent; call after any change. */
export async function syncDynamicRules(): Promise<void> {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  if (await blockingEnabled()) {
    const update = (await chrome.storage.local.get(UPDATE_KEY))[UPDATE_KEY] as ListUpdate | undefined;
    if (update?.added.length) {
      rules.push({
        id: ADDED_ID, priority: PRIO_ADDED,
        action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: blockedPageUrl('list') } },
        condition: { requestDomains: update.added, resourceTypes: ALL_TYPES },
      });
    }
    if (update?.removed.length) {
      rules.push({
        id: REMOVED_ID, priority: PRIO_REMOVED,
        action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
        condition: { requestDomains: update.removed, resourceTypes: ALL_TYPES },
      });
    }
    (await readLearned()).forEach((l, i) =>
      rules.push({
        id: LEARNED_BASE_ID + i, priority: PRIO_LEARNED,
        action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: blockedPageUrl(l.reason, l.site) } },
        condition: { requestDomains: [l.site], resourceTypes: ALL_TYPES },
      }),
    );
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
}

// ---------------------------------------------------------------- list updates

function parseList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (line && !line.startsWith('#') && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(line)) out.push(line);
  }
  return out;
}

/** The list baked into this release, read back from the packaged ruleset. */
async function shippedDomains(): Promise<string[]> {
  const rules = (await (await fetch(chrome.runtime.getURL('rules/adult.json'))).json()) as chrome.declarativeNetRequest.Rule[];
  return rules.find((r) => r.id === 1)?.condition.requestDomains ?? [];
}

/**
 * Fetches the current list and applies its difference from the shipped one. Refuses a
 * download that looks truncated or hijacked: protection only ever shrinks slowly.
 */
export async function updateList(url = LIST_URL): Promise<{ added: number; removed: number }> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`blocklist: HTTP ${res.status}`);
  const fresh = parseList(await res.text());
  const shipped = await shippedDomains();
  if (fresh.length < shipped.length * MIN_RATIO) {
    throw new Error(`blocklist: ${fresh.length} domains against ${shipped.length} shipped — ignored`);
  }

  const shippedSet = new Set(shipped);
  const freshSet = new Set(fresh);
  const never = new Set(NEVER_BLOCK);
  const seed = new Set(ADULT_DOMAINS);
  const added = fresh.filter((d) => !shippedSet.has(d) && !never.has(d));
  // Our own seed list is never unblocked by someone else's list.
  let removed = shipped.filter((d) => !freshSet.has(d) && !seed.has(d));
  if (removed.length > shipped.length * MAX_REMOVED_RATIO) removed = [];

  await chrome.storage.local.set({ [UPDATE_KEY]: { added, removed, at: Date.now() } satisfies ListUpdate });
  await syncDynamicRules();
  return { added: added.length, removed: removed.length };
}

/** Daily, and soon after startup when the last update is stale. */
export function scheduleListUpdates(): void {
  void chrome.alarms.get(UPDATE_ALARM).then((a) => {
    if (!a) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_EVERY_MIN, delayInMinutes: 1 });
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== UPDATE_ALARM) return;
    void (async () => {
      if (!(await blockingEnabled())) return;
      const last = (await chrome.storage.local.get(UPDATE_KEY))[UPDATE_KEY] as ListUpdate | undefined;
      if (last && Date.now() - last.at < (UPDATE_EVERY_MIN - 60) * 60_000) return;
      await updateList().catch((e) => console.warn('[toolize]', e?.message ?? e));
    })();
  });
}

// ---------------------------------------------------------------- learned sites

/**
 * Blocks the site behind `url` from now on. Returns the blocked-page URL to show, or
 * null when this host is never learned (big user-content platforms, local addresses).
 */
export async function learn(url: string, reason: LearnReason): Promise<string | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!canLearn(host) || !(await blockingEnabled())) return null;
  const site = siteOf(host);
  const learned = await readLearned();
  if (!learned.some((l) => l.site === site)) {
    learned.push({ site, reason, at: Date.now() });
    await chrome.storage.local.set({ [LEARNED_KEY]: learned });
    await syncDynamicRules();
  }
  return chrome.runtime.getURL(blockedPageUrl(reason, site));
}

/** Unblocking is a weakening change: the desktop app must see the key first. */
export async function unlearn(site: string): Promise<{ ok: boolean; error?: string }> {
  const learned = await readLearned();
  if (!learned.some((l) => l.site === site)) return { ok: true };
  const auth = await authorizeWeakening('unblocking a site the extension learned');
  if (!auth.ok) return auth;
  await chrome.storage.local.set({ [LEARNED_KEY]: learned.filter((l) => l.site !== site) });
  await syncDynamicRules();
  return { ok: true };
}
