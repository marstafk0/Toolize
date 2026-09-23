import type { ClassifyResult } from './policy';

/**
 * Media handed to the classifier.
 *  url:      offscreen doc fetches it itself (host permissions bypass CORS).
 *  dataUrl:  pixels already extracted by the content script (blob: URLs, live video
 *            frames, or when the offscreen fetch failed).
 *  videoUrl: offscreen doc fetches the file and samples frames across its duration —
 *            used when the page's <video> taints a canvas (cross-origin, no CORS).
 */
export type ImageSource = { url: string } | { dataUrl: string } | { videoUrl: string };

export interface ClassifyRequest {
  target: 'background' | 'offscreen';
  kind: 'classify';
  key: string;
  source: ImageSource;
  /** Also score full-resolution tiles (borderline refinement). */
  refine: boolean;
  /** Live video frames are one-shot: don't pollute the result cache with them. */
  cache: boolean;
  /** Dev builds only: forces scores so tests can drive the blocked/borderline paths. */
  testTag?: string;
}

export type ClassifyResponse =
  | { ok: true; result: ClassifyResult }
  | { ok: false; error: string; /** true when the offscreen fetch itself failed */ fetchFailed: boolean };

export interface TabStats {
  checked: number;
  blocked: number;
  pending: number;
  errors: number;
}

export interface StatsReport {
  target: 'background';
  kind: 'stats';
  stats: TabStats;
}

export interface GetTabStatsRequest {
  target: 'background';
  kind: 'getTabStats';
  tabId: number;
}

export interface EngineInfo {
  ready: boolean;
  backend: string;
  model: string;
  /** Model load + warm-up time; -1 until loaded. */
  loadMs: number;
  classified: number;
  avgInferMs: number;
  cacheSize: number;
  /** Backend fallback reasons, e.g. no hardware WebGL. */
  warnings: string[];
  /** Background shader warm-up still running. */
  warming: boolean;
  error?: string;
}

export interface GetEngineInfoRequest {
  target: 'background' | 'offscreen';
  kind: 'engineInfo';
}

/** Popup → background: change settings, routed through the desktop app when installed. */
export interface SetSettingsRequest {
  target: 'background';
  kind: 'setSettings';
  patch: Record<string, unknown>;
}

export type SetSettingsResult =
  | { ok: true; settings: unknown; viaCompanion: boolean }
  | { ok: false; error: string; code?: string };

export interface GetCompanionRequest {
  target: 'background';
  kind: 'companion';
}

export interface CompanionState {
  installed: boolean;
}

export type Message =
  | ClassifyRequest
  | StatsReport
  | GetTabStatsRequest
  | GetEngineInfoRequest
  | SetSettingsRequest
  | GetCompanionRequest;
