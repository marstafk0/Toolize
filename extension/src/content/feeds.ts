import { feedKey, type FeedSite } from '../shared/feeds';
import type { Settings } from '../shared/settings';

/**
 * Applies a site's feed toggles: one <style> of display:none rules, rebuilt when the
 * settings or the page change. These sites are single-page apps, so "the page" is
 * whatever location.href says now, not what loaded.
 */
export class FeedHider {
  private readonly style = document.createElement('style');
  private settings: Settings | null = null;
  private href = '';
  private timer = 0;

  constructor(private readonly site: FeedSite) {
    this.style.dataset.toolize = 'feeds';
  }

  start(): void {
    // No navigation event covers every SPA, so poll; it's a string compare.
    this.timer = setInterval(() => {
      if (location.href !== this.href || !this.style.isConnected) this.apply();
    }, 250);
  }

  stop(): void {
    clearInterval(this.timer);
    this.style.remove();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.apply();
  }

  private apply(): void {
    if (!this.settings) return;
    this.href = location.href;
    const path = location.pathname + location.search;
    // Protection off turns feed control off too.
    const on = this.settings.enabled
      ? this.site.toggles.filter((t) => this.settings!.feeds?.[feedKey(this.site, t)] && (!t.paths || new RegExp(t.paths).test(path)))
      : [];

    for (const t of on) {
      if (!t.redirect) continue;
      const from = new RegExp(t.redirect.from);
      if (from.test(path)) {
        location.replace(path.replace(from, t.redirect.to));
        return;
      }
    }

    const css: string[] = [];
    for (const t of on) {
      css.push(`${t.hide.join(',\n')} { display: none !important; }`);
      if (t.notice) {
        css.push(
          `${t.notice.at}::before { content: ${JSON.stringify(t.notice.text)}; display: block; padding: 24px 0; ` +
            'font: 15px system-ui, sans-serif; opacity: .7; text-align: center; }',
        );
      }
    }
    this.style.textContent = css.join('\n');
    if (!this.style.isConnected) (document.head ?? document.documentElement).append(this.style);
  }
}
