import { loadSettings, onSettingsChanged } from '../shared/settings';
import { BlurEngine } from './engine';
import { hideOverlay, isStale, showOverlay } from './failclosed';
import { watchForAdultLabel } from './labels';

/**
 * Isolated-world entry (document_start, all frames). blur.css is already applied by
 * the manifest, so every image is hidden before this even runs.
 */

const INSTANCE = '__toolizeEngine';
const g = globalThis as unknown as Record<string, BlurEngine | undefined>;

// Injected twice into the same frame (manifest + onInstalled re-injection)? Keep the
// live one. An orphaned instance from before an extension reload is replaced.
if (!g[INSTANCE]?.isAlive()) {
  g[INSTANCE]?.stop();
  const engine = new BlurEngine();
  g[INSTANCE] = engine;
  engine.start();
  const ready = loadSettings().then((s) => engine.setSettings(s));
  onSettingsChanged((s) => engine.setSettings(s));
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
