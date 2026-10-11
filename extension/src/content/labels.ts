/**
 * Sites that label themselves as adult. Most adult sites carry the RTA label
 * ("Restricted To Adults", RTA-5042-1996-1400-1577-RTA), and Google asks sexually
 * explicit pages to declare `<meta name="rating" content="adult">`. Either is the site
 * telling us directly, which beats any list: it works on sites nobody has listed yet.
 */

const RTA = /RTA-5042-1996-1400-1577-RTA/i;
const SELECTOR = 'meta[name="rating" i], meta[name="rta" i], meta[http-equiv="rating" i], meta[http-equiv="pics-label" i]';

function labelled(): boolean {
  for (const m of document.querySelectorAll<HTMLMetaElement>(SELECTOR)) {
    const content = (m.content ?? '').trim();
    if (RTA.test(content)) return true;
    if (m.name.toLowerCase() === 'rating' && /^adult$/i.test(content)) return true;
  }
  return false;
}

/**
 * Calls `onFound` once if the page labels itself adult. Meta tags live in <head>, so
 * this only watches while the document is being parsed (plus a moment for frameworks
 * that write the head from script), then stops.
 */
export function watchForAdultLabel(onFound: () => void): void {
  let done = false;
  const check = () => {
    if (done || !labelled()) return;
    done = true;
    mo.disconnect();
    onFound();
  };
  const mo = new MutationObserver(check);
  mo.observe(document, { childList: true, subtree: true });
  check();
  const stop = () => setTimeout(() => {
    check();
    mo.disconnect();
  }, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stop, { once: true });
  else stop();
}
