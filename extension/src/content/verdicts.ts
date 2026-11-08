import { MAX_TAB_VERDICTS, verdictEntry } from '../shared/verdicts';
import type { VerdictEntry } from '../shared/verdicts';

/** Bounded, document-local batch, flushed by the engine's existing stats timer. */
export class VerdictLog {
  private entries: VerdictEntry[] = [];

  constructor(private readonly schedule: () => void) {}

  record(...args: Parameters<typeof verdictEntry>): void {
    this.entries.push(verdictEntry(...args));
    if (this.entries.length > MAX_TAB_VERDICTS) this.entries.shift();
    this.schedule();
  }

  take(): VerdictEntry[] {
    const entries = this.entries;
    this.entries = [];
    return entries;
  }
}
