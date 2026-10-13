import { siteForHost } from '../shared/feeds';
import { loadSettings, onSettingsChanged, type Settings } from '../shared/settings';
import { BlurEngine } from './engine';
import { hideOverlay, isStale, showOverlay } from './failclosed';
import { FeedHider } from './feeds';
import { watchForAdultLabel } from './labels';
import { WordFilter } from './wordfilter';
import { YouTubeGuard } from './youtube';

/**
 * Isolated-world entry (document_start, all frames). blur.css is already applied by
 * the manifest, so every image is hidden before this even runs.
 */

const INSTANCE = '__toolizeEngine';
const g = globalThis as unknown as Record<string, BlurEngine | undefined>;
const PAGE_PARTS = '__toolizePageParts';
const parts = globalThis as unknown as Record<string, { stop(): void }[] | undefined>;

// Injected twice into the same frame (manifest + onInstalled re-injection)? Keep the
// live one. An orphaned instance from before an extension reload is replaced.
if (!g[INSTANCE]?.isAlive()) {
  g[INSTANCE]?.stop();
  for (const p of parts[PAGE_PARTS] ?? []) p.stop();
  const engine = new BlurEngine();
  g[INSTANCE] = engine;
  engine.start();
  // Feed control and YouTube comments: page chrome, so the top frame only.
  const site = window === window.top ? siteForHost(location.hostname) : undefined;
  const feeds = site ? new FeedHider(site) : null;
  const youtube = site?.id === 'youtube' ? new YouTubeGuard() : null;
  const words =
    window === window.top
      ? new WordFilter(() => {
          for (const v of document.querySelectorAll('video')) v.pause();
          location.replace(chrome.runtime.getURL('blocked/blocked.html?reason=words'));
        })
      : null;
  feeds?.start();
  youtube?.start();
  words?.start();
  parts[PAGE_PARTS] = [feeds, youtube, words].filter((p) => p !== null);

  const apply = (s: Settings): void => {
    engine.setSettings(s);
    feeds?.setSettings(s);
    youtube?.setSettings(s);
    words?.setSettings(s);
  };
  const ready = loadSettings().then(apply);
  onSettingsChanged(apply);
  // A page that labels itself adult is blocked, and its site remembered.
  watchForAdultLabel(() => void ready.then(() => engine.learnSite('label')));

  // Fail closed: if this machine is enforced and the desktop app has gone quiet, cover
  // the page rather than pretending everything is fine.
  const checkEnforcement = async (): Promise<void> => {
    const cache = (await chrome.storage.local.get('enforcement')).enforcement as
      | { enforced: boolean; lastSeen: number }
      | undefined;
    if (cache && isStale(cache)) showOverlay();
    else hideOverlay();
  };
  void checkEnforcement();
  setInterval(() => void checkEnforcement(), 60_000);
}
