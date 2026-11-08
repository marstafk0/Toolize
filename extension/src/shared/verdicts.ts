import { isBorderline, isFlagged, isTileable, PRESETS, type ClassifyResult, type Preset, type Thresholds } from './policy';

export type Frame = 'flagged' | 'doubtful' | 'clean';
export type VerdictDecision = 'clean' | 'blocked';
export const MAX_TAB_VERDICTS = 60;

/** Scores and policy facts only. Never add media or page identifiers to this shape. */
export interface VerdictEntry {
  at: number;
  kind: 'image' | 'video' | 'background' | 'poster';
  decision: VerdictDecision;
  why: string[];
  scores: {
    safety?: number;
    porn: number;
    hentai: number;
    sexy: number;
    neutral: number;
    drawing: number;
    tiles?: { porn: number; hentai: number };
  };
  preset: Preset;
  size: { w: number; h: number };
  frameInfo?: { frame: Frame; obvious: boolean; window: Frame[] };
  exempt?: 'trusted' | 'live' | 'drm' | 'tiny';
}

export const roundScore = (score: number): number => Math.round(score * 100) / 100;
const scoreText = (score: number): string => score.toFixed(2);

/** Mirrors decide(): safety supersedes NSFWJS, and tiles only count when eligible. */
export function verdictReasons(r: ClassifyResult, t: Thresholds): string[] {
  const why: string[] = [];
  const over = (label: string, score: number, threshold: number, suffix = '') => {
    if (score > threshold) why.push(`${label} ${scoreText(score)} > ${scoreText(threshold)}${suffix}`);
  };
  if (r.safety !== undefined) {
    over('safety', r.safety, t.safety);
    over('sexy', r.whole.sexy, t.sexyBesideSafety, ' (beside safety)');
    return why.length ? why : [`safety ${scoreText(r.safety)}`, `sexy ${scoreText(r.whole.sexy)}`];
  }
  for (const key of ['porn', 'hentai', 'sexy'] as const) over(key, r.whole[key], t[key]);
  if (!isFlagged(r.whole, t) && isBorderline(r.whole, t) && isTileable(r) && r.tiles) {
    over('tiles porn', r.tiles.porn, t.porn);
    over('tiles hentai', r.tiles.hentai, t.hentai);
  }
  return why.length ? why : (['porn', 'hentai', 'sexy'] as const).map((key) =>
    `${key} ${scoreText(r.whole[key])}`);
}

/** Explicitly pick numeric fields; a classifier result must never carry pixels into a log. */
export function verdictEntry(
  kind: VerdictEntry['kind'], decision: VerdictDecision, r: ClassifyResult, preset: Preset,
  frameInfo?: VerdictEntry['frameInfo'], videoWhy?: string,
): VerdictEntry {
  const s = r.whole;
  const scores: VerdictEntry['scores'] = {
    porn: roundScore(s.porn), hentai: roundScore(s.hentai), sexy: roundScore(s.sexy),
    neutral: roundScore(s.neutral), drawing: roundScore(s.drawing),
  };
  if (r.safety !== undefined) scores.safety = roundScore(r.safety);
  if (r.tiles) scores.tiles = { porn: roundScore(r.tiles.porn), hentai: roundScore(r.tiles.hentai) };
  const why = verdictReasons(r, PRESETS[preset]);
  if (videoWhy) why.unshift(videoWhy);
  return {
    at: Date.now(), kind, decision, why, scores, preset,
    size: { w: r.width, h: r.height },
    ...(frameInfo ? { frameInfo } : {}),
  };
}
