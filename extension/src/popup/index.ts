import type {
  CompanionState,
  EngineInfo,
  GetEngineInfoRequest,
  GetTabStatsRequest,
  SetSettingsRequest,
  SetSettingsResult,
  TabStats,
} from '../shared/messages';
import { CATALOG, feedKey } from '../shared/feeds';
import { PRESETS, type Preset } from '../shared/policy';
import { loadSettings, type RevealMode, type Settings } from '../shared/settings';

// Settings shown here are a cache of what the desktop app holds. When the app is
// installed it has the final say; without it, the extension manages its own settings.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PRESET_HINTS: Record<Preset, string> = {
  strict: 'Blurs more — expect some false positives (beach, sport, art).',
  balanced: 'Recommended starting point.',
  relaxed: 'Only clear explicit content. Fewer false positives.',
};
const MODE_HINTS: Record<RevealMode, string> = {
  safe: 'Images stay blurred until checked. No flashes.',
  fast: 'Images show immediately; flagged ones blur after checking. Can flash.',
};

/** One switch per feed toggle in the catalog. Turning one off again needs the key. */
function buildFeeds(): void {
  const host = $('feed-sites');
  for (const site of CATALOG) {
    const h = document.createElement('h3');
    h.textContent = site.name;
    host.append(h);
    for (const t of site.toggles) {
      const row = document.createElement('label');
      row.className = 'feed';
      row.title = t.hint;
      const name = document.createElement('span');
      name.className = 'label';
      name.textContent = `Hide ${t.label.toLowerCase()}`;
      const sw = document.createElement('span');
      sw.className = 'switch';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.feed = feedKey(site, t);
      sw.append(input, document.createElement('span'));
      row.append(name, sw);
      host.append(row);
    }
  }
  host.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.feed) return;
    const feeds = { ...(await loadSettings()).feeds, [input.dataset.feed]: input.checked };
    await change({ feeds });
  });
}

function render(s: Settings): void {
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLInputElement>('blockAdultSites').checked = s.blockAdultSites;
  for (const [group, value] of [['preset', s.preset], ['mode', s.mode]] as const) {
    $(group).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
  }
  const t = PRESETS[s.preset];
  $('preset-hint').textContent = `${PRESET_HINTS[s.preset]} (porn>${t.porn}, hentai>${t.hentai}, sexy>${t.sexy})`;
  $('mode-hint').textContent = MODE_HINTS[s.mode];
  document.querySelectorAll<HTMLInputElement>('input[data-feed]').forEach((i) => (i.checked = !!s.feeds?.[i.dataset.feed!]));
  document.body.style.opacity = s.enabled ? '1' : '0.75';
}

/**
 * Settings changes go through the background worker, which asks the desktop app when
 * it's installed. A refusal (locked) comes back as an error we show verbatim — the
 * popup never decides for itself whether a change is allowed.
 */
async function change(patch: Record<string, unknown>): Promise<void> {
  const req: SetSettingsRequest = { target: 'background', kind: 'setSettings', patch };
  const result: SetSettingsResult = await chrome.runtime.sendMessage(req);
  if (result.ok) {
    render(result.settings as unknown as Settings);
    $('lock-note').textContent = '';
  } else {
    $('lock-note').textContent = result.error;
    render(await loadSettings()); // snap the controls back to what's actually in force
  }
}

function bindSeg(id: 'preset' | 'mode'): void {
  $(id).addEventListener('click', async (e) => {
    const value = (e.target as HTMLElement).closest('button')?.dataset.value;
    if (value) await change({ [id]: value });
  });
}

async function refreshStats(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    const req: GetTabStatsRequest = { target: 'background', kind: 'getTabStats', tabId: tab.id };
    const s: TabStats = await chrome.runtime.sendMessage(req);
    $('s-checked').textContent = String(s.checked);
    $('s-blocked').textContent = String(s.blocked);
    $('s-pending').textContent = String(s.pending);
    $('s-errors').textContent = String(s.errors);
  }
  const companion: CompanionState = await chrome.runtime.sendMessage({ target: 'background', kind: 'companion' });
  $('companion').textContent = companion.installed
    ? 'Toolize app: connected — settings are managed there'
    : 'Toolize app: not installed';

  const info: EngineInfo = await chrome.runtime.sendMessage({ target: 'background', kind: 'engineInfo' } satisfies GetEngineInfoRequest);
  const el = $('engine');
  const slow = info.backend === 'cpu';
  el.classList.toggle('bad', !info.ready || slow);
  el.textContent = info.ready
    ? `Classifier: ${info.model} · ${info.backend} · ${info.classified} images · ~${info.avgInferMs} ms avg` +
      (slow ? ` — slow fallback (${info.warnings.join('; ')})` : '')
    : `Classifier not ready${info.error ? `: ${info.error}` : '…'}`;
}

(async () => {
  buildFeeds();
  render(await loadSettings());
  for (const id of ['enabled', 'blockAdultSites'] as const) {
    $<HTMLInputElement>(id).addEventListener('change', (e) =>
      change({ [id]: (e.target as HTMLInputElement).checked }),
    );
  }
  bindSeg('preset');
  bindSeg('mode');
  await refreshStats();
  setInterval(refreshStats, 1000);
})();
