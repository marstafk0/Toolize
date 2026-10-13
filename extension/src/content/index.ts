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
/** Dispatched on the document by each new copy of this script; older copies stop. */
const TAKEOVER = 'toolize:takeover';

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
  const enforcementTimer = setInterval(() => void checkEnforcement(), 60_000);

  // After an extension update the previous copy of this script keeps running in every
  // open tab, in an isolated world this one can't see, and Chrome never stops it. Both
  // copies then guard the same data-tz attributes, each putting back its own value when
  // the other changes it: an endless loop that froze every revived tab until the
  // browser restarted. So: a new copy tells any old one to stand down (DOM events cross
  // worlds), and a copy whose extension has gone stands down by itself.
  let stopped = false;
  const standDown = (): void => {
    if (stopped) return;
    stopped = true;
    engine.stop();
    for (const p of parts[PAGE_PARTS] ?? []) p.stop();
    clearInterval(enforcementTimer);
    clearInterval(orphanTimer);
    document.removeEventListener(TAKEOVER, onTakeover);
  };
  const me = Math.random().toString(36).slice(2);
  const onTakeover = (e: Event): void => {
    if ((e as CustomEvent<string>).detail !== me) standDown();
  };
  document.dispatchEvent(new CustomEvent(TAKEOVER, { detail: me }));
  document.addEventListener(TAKEOVER, onTakeover);
  const orphanTimer = setInterval(() => {
    if (!chrome.runtime?.id) standDown(); // the blur sheet stays, so the page stays safe
  }, 2000);
}
