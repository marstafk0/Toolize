import type { TabStats } from '../shared/messages';

/** Visual state written to `data-tz` — blur.css keys off it. */
export type State = 'pending' | 'fast' | 'clean' | 'blocked' | 'skip' | 'error' | 'off';

const ALL: State[] = ['pending', 'fast', 'clean', 'blocked', 'skip', 'error', 'off'];

/** Restores of one element's data-tz allowed within FIGHT_WINDOW_MS (see restore()). */
const MAX_RESTORES = 3;
const FIGHT_WINDOW_MS = 2000;

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

  /**
   * Called when someone else edits data-tz; puts our value back. But not endlessly: a
   * copy of this script left over from before an extension update guards the same
   * attribute, and two guards undoing each other froze the tab. After a few restores in
   * quick succession we let the other writer win. Its states are our own blurred ones
   * (pending, error), so the page stays safe.
   */
  restore(el: Element): void {
    const mine = this.stamped.get(el);
    if (!mine || el.getAttribute('data-tz') === mine) return;
    const now = performance.now();
    const fight = this.fights.get(el);
    if (fight && now - fight.since < FIGHT_WINDOW_MS) {
      if (++fight.count > MAX_RESTORES) return;
    } else {
      this.fights.set(el, { since: now, count: 1 });
    }
    el.setAttribute('data-tz', mine);
  }

  private fights = new WeakMap<Element, { since: number; count: number }>();

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
