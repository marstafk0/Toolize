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
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type RevealMode, type Settings, type YouTubeRestrict } from '../shared/settings';
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
const PRESET_STRENGTH: Record<Preset, number> = { strict: 3, balanced: 2, relaxed: 1 };
const YT_STRENGTH: Record<YouTubeRestrict, number> = { off: 0, moderate: 1, strict: 2 };

let currentSettings: Settings = DEFAULT_SETTINGS;
let companionConnected = false;
let lastEngineInfo: EngineInfo | null = null;
const baseLabels = new WeakMap<Element, string>();

function setBadge(el: Element | null, needsKey: boolean): void {
  if (!el) return;
  let base = baseLabels.get(el);
  if (base === undefined) {
    base = el.textContent ?? '';
    baseLabels.set(el, base);
  }
  el.textContent = base;
  if (needsKey) {
    const badge = document.createElement('span');
    badge.className = 'needs-key';
    badge.title = 'Needs your unlock key';
    badge.textContent = '🔒';
    el.append(badge);
  }
}

function renderLockHints(s: Settings): void {
  const gated = companionConnected;
  setBadge(document.querySelector('header h1'), gated && s.enabled);
  setBadge($('blockAdultSites').closest('.row')?.querySelector('h2') ?? null, gated && s.blockAdultSites);
  setBadge($('wordFilter').closest('.row')?.querySelector('h2') ?? null, gated && s.wordFilter);
  setBadge($('safeSearch').closest('.row')?.querySelector('h2') ?? null, gated && s.safeSearch);

  $('preset').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    const val = b.dataset.value as Preset;
    setBadge(b, gated && PRESET_STRENGTH[val] < PRESET_STRENGTH[s.preset]);
  });
  $('mode').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    const val = b.dataset.value as RevealMode;
    setBadge(b, gated && s.mode === 'safe' && val === 'fast');
  });
  $('youtubeRestrict').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    const val = b.dataset.value as YouTubeRestrict;
    setBadge(b, gated && YT_STRENGTH[val] < YT_STRENGTH[s.youtubeRestrict]);
  });
  document.querySelectorAll<HTMLInputElement>('input[data-feed]').forEach((i) => {
    const label = i.closest('.feed')?.querySelector('.label') ?? null;
    setBadge(label, gated && !!s.feeds?.[i.dataset.feed!]);
  });
}

function showLockNote(message: string): void {
  const banner = $('lock-banner');
  const note = $('lock-note');
  note.textContent = message;
  banner.hidden = !message;
}

/** One switch per feed toggle in the catalog. Turning one off again needs the key. */
function buildFeeds(): void {
  const details = $<HTMLDetailsElement>('feeds');
  details.open = localStorage.getItem('feedsOpen') === 'true';
  details.addEventListener('toggle', (e) => {
    if (e.target === details) localStorage.setItem('feedsOpen', String(details.open));
  });
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
  currentSettings = s;
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
  renderLockHints(s);
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
    showLockNote('');
  } else {
    showLockNote(result.error);
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
let copyStatusTimer: ReturnType<typeof setTimeout> | null = null;

function visibleVerdicts(): VerdictEntry[] {
  return tabVerdicts.filter((v) => !$<HTMLInputElement>('verdict-blurred-only').checked || v.decision === 'blocked');
}

function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}

function formatHms(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

function formatVerdictCopy(entries: VerdictEntry[]): string {
  const version = chrome.runtime.getManifest().version;
  const info = lastEngineInfo;
  const engine = info?.ready ? `${info.model} (${info.backend})` : (info?.backend ?? 'unknown');
  const safetyOn = info?.safety === 'webgpu' || entries.some((v) => v.scores.safety !== undefined);
  const header = `Toolize v${version} | preset ${currentSettings.preset} | engine ${engine} | safety ${safetyOn ? 'on' : 'off'}`;
  const lines = entries.map((v) => {
    const s = v.scores;
    const why = v.why.map((w) => w.replace(/\s*>\s*/g, '>')).join('; ');
    const safetyPart = s.safety !== undefined ? `safety ${s.safety.toFixed(2)} ` : '';
    const nsfwShort = `n${s.neutral.toFixed(2)} p${s.porn.toFixed(2)} h${s.hentai.toFixed(2)} s${s.sexy.toFixed(2)} d${s.drawing.toFixed(2)}`;
    const fullPart = `${safetyPart}porn ${s.porn.toFixed(2)} hentai ${s.hentai.toFixed(2)} sexy ${s.sexy.toFixed(2)} neutral ${s.neutral.toFixed(2)} drawing ${s.drawing.toFixed(2)}`;
    const tilesPart = s.tiles ? ` | tiles p${s.tiles.porn.toFixed(2)} h${s.tiles.hentai.toFixed(2)}` : '';
    const framePart = v.frameInfo ? ` | frame ${v.frameInfo.frame} obvious=${v.frameInfo.obvious} [${v.frameInfo.window.join(',')}]` : '';
    return `${formatHms(v.at)} ${v.kind} ${v.decision === 'blocked' ? 'blurred' : 'shown'} ${why} | ${nsfwShort} (${fullPart})${tilesPart} | ${v.preset} ${v.size.w}×${v.size.h}${framePart}`;
  });
  return [header, ...lines].join('\n');
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.append(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function showCopyStatus(ok: boolean, label = 'Copied ✓'): void {
  const status = $('verdict-copy-status');
  const copyBtn = $<HTMLButtonElement>('verdict-copy');
  if (copyStatusTimer) clearTimeout(copyStatusTimer);
  status.className = `hint ${ok ? 'ok' : 'bad'}`;
  status.textContent = ok ? label : 'Could not copy — clipboard access was denied.';
  if (ok) copyBtn.textContent = 'Copied ✓';
  copyStatusTimer = setTimeout(() => {
    status.textContent = '';
    status.className = 'hint';
    copyBtn.textContent = 'Copy as text';
    copyStatusTimer = null;
  }, 1500);
}

function renderVerdicts(): void {
  const rows = visibleVerdicts();
  const signature = JSON.stringify([verdictTabId, rows, tabVerdicts.length]);
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
  $<HTMLButtonElement>('verdict-copy-all').disabled = tabVerdicts.length === 0;
}

function bindVerdicts(): void {
  const section = $<HTMLDetailsElement>('verdicts');
  section.open = localStorage.getItem('verdictsOpen') === 'true';
  section.addEventListener('toggle', (e) => {
    if (e.target === section) localStorage.setItem('verdictsOpen', String(section.open));
  });
  $('verdict-blurred-only').addEventListener('change', renderVerdicts);
  $('verdict-copy').addEventListener('click', async () => {
    const ok = await copyTextWithFallback(formatVerdictCopy(visibleVerdicts()));
    showCopyStatus(ok, 'Copied ✓');
  });
  $('verdict-copy-all').addEventListener('click', async () => {
    const ok = await copyTextWithFallback(formatVerdictCopy(tabVerdicts));
    showCopyStatus(ok, 'Copied all ✓');
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
  const companion: CompanionState = await chrome.runtime.sendMessage({ target: 'background', kind: 'companion' });
  if (companion.installed !== companionConnected) {
    companionConnected = companion.installed;
    renderLockHints(currentSettings);
  }
  $('companion').textContent = companion.installed
    ? 'Toolize app: connected — weakening changes need your key'
    : 'Toolize app: not installed';

  const info: EngineInfo = await chrome.runtime.sendMessage({ target: 'background', kind: 'engineInfo' } satisfies GetEngineInfoRequest);
  lastEngineInfo = info;
  renderVerdicts();
  const el = $('engine');
  const slow = info.backend === 'cpu';
  el.classList.toggle('bad', !info.ready || slow);
  el.textContent = info.ready
    ? `Classifier: ${info.model} · ${info.backend} · ${info.classified} images · ~${info.avgInferMs} ms avg` +
      (slow ? ` — slow fallback (${info.warnings.join('; ')})` : '')
    : `Classifier not ready${info.error ? `: ${info.error}` : '…'}`;
}

(async () => {
  $('lock-dismiss').addEventListener('click', () => showLockNote(''));
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
