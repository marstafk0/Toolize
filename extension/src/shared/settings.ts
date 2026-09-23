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
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  preset: 'balanced',
  mode: 'safe',
  blockAdultSites: true,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(got[KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings>) });
    }
  });
}
