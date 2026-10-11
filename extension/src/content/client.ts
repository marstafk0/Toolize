import { hashString } from '../shared/hash';
import type { ClassifyRequest, ClassifyResponse, ImageSource } from '../shared/messages';
import type { ClassifyResult } from '../shared/policy';

/**
 * Talks to the offscreen classifier on behalf of every watcher (images, video frames,
 * CSS backgrounds), with a per-page result cache and in-flight de-duplication keyed by
 * URL hash. The same picture used as an <img> and as a CSS background costs one
 * classification, and a repeat URL reveals instantly.
 */
export class ClassifyClient {
  private results = new Map<string, ClassifyResult>();
  private inflight = new Map<string, Promise<ClassifyResult>>();
  /** Set when the extension was reloaded and this script is orphaned. */
  orphaned = false;

  key(url: string): string {
    return hashString(url);
  }

  cached(key: string): ClassifyResult | undefined {
    return this.results.get(key);
  }

  /** Cached or fresh classification, de-duplicated across callers. */
  classify(key: string, source: ImageSource, refine: boolean, testTag?: string): Promise<ClassifyResult> {
    const flightKey = `${key}|${refine ? 1 : 0}`;
    let p = this.inflight.get(flightKey);
    if (!p) {
      p = this.send({ key, source, refine, cache: true, testTag })
        .then((r) => {
          this.results.set(key, r);
          return r;
        })
        .finally(() => this.inflight.delete(flightKey));
      this.inflight.set(flightKey, p);
    }
    return p;
  }

  /**
   * One-shot classification that never touches either cache (live video frames).
   * The key must be unique per call: identical keys are de-duplicated as the same
   * request, which would hand one video's verdict to another.
   */
  classifyFrame(dataUrl: string, testTag?: string): Promise<ClassifyResult> {
    return this.send({ key: `frame:${this.frameSeq++}`, source: { dataUrl }, refine: false, cache: false, testTag });
  }

  private frameSeq = 0;

  private async send(req: Omit<ClassifyRequest, 'target' | 'kind'>): Promise<ClassifyResult> {
    if (!chrome.runtime?.id) {
      // Extension reloaded/updated: this script is orphaned. Anything unresolved stays
      // blurred; the freshly injected instance takes over.
      this.orphaned = true;
      throw new Error('extension context invalidated');
    }
    const res = await this.route(req);
    if (!res.ok) {
      const err = new Error(res.error);
      (err as Error & { fetchFailed?: boolean }).fetchFailed = res.fetchFailed;
      throw err;
    }
    return res.result;
  }

  /** False once a direct request found no classifier listening; reset when one succeeds. */
  private direct = true;

  /**
   * Straight to the offscreen classifier when it's up. Relaying through the service
   * worker doubles the hops and, worse, wakes the worker whenever Chrome has put it to
   * sleep, which it does after 30s idle. The worker path stays as the fallback, since
   * it's the one that creates the classifier document when there isn't one.
   */
  private async route(req: Omit<ClassifyRequest, 'target' | 'kind'>): Promise<ClassifyResponse> {
    if (this.direct) {
      try {
        const res: ClassifyResponse | undefined = await chrome.runtime.sendMessage({ target: 'offscreen', kind: 'classify', ...req } satisfies ClassifyRequest);
        if (res) return res;
      } catch {
        /* no offscreen document yet */
      }
      this.direct = false;
    }
    const res: ClassifyResponse = await chrome.runtime.sendMessage({ target: 'background', kind: 'classify', ...req } satisfies ClassifyRequest);
    // The worker has (re)created the classifier; go direct again from now on.
    this.direct = true;
    return res;
  }
}

export function isFetchFailure(e: unknown): boolean {
  return !!(e as { fetchFailed?: boolean })?.fetchFailed;
}
