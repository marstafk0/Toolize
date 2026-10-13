import type { UnlearnSiteRequest, UnlearnSiteResult } from '../shared/messages';

/**
 * The page every blocked site lands on. Says why, and for sites the extension learned
 * by itself (rather than from a list) offers an Unblock button, since those are the
 * ones most likely to be a mistake. Unblocking is a weakening change, so the desktop
 * app asks for the key first.
 */

const params = new URLSearchParams(location.search);
const reason = params.get('reason') ?? 'list';
const site = params.get('site');

const WHY: Record<string, string> = {
  list: 'Toolize blocks known adult sites before they load.',
  images: 'Several explicit images were found on this site, so Toolize now blocks all of it.',
  label: 'This site labels itself as adult content, so Toolize blocks it.',
  words: 'The address or title of this page has a blocked word in it.',
};

const $ = (id: string) => document.getElementById(id)!;
$('why').textContent = WHY[reason] ?? WHY.list;

if (site && (reason === 'images' || reason === 'label')) {
  $('site').textContent = site;
  $('site').hidden = false;
  const button = $('unblock') as HTMLButtonElement;
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    $('status').textContent = 'Checking…';
    const res: UnlearnSiteResult = await chrome.runtime
      .sendMessage({ target: 'background', kind: 'unlearnSite', site } satisfies UnlearnSiteRequest)
      .catch((e: Error) => ({ ok: false, error: e.message }));
    if (res?.ok) {
      $('status').textContent = 'Unblocked.';
      location.replace(`https://${site}/`);
    } else {
      $('status').textContent = res?.error ?? 'Could not unblock.';
      button.disabled = false;
    }
  });
}
