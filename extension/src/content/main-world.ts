import blurCss from '../shared/blur.css';

/**
 * MAIN-world hook, runs at document_start before any page script.
 *
 * Manifest CSS doesn't pierce shadow DOM, and component frameworks (Reddit's Lit-based
 * UI in particular) render most media inside shadow roots. Without this, those images
 * would paint unblurred until the isolated-world engine found them = flash of content.
 *
 * 1. Every new shadow root (open OR closed) adopts the blur sheet synchronously.
 * 2. Frameworks overwrite `adoptedStyleSheets` wholesale (Lit does, right after
 *    attachShadow) — the setter is wrapped so our sheet is always re-appended.
 * 3. The host gets a `data-tz-shadow` marker (deferred one task, see below) so the
 *    isolated world can find the root via chrome.dom.openOrClosedShadowRoot and start
 *    classifying inside it.
 */
(() => {
  const FLAG = Symbol.for('toolize.shadow-hook');
  const w = window as unknown as Record<symbol, boolean>;
  if (w[FLAG]) return;
  w[FLAG] = true;

  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(blurCss);
  } catch {
    return;
  }

  const desc = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
  if (desc?.get && desc.set) {
    const { get, set } = desc;
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      configurable: true,
      enumerable: desc.enumerable,
      get,
      set(this: ShadowRoot, value: CSSStyleSheet[]) {
        const next = Array.from(value);
        if (!next.includes(sheet)) next.push(sheet);
        set.call(this, next);
      },
    });
  }

  // Marker must wait a full task, not a microtask: the parser runs a microtask
  // checkpoint right after a custom element constructor returns, then throws if the
  // element gained attributes. Images inside are already blurred by the adopted sheet,
  // so the delay only postpones the reveal slightly.
  let pending: Element[] = [];
  const flush = () => {
    const hosts = pending;
    pending = [];
    for (const h of hosts) {
      try {
        h.setAttribute('data-tz-shadow', '');
      } catch {
        /* ignore */
      }
    }
  };

  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = attachShadow.call(this, init);
    try {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      /* ignore */
    }
    if (pending.push(this) === 1) setTimeout(flush, 0);
    return root;
  };

  // YouTube's player knows whether it is playing a live stream; nothing in the DOM says
  // so reliably (duration is finite and barely moves, and the page metadata is gone
  // after in-app navigation). Mirror its answer onto the <video> for the isolated
  // world, which only honours it on the live-stream sites.
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    type Player = HTMLElement & { getVideoData?: () => { isLive?: boolean } };
    setInterval(() => {
      const player = document.getElementById('movie_player') as Player | null;
      if (!player) return;
      const v = player.querySelector('video');
      if (!v) return;
      let live = false;
      try {
        live = player.getVideoData?.()?.isLive === true;
      } catch {
        /* player not ready */
      }
      if (live !== v.hasAttribute('data-tz-live')) v.toggleAttribute('data-tz-live', live);
    }, 500);
  }

  // Document Picture-in-Picture opens a separate window the content scripts never see.
  const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow?: unknown } }).documentPictureInPicture;
  if (dpip) {
    try {
      Object.defineProperty(dpip, 'requestWindow', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Picture-in-Picture is disabled', 'NotAllowedError')),
      });
    } catch {
      /* ignore */
    }
  }

  // Picture-in-Picture and remote playback render the video OUTSIDE the page, where our
  // CSS filter doesn't apply — a blurred video would pop out clean. Refuse both.
  const video = window.HTMLVideoElement?.prototype;
  if (video) {
    video.requestPictureInPicture = function () {
      return Promise.reject(new DOMException('Picture-in-Picture is disabled', 'NotAllowedError'));
    };
    try {
      Object.defineProperty(video, 'disablePictureInPicture', {
        configurable: true,
        get: () => true,
        set: () => {},
      });
      Object.defineProperty(video, 'disableRemotePlayback', {
        configurable: true,
        get: () => true,
        set: () => {},
      });
    } catch {
      /* ignore */
    }
  }
})();
