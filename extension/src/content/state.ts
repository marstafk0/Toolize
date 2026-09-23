import type { TabStats } from '../shared/messages';

/** Visual state written to `data-tz` — blur.css keys off it. */
export type State = 'pending' | 'fast' | 'clean' | 'blocked' | 'skip' | 'error' | 'off';

const ALL: State[] = ['pending', 'fast', 'clean', 'blocked', 'skip', 'error', 'off'];

/**
 * Owns the `data-tz` attribute on every media element and the per-page counters behind
 * the toolbar badge. Also restores the attribute if the page removes it — a page that
 * strips unknown attributes shouldn't be able to un-blur anything.
 */
export class Stamper {
  private stamped = new WeakMap<Element, State>();
  private counts: Record<State, number> = { pending: 0, fast: 0, clean: 0, blocked: 0, skip: 0, error: 0, off: 0 };

  constructor(private readonly onChange: () => void) {}

  set(el: Element, state: State): void {
    const prev = this.stamped.get(el);
    if (prev === state && el.getAttribute('data-tz') === state) return;
    if (prev) this.counts[prev]--;
    this.counts[state]++;
    this.stamped.set(el, state);
    el.setAttribute('data-tz', state);
    this.onChange();
  }

  get(el: Element): State | undefined {
    return this.stamped.get(el);
  }

  /** Called when someone else edits data-tz; puts our value back. */
  restore(el: Element): void {
    const mine = this.stamped.get(el);
    if (mine && el.getAttribute('data-tz') !== mine) el.setAttribute('data-tz', mine);
  }

  drop(el: Element): void {
    const prev = this.stamped.get(el);
    if (prev) this.counts[prev]--;
    this.stamped.delete(el);
  }

  stats(extraBlocked = 0): TabStats {
    const c = this.counts;
    return {
      checked: c.clean + c.blocked + extraBlocked,
      blocked: c.blocked + extraBlocked,
      pending: c.pending + c.fast,
      errors: c.error,
    };
  }

  get total(): number {
    return ALL.reduce((n, s) => n + this.counts[s], 0);
  }
}
