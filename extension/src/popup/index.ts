import type {
  CompanionState,
  EngineInfo,
  GetEngineInfoRequest,
  GetTabStatsRequest,
  GetTabVerdictsRequest,
  SetSettingsRequest,
  SetSettingsResult,
  TabStats,
} from '../shared/messages';
import { CATALOG, feedKey } from '../shared/feeds';
import { PRESETS, type Preset } from '../shared/policy';
import { loadSettings, onSettingsChanged, type RevealMode, type Settings } from '../shared/settings';
import type { VerdictEntry } from '../shared/verdicts';

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
  $<HTMLInputElement>('wordFilter').checked = s.wordFilter;
  $<HTMLInputElement>('safeSearch').checked = s.safeSearch;
  for (const [group, value] of [['preset', s.preset], ['mode', s.mode], ['youtubeRestrict', s.youtubeRestrict]] as const) {
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

function bindSeg(id: 'preset' | 'mode' | 'youtubeRestrict'): void {
  $(id).addEventListener('click', async (e) => {
    const value = (e.target as HTMLElement).closest('button')?.dataset.value;
    if (value) await change({ [id]: value });
  });
}

let tabVerdicts: VerdictEntry[] = [];
let verdictTabId: number | undefined;
let renderedVerdicts = '';

function visibleVerdicts(): VerdictEntry[] {
  return tabVerdicts.filter((v) => !$<HTMLInputElement>('verdict-blurred-only').checked || v.decision === 'blocked');
}

function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}

function fullScores(v: VerdictEntry): string {
  const { tiles, ...whole } = v.scores;
  const lines = [Object.entries(whole).map(([key, value]) => `${key} ${value.toFixed(2)}`).join(' · ')];
  if (tiles) lines.push(`tiles porn ${tiles.porn.toFixed(2)} · hentai ${tiles.hentai.toFixed(2)}`);
  lines.push(`${v.preset} · ${v.size.w} × ${v.size.h}`);
  if (v.frameInfo) {
    lines.push(`frame ${v.frameInfo.frame} · obvious ${v.frameInfo.obvious} · window ${v.frameInfo.window.join(', ')}`);
  }
  if (v.exempt) lines.push(`exempt ${v.exempt}`);
  return lines.join('\n');
}

function renderVerdicts(): void {
  const rows = visibleVerdicts();
  const signature = JSON.stringify([verdictTabId, rows]);
  if (signature === renderedVerdicts) {
    $('verdict-list').querySelectorAll<HTMLElement>('time').forEach((el) => { el.textContent = timeAgo(Number(el.dataset.at)); });
    return;
  }
  renderedVerdicts = signature;
  const host = $('verdict-list');
  const expanded = new Set([...host.querySelectorAll<HTMLDetailsElement>('details[open]')].map((el) => el.dataset.key));
  host.replaceChildren();
  for (const v of rows) {
    const row = document.createElement('details');
    row.className = 'verdict-row';
    row.dataset.key = JSON.stringify(v);
    row.open = expanded.has(row.dataset.key);
    const summary = document.createElement('summary');
    summary.title = fullScores(v);
    const meta = document.createElement('span');
    meta.className = 'verdict-meta';
    const time = document.createElement('time');
    time.dataset.at = String(v.at);
    time.dateTime = new Date(v.at).toISOString();
    time.textContent = timeAgo(v.at);
    const kind = document.createElement('span');
    kind.textContent = v.kind;
    const pill = document.createElement('span');
    pill.className = `verdict-pill ${v.decision}`;
    pill.textContent = v.decision === 'blocked' ? 'blurred' : 'shown';
    meta.append(time, kind, pill);
    const why = document.createElement('span');
    why.textContent = v.why.join('; ');
    summary.append(meta, why);
    const scores = document.createElement('div');
    scores.className = 'verdict-scores';
    scores.textContent = fullScores(v);
    row.append(summary, scores);
    host.append(row);
  }
  $('verdict-empty').hidden = rows.length > 0;
  $('verdict-empty').textContent = $<HTMLInputElement>('verdict-blurred-only').checked
    ? 'No recent blurred verdicts for this tab.' : 'No recent verdicts for this tab.';
  $<HTMLButtonElement>('verdict-copy').disabled = rows.length === 0;
}

function bindVerdicts(): void {
  const section = $<HTMLDetailsElement>('verdicts');
  section.open = localStorage.getItem('verdictsOpen') === 'true';
  section.addEventListener('toggle', (e) => {
    if (e.target === section) localStorage.setItem('verdictsOpen', String(section.open));
  });
  $('verdict-blurred-only').addEventListener('change', renderVerdicts);
  $('verdict-copy').addEventListener('click', async () => {
    const text = visibleVerdicts().map((v) =>
      `${new Date(v.at).toISOString()} (${timeAgo(v.at)}) · ${v.kind} · ${v.decision === 'blocked' ? 'blurred' : 'shown'}\n${v.why.join('; ')}\n${fullScores(v)}`,
    ).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      $('verdict-copy-status').textContent = 'Copied.';
    } catch {
      $('verdict-copy-status').textContent = 'Could not copy. Try again.';
    }
  });
  renderVerdicts();
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
    const verdicts: VerdictEntry[] = await chrome.runtime.sendMessage({ target: 'background', kind: 'getTabVerdicts', tabId: tab.id } satisfies GetTabVerdictsRequest);
    verdictTabId = tab.id;
    tabVerdicts = verdicts;
  } else {
    verdictTabId = undefined;
    tabVerdicts = [];
  }
  renderVerdicts();
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
  bindVerdicts();
  onSettingsChanged(render);
  render(await loadSettings());
  for (const id of ['enabled', 'blockAdultSites', 'wordFilter', 'safeSearch'] as const) {
    $<HTMLInputElement>(id).addEventListener('change', (e) =>
      change({ [id]: (e.target as HTMLInputElement).checked }),
    );
  }
  bindSeg('preset');
  bindSeg('mode');
  bindSeg('youtubeRestrict');
  await refreshStats();
  setInterval(refreshStats, 1000);
})();
