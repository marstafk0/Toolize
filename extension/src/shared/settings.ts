import type { Preset } from './policy';

/**
 * safe:  media starts blurred, revealed only after classifying clean (default).
 * fast:  media shows immediately, blurred only once flagged (detect-then-blur).
 */
export type RevealMode = 'safe' | 'fast';

export interface Settings {
  enabled: boolean;
  preset: Preset;
  mode: RevealMode;
  /** Block known adult sites at the network layer, before anything loads. */
  blockAdultSites: boolean;
  /** Leave live streams on the LIVE_SITES alone (set in the desktop app; needs the key). */
  allowLiveStreams: boolean;
  /** Feed toggles that are on, keyed "<site>.<toggle>" (see sites/*.json). */
  feeds: Record<string, boolean>;
  /** Block pages and hide YouTube videos whose address or title has a blocked word. */
  wordFilter: boolean;
  /** The user's own words, on top of DEFAULT_WORDS (shared/words.ts). */
  blockedWords: string[];
  /** YouTube channels whose videos and thumbnails skip the image check (shared/channels.ts). */
  trustedChannels: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  preset: 'balanced',
  mode: 'safe',
  blockAdultSites: true,
  allowLiveStreams: false,
  feeds: {},
  wordFilter: true,
  blockedWords: [],
  trustedChannels: [],
};

/** Sites whose live streams `allowLiveStreams` exempts, matched with their subdomains. */
export const LIVE_SITES = ['youtube.com', 'twitch.tv', 'kick.com', 'rumble.com'];

export function isLiveSite(hostname: string): boolean {
  // Dev builds also count the e2e test server, so the exemption can be tested.
  if (__DEV__ && (hostname === 'localhost' || hostname === '127.0.0.1')) return true;
  return LIVE_SITES.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(got[KEY] as Partial<Settings> | undefined) };
}

/**
 * Writes the local cache. Callers that can reach the desktop app should go through it
 * instead (see background/companion.ts) — the app is the authority, this is the copy.
 */
export async function saveSettingsLocal(settings: Settings): Promise<Settings> {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return saveSettingsLocal({ ...(await loadSettings()), ...patch });
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings>) });
    }
  });
}
