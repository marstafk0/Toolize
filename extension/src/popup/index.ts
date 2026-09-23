import type { EngineInfo, GetEngineInfoRequest, GetTabStatsRequest, TabStats } from '../shared/messages';
import { PRESETS, type Preset } from '../shared/policy';
import { loadSettings, saveSettings, type RevealMode, type Settings } from '../shared/settings';

// Phase 1: no lockdown — every control is freely adjustable ("unlocked" trial mode).

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

function render(s: Settings): void {
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLInputElement>('blockAdultSites').checked = s.blockAdultSites;
  for (const [group, value] of [['preset', s.preset], ['mode', s.mode]] as const) {
    $(group).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
  }
  const t = PRESETS[s.preset];
  $('preset-hint').textContent = `${PRESET_HINTS[s.preset]} (porn>${t.porn}, hentai>${t.hentai}, sexy>${t.sexy})`;
  $('mode-hint').textContent = MODE_HINTS[s.mode];
  document.body.style.opacity = s.enabled ? '1' : '0.75';
}

function bindSeg(id: 'preset' | 'mode'): void {
  $(id).addEventListener('click', async (e) => {
    const value = (e.target as HTMLElement).closest('button')?.dataset.value;
    if (value) render(await saveSettings({ [id]: value }));
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
  render(await loadSettings());
  for (const id of ['enabled', 'blockAdultSites'] as const) {
    $<HTMLInputElement>(id).addEventListener('change', async (e) =>
      render(await saveSettings({ [id]: (e.target as HTMLInputElement).checked })),
    );
  }
  bindSeg('preset');
  bindSeg('mode');
  await refreshStats();
  setInterval(refreshStats, 1000);
})();
