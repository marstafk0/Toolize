/**
 * Classification policy: score shape, sensitivity presets, and the decision rule.
 * Pure functions only — shared by content script, offscreen doc, and corpus tool.
 */

export const CLASS_NAMES = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'] as const;
export type ClassName = (typeof CLASS_NAMES)[number];
export type Scores = Record<ClassName, number>;

export interface Thresholds {
  porn: number;
  hentai: number;
  sexy: number;
}

export type Preset = 'strict' | 'balanced' | 'relaxed';

export const PRESETS: Record<Preset, Thresholds> = {
  strict: { porn: 0.35, hentai: 0.35, sexy: 0.55 },
  balanced: { porn: 0.55, hentai: 0.55, sexy: 0.75 },
  relaxed: { porn: 0.75, hentai: 0.75, sexy: 0.9 },
};

/**
 * A whole-image score within this margin below a threshold is "borderline": the
 * 224px downscale may have hidden detail, so re-score on full-resolution tiles.
 */
export const REFINE_MARGIN = 0.25;

/** Images smaller than this (min side, source pixels) aren't worth tiling. */
export const MIN_TILEABLE_SIDE = 256;

export interface ClassifyResult {
  /** Scores for the whole image squashed to the model input size. */
  whole: Scores;
  /** Per-class max over full-resolution tiles; present only once refined. */
  tiles?: Scores;
  width: number;
  height: number;
}

export type Decision = 'clean' | 'blocked' | 'refine';

/**
 * Explicit rather than merely revealing: porn or hentai over threshold. Used to learn a
 * whole site from its images; "sexy" alone (swimwear, lingerie shops) never counts.
 */
export function isExplicit(r: ClassifyResult, t: Thresholds): boolean {
  const over = (s: Scores) => s.porn > t.porn || s.hentai > t.hentai;
  return over(r.whole) || (!!r.tiles && isBorderline(r.whole, t) && over(r.tiles));
}

export function isFlagged(s: Scores, t: Thresholds): boolean {
  return s.porn > t.porn || s.hentai > t.hentai || s.sexy > t.sexy;
}

/**
 * Worth a closer look on tiles: explicit detail can hide in a 224px downscale, so only
 * porn/hentai count. "Sexy" is about the whole picture (swimwear, a pose); on tiles it
 * fires on any close-up of skin — faces, arms, a product photo — so it's whole-image only.
 */
export function isBorderline(s: Scores, t: Thresholds): boolean {
  return s.porn > t.porn - REFINE_MARGIN || s.hentai > t.hentai - REFINE_MARGIN;
}

/** Explicit by a wide margin: one such video frame is enough to blur. */
export const OBVIOUS_MARGIN = 0.2;

export function isObviouslyExplicit(s: Scores, t: Thresholds): boolean {
  return s.porn > t.porn + OBVIOUS_MARGIN || s.hentai > t.hentai + OBVIOUS_MARGIN;
}

export function isTileable(r: Pick<ClassifyResult, 'width' | 'height'>): boolean {
  return Math.min(r.width, r.height) >= MIN_TILEABLE_SIDE;
}

/**
 * Tiles only count when the whole-image score is borderline under THESE thresholds, so
 * the decision never depends on which preset happened to trigger a refine earlier.
 * 'refine' = borderline, tileable, not yet tile-scored: caller should request tiles.
 */
export function decide(r: ClassifyResult, t: Thresholds): Decision {
  if (isFlagged(r.whole, t)) return 'blocked';
  if (!isBorderline(r.whole, t) || !isTileable(r)) return 'clean';
  if (!r.tiles) return 'refine';
  return r.tiles.porn > t.porn || r.tiles.hentai > t.hentai ? 'blocked' : 'clean';
}

export function maxScores(list: Scores[]): Scores {
  const out = { drawing: 0, hentai: 0, neutral: 0, porn: 0, sexy: 0 };
  for (const s of list) for (const k of CLASS_NAMES) out[k] = Math.max(out[k], s[k]);
  return out;
}
