/**
 * Fail-closed overlay.
 *
 * When the desktop app has told us protection is enforced, losing contact with it means
 * something is wrong — the service stopped, was killed, or the machine was tampered
 * with. Carrying on as if nothing happened would make "kill the app" the easiest bypass
 * in the product, so after a grace period pages are covered instead.
 *
 * The grace period is generous on purpose. A service restart, an update, or a laptop
 * waking from sleep must not blank someone's browser; only a sustained absence should.
 */

const GRACE_MS = 10 * 60 * 1000;
const OVERLAY_ID = 'toolize-protection-unavailable';

export function isStale(cache: { enforced: boolean; lastSeen: number }): boolean {
  return cache.enforced && Date.now() - cache.lastSeen > GRACE_MS;
}

export function showOverlay(): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  // A closed shadow root keeps page CSS from restyling the overlay away, and keeps our
  // markup out of the page's own DOM queries.
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .sheet {
        position: fixed; inset: 0; z-index: 2147483647;
        background: #1b1b1a; color: #edebe6;
        font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        display: grid; place-items: center; text-align: center; padding: 2rem;
      }
      h1 { font-size: 1.3rem; margin: 0 0 .75rem; }
      p { margin: .4rem 0; color: #9c988f; max-width: 30rem; }
    </style>
    <div class="sheet">
      <div>
        <h1>Toolize isn't running</h1>
        <p>Protection is switched on for this machine, but the Toolize app hasn't checked in for a while.</p>
        <p>Browsing is paused until it's back. Open the Toolize app, or restart the Toolize service.</p>
      </div>
    </div>`;
  (document.body ?? document.documentElement).append(host);
}

export function hideOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}
