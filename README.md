# Toolize — PC Edition

An accountability and focus tool for Windows. It is built from three parts:

1. **Chrome/Edge extension** that blurs explicit or immodest images *inside* the pages you visit, one image at a time.
2. **Windows companion app** (planned) that makes the extension hard to tamper with.
3. **Physical unlock key** (planned). Protection can only be weakened while a YubiKey or keyfile USB drive is plugged in.

## Privacy

**Everything runs on your machine.** Image analysis uses a model bundled inside the extension. The extension sends no images, URLs, screenshots or browsing data anywhere. There is no backend, account or telemetry, and it has no network dependency.

The extension downloads each image a second time from inside its own sandbox so it can read the pixels. That request goes to the site that already served the image. Nothing is sent anywhere else.

## Honest limits

Anyone with admin rights on a machine can defeat software running on it. The goal is to turn "3 clicks" into "deliberate technical effort", not to be unbeatable. The physical key only helps if someone else keeps it, such as an accountability partner, or if it lives somewhere deliberately inconvenient. The software can't enforce that.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Blur engine MVP: images, safe-reveal, presets | **done** |
| 2 | Video, CSS backgrounds, adult-site blocklist | **done** |
| 3 | Feed toggles (YouTube/X/Reddit/…) + sites catalog | — |
| 4 | Companion app: heartbeat, policy install, watchdog | — |
| 5 | Physical key unlock (keyfile, then YubiKey HMAC) | — |
| 6 | Installer + hardening | — |

## Extension: build & load

```sh
cd extension
npm install
npm run build          # production build -> extension/dist
```

To load it, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `extension/dist`. Edge works the same way at `edge://extensions`.

## How the blur engine works

- **Safe reveal (default).** A stylesheet injected before first paint blurs every `<img>`. An image is only revealed once the classifier has scored it as clean, so explicit content never flashes on screen. If anything fails, the image stays blurred. The alternative "detect, then blur" mode shows images immediately and blurs the ones that get flagged.
- **Shadow DOM.** Sites like Reddit render media inside web components. A MAIN-world hook adopts the blur stylesheet into every shadow root, including closed ones and ones where the framework replaces `adoptedStyleSheets`.
- **Classification.** NSFWJS MobileNetV2 runs on TF.js in an offscreen document. It uses the WebGL backend when a GPU is available and SIMD WASM otherwise. It classifies images in batches, caches results by URL hash, and never touches the page's own JS context.
- **Scheduling.** An image is only classified once it is within about 1200px of the viewport, and visible images go first. Inference runs in the extension's own process, so page scrolling never waits on the model.
- **Borderline images.** When a score falls within 0.25 below a threshold, the image is scored again on overlapping full-resolution tiles.
- **Video.** Playing videos near the viewport are sampled about once a second. A video is blurred and paused if any of the last 3 frames is flagged, and only revealed after 3 clean frames in a row, so borderline clips don't strobe. Stable clean videos back off to one check every few seconds, and sampling drops to one video at a time when the classifier is the bottleneck, so live frames can't starve images. Frames come from the page canvas; for a cross-origin file without CORS the offscreen document refetches the file and samples it there. DRM video (anything using EME) can't be read by anyone, so it's left alone — a site shipping Widevine is a streaming service, and actual adult sites are blocked before this matters. Picture-in-Picture and remote playback are refused, because both render outside the page where the blur doesn't apply.
- **CSS backgrounds.** A grid of points across the viewport is sampled after scrolls and mutations, in idle time, which finds the large hero and thumbnail backgrounds without walking the DOM. Flagged elements have the background removed rather than blurred, since a filter would blur the element's text and children too. These are detect-then-hide rather than safe-reveal: hiding every background before classification would gut the layout of every site.
- **Adult sites** are blocked before they load, by a `declarativeNetRequest` ruleset covering a seed domain list plus a two-tier hostname heuristic. Unambiguous words ("porn", "xxx") match anywhere in the hostname; words that occur in ordinary English ("sex", "anal") only match a whole label, so `sussex.ac.uk` and `analytics.google.com` are unaffected. This is a seed list, not a comprehensive filter; the classifier remains the backstop, and the companion app's DNS filter is what will cover non-browser traffic.
- **Presets.** Blur if any listed score is above its threshold:

  | Preset | porn | hentai | sexy |
  |---|---|---|---|
  | strict | 0.35 | 0.35 | 0.55 |
  | balanced | 0.55 | 0.55 | 0.75 |
  | relaxed | 0.75 | 0.75 | 0.90 |

## Testing

```sh
npm run typecheck
npm run test:e2e             # headless end-to-end run in Playwright's Chromium
NO_GPU=1 npm run test:e2e    # same, forcing the GPU-less WASM path
npm run corpus               # false-positive / false-negative rates per preset on your image corpus
npm run serve-test           # manual testing: http://localhost:8787/pages/index.html (load a --dev build)
```

The e2e suite covers:

- no flash on insertion (light DOM, shadow DOM, Lit-style stylesheet overwrite)
- parser-inserted, lazy, `srcset`/`<picture>`, cross-origin, hotlink-protected, `data:` and `blob:` images
- open, closed, nested and declarative shadow roots
- same-origin and `srcdoc` iframes
- `src` swaps in virtualized lists
- video: `blob:`/MSE sources, cross-origin files via the offscreen path, DRM left alone, flagged videos paused, Picture-in-Picture refused
- CSS backgrounds: flagged hidden, gradients and small elements ignored, backgrounds inside shadow roots
- adult-site blocking on and off, plus the hostname heuristic against lookalike domains
- preset changes and disable/enable
- scroll smoothness during a 200-image burst, compared against a baseline run with the extension disabled

Test clips are recorded in the browser with `MediaRecorder` at run time, so the repo contains no binary fixtures.

Branded Chrome 137+ ignores `--load-extension`, so the tests use Playwright's Chromium. Install it with `npx playwright install chromium`, or point `CHROMIUM` at a binary.

The **corpus** holds your own labelled images and is gitignored. See [extension/test/corpus/README.md](extension/test/corpus/README.md). Tuning the thresholds against real images is the main quality work that remains. False positives (beach, medical, art, skin-heavy crops) are the biggest risk.
