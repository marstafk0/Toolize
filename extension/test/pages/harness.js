// Page-side (MAIN world) fixtures + probes for test/pages/index.html.
// The e2e runner calls window.__bbCollect() / __bbFlashChecks() etc.

const closedRoots = [];
const shadowImg = (name, flag, expect) =>
  `<img data-expect="${expect}" src="/img/220x160/${name}${flag ? '__tz_test_flag' : ''}.png">`;

class XOpen extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }
  connectedCallback() {
    if (this.shadowRoot.firstChild) return;
    const flag = this.dataset.flag === '1';
    this.shadowRoot.innerHTML = shadowImg(`open-${flag ? 'f' : 'c'}`, flag, this.dataset.expect ?? 'clean');
  }
}

class XClosed extends HTMLElement {
  #root;
  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'closed' });
    closedRoots.push(this.#root);
  }
  connectedCallback() {
    if (!this.#root.firstChild) this.#root.innerHTML = shadowImg('closed', false, 'clean');
  }
}

// Lit-style: attach late, then REPLACE adoptedStyleSheets wholesale before rendering.
const litSheet = new CSSStyleSheet();
litSheet.replaceSync('img { border-radius: 6px; }');
class XLit extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [litSheet];
    root.innerHTML = shadowImg('lit', false, 'clean');
  }
}

class XNest extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: 'open' }).innerHTML = '<x-closed></x-closed><x-open data-flag="1" data-expect="blocked"></x-open>';
  }
}

// Flagged CSS background inside a shadow root (exercises root.elementsFromPoint).
class XBg extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="bg" data-expect="blocked" style="width:220px;height:150px;background-size:cover;' +
      'background-image:url(/img/400x300/bgshadow__tz_test_flag.png)"></div>';
  }
}

customElements.define('x-bg', XBg);
customElements.define('x-open', XOpen);
customElements.define('x-closed', XClosed);
customElements.define('x-lit', XLit);
customElements.define('x-nest', XNest);

function allRoots(scope, out = []) {
  out.push(scope);
  for (const el of scope.querySelectorAll('*')) if (el.shadowRoot) allRoots(el.shadowRoot, out);
  return out;
}

window.__bbCollect = () => {
  const docs = [['top', document, 0]];
  for (const id of ['frame-same', 'frame-srcdoc']) {
    const f = document.getElementById(id);
    if (f?.contentDocument) docs.push([id, f.contentDocument, f.getBoundingClientRect().top]);
  }
  const scopes = [];
  for (const [where, d, off] of docs) for (const r of allRoots(d)) scopes.push([where + (r === d ? '' : '/shadow'), r, off]);
  for (const r of closedRoots) for (const rr of allRoots(r)) scopes.push(['closed-shadow', rr, 0]);
  const seen = new Set();
  const out = [];
  for (const [where, s, off] of scopes) {
    for (const el of s.querySelectorAll('img[data-expect], video[data-expect], .bg[data-expect]')) {
      if (seen.has(el)) continue;
      seen.add(el);
      const kind = el.localName === 'div' ? 'background' : el.localName;
      out.push({
        where, kind, id: el.id, expect: el.dataset.expect,
        src: (el.currentSrc || el.src || el.style.backgroundImage || '').slice(0, 90),
        // Backgrounds are hide-or-show, not a state machine: map to the same vocabulary.
        state: kind === 'background' ? (el.getAttribute('data-tz-bg') === 'blocked' ? 'blocked' : 'clean') : el.getAttribute('data-tz'),
        paused: el.localName === 'video' ? el.paused : undefined,
        docTop: Math.round(off + el.getBoundingClientRect().top + scrollY), // position in the top document
      });
    }
  }
  return out;
};

// Synchronously after insertion — before any frame — the image must already be blurred.
window.__bbFlashChecks = () => {
  const results = {};
  const probe = (name, host, getImg) => {
    document.body.append(host);
    const img = getImg();
    results[name] = img ? getComputedStyle(img).filter : 'NO IMG';
    host.remove();
  };
  const light = document.createElement('div');
  light.innerHTML = '<img src="/img/200x200/flash-light.png">';
  probe('light-dom', light, () => light.querySelector('img'));
  const open = document.createElement('x-open');
  probe('open-shadow', open, () => open.shadowRoot.querySelector('img'));
  const lit = document.createElement('x-lit');
  probe('lit-overwrite', lit, () => lit.shadowRoot.querySelector('img'));
  return results;
};

/**
 * Records short clips in the browser and wires up the video fixtures:
 *   blob:  MSE-style page-origin source (canvas readable)
 *   file:  cross-origin without CORS (canvas tainted → offscreen whole-file path)
 *   drm:   fakes an `encrypted` event, which should leave the video alone
 */
window.__setupVideos = async () => {
  const clip = await recordClip();
  // Two copies under different names: the classifier caches by URL, and these two
  // fixtures need different verdicts.
  await Promise.all([
    fetch('/upload/clip-a.webm', { method: 'POST', body: clip }),
    fetch('/upload/clip-b.webm', { method: 'POST', body: clip }),
  ]);
  const blobUrl = URL.createObjectURL(clip);
  const crossOrigin = (n) => `http://127.0.0.1:8788/media/clip-${n}.webm`;

  const add = (src, expect, test, extra = {}) => {
    const v = document.createElement('video');
    Object.assign(v, { src, muted: true, loop: true, autoplay: true, playsInline: true, ...extra });
    v.dataset.expect = expect;
    if (test) v.dataset.tzTest = test;
    document.getElementById('videos').append(v);
    v.play().catch(() => {});
    return v;
  };

  add(blobUrl, 'clean');
  add(blobUrl, 'blocked', '__tz_test_flag');
  add(crossOrigin('a'), 'clean');
  add(crossOrigin('b'), 'blocked', '__tz_test_flag');
  const drm = add(blobUrl, 'skip', '__tz_test_flag');
  drm.dispatchEvent(new Event('encrypted')); // pretend Widevine: unreadable, left alone
};

/** Picture-in-Picture must be refused — it renders outside the page, unfiltered. */
window.__tryPip = async () => {
  const v = document.querySelector('#videos video');
  try {
    await v.requestPictureInPicture();
    return 'allowed';
  } catch (e) {
    return e.name;
  }
};

async function recordClip(ms = 1200) {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 240;
  const ctx = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start();
  const end = performance.now() + ms;
  await new Promise((resolve) => {
    const frame = (now) => {
      const g = ctx.createLinearGradient(0, 0, 320, 240);
      g.addColorStop(0, `hsl(${(now / 10) % 360} 60% 55%)`);
      g.addColorStop(1, '#22313f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 320, 240);
      now < end ? requestAnimationFrame(frame) : resolve();
    };
    requestAnimationFrame(frame);
  });
  await new Promise((r) => (rec.onstop = r, rec.stop()));
  return new Blob(chunks, { type: 'video/webm' });
}

window.__swap = () => {
  document.getElementById('swap').src = '/img/300x200/swap-b__tz_test_flag.png';
  document.getElementById('swap').dataset.expect = 'blocked';
};

let batch = 0;
window.__appendBatch = (n) => {
  const feed = document.getElementById('feed');
  for (let i = 0; i < n; i++) {
    const k = batch * 100 + i;
    const flag = i % 5 === 4;
    const img = document.createElement('img');
    img.dataset.expect = flag ? 'blocked' : 'clean';
    img.src = `/img/180x120/feed-${k}${flag ? '__tz_test_flag' : ''}.png`;
    feed.append(img);
  }
  batch++;
};

addEventListener('DOMContentLoaded', async () => {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 160;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 200, 160);
  g.addColorStop(0, '#3a7bd5');
  g.addColorStop(1, '#f0c27b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 200, 160);
  const dataImg = new Image();
  dataImg.dataset.expect = 'clean';
  dataImg.src = c.toDataURL('image/png');
  document.getElementById('dataurl-slot').append(dataImg);

  const blob = await (await fetch('/img/260x180/blob.png')).blob();
  const blobImg = new Image();
  blobImg.dataset.expect = 'clean';
  blobImg.src = URL.createObjectURL(blob);
  document.getElementById('blob-slot').append(blobImg);
});
