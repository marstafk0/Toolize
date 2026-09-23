import { loadSettings, onSettingsChanged } from '../shared/settings';
import { BlurEngine } from './engine';

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
  loadSettings().then((s) => engine.setSettings(s));
  onSettingsChanged((s) => engine.setSettings(s));
}
