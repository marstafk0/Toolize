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
  /** P(block) from the safety model, when it ran (see ClassifyResult.safety). */
  safety: number;
  /** NSFWJS "sexy" that still blocks beside the safety model (swimwear it underrates). */
  sexyBesideSafety: number;
}

export type Preset = 'strict' | 'balanced' | 'relaxed';

export const PRESETS: Record<Preset, Thresholds> = {
  strict: { porn: 0.35, hentai: 0.35, sexy: 0.55, safety: 0.3, sexyBesideSafety: 0.75 },
  balanced: { porn: 0.55, hentai: 0.55, sexy: 0.75, safety: 0.5, sexyBesideSafety: 0.85 },
  relaxed: { porn: 0.75, hentai: 0.75, sexy: 0.9, safety: 0.75, sexyBesideSafety: 0.95 },
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
  /**
   * P(block) from the safety model (CLIP RN50 + a head trained on labelled NSFW/SFW
   * images and hard negatives), max over frames. Present when it ran — it needs WebGPU;
   * without it, decisions fall back to NSFWJS alone. When present it decides, with NSFWJS
   * "sexy" as a second trigger: held out, 98.1% of NSFW caught at 2.6% false positives,
   * against 86.5% / 7.9% for NSFWJS alone (tools/safety-model/).
   */
  safety?: number;
  width: number;
  height: number;
}

export type Decision = 'clean' | 'blocked' | 'refine';

/**
 * Explicit rather than merely revealing: porn or hentai over threshold. Used to learn a
 * whole site from its images; "sexy" alone (swimwear, lingerie shops) never counts.
 */
export function isExplicit(r: ClassifyResult, t: Thresholds): boolean {
  // Learning blocks a whole site, so it wants a confident call, and one that leans
  // explicit rather than swimwear (NSFWJS tells those apart; the safety model doesn't).
  if (r.safety !== undefined) {
    return r.safety > Math.max(t.safety, LEARN_SAFETY) && r.whole.porn + r.whole.hentai > r.whole.sexy;
  }
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
/** The same for the safety model, whose scores sit nearer 0 and 1. */
const OBVIOUS_SAFETY_MARGIN = 0.4;
/** Safety score an image needs to count toward learning a whole site as adult. */
const LEARN_SAFETY = 0.85;

export function isObviouslyExplicit(r: ClassifyResult, t: Thresholds): boolean {
  if (r.safety !== undefined) return r.safety > Math.min(0.97, t.safety + OBVIOUS_SAFETY_MARGIN);
  const s = r.whole;
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
  // The safety model sees the whole picture and was trained on the close-ups
  // that fool NSFWJS (skin, rashes, meat), so its call stands; no tiles. NSFWJS tiles
  // were themselves a main source of false positives.
  if (r.safety !== undefined) return r.safety > t.safety || r.whole.sexy > t.sexyBesideSafety ? 'blocked' : 'clean';
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
