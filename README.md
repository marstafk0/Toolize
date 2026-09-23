# Toolize — PC Edition

An accountability and focus tool for Windows. It is built from three parts:

1. **Chrome/Edge/Brave extension** that blurs explicit or immodest images and video *inside* the pages you visit, one element at a time, and blocks known adult sites before they load.
2. **Windows companion app** — a background service that holds the settings, with a small window and a command-line tool as its front ends. It updates itself from a signed release.
3. **Physical unlock key.** Weakening protection requires a dedicated USB key to be plugged in; removing it re-locks immediately. A FIDO2 tier, where the secret can't be copied at all, comes next.

## Privacy

**Everything runs on your machine.** Image analysis uses a model bundled inside the extension. The extension sends no images, URLs, screenshots or browsing data anywhere. There is no backend, account or telemetry, and it has no network dependency.

The extension downloads each image a second time from inside its own sandbox so it can read the pixels. That request goes to the site that already served the image. Nothing is sent anywhere else.

## Honest limits

Anyone with admin rights on a machine can defeat software running on it. Nothing is enforced yet either: the extension can still be disabled in the browser, which phase 5 addresses. The goal is to turn "3 clicks" into "deliberate technical effort", not to be unbeatable. The physical key only helps if someone else keeps it, such as an accountability partner, or if it lives somewhere deliberately inconvenient. The software can't enforce that.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Blur engine MVP: images, safe-reveal, presets | **done** |
| 2 | Video, CSS backgrounds, adult-site blocklist | **done** |
| 3 | Companion app: service, GUI, CLI, signed self-update | **done** |
| 4 | USB unlock: flash-drive tier, recovery code | **done** |
| 5 | Enforcement: force-install, policy, watchdog | — |
| 6 | Feed toggles (YouTube/X/Reddit/…) + sites catalog | — |
| 7 | Beyond the browser: DNS filtering, screen classifier | — |

FIDO2/YubiKey (the uncopyable unlock tier) slots in behind the same interface as the
flash-drive tier; see *The unlock key* below for what each tier actually guarantees.

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

## The unlock key

Protection can be *strengthened* at any time. Weakening it — turning it off, lowering
the sensitivity, switching off site blocking, removing a key, or installing an update —
requires an enrolled USB key to be plugged in. Pull the key out and the next check
re-locks; presence is re-verified at the moment each change commits, so a key removed a
second earlier authorises nothing.

Set one up in the app: it writes a key file to a stick you choose, then asks you to
unplug and replug it so you can see the lock follow the key. You get a recovery code,
shown once — it clears all keys and works exactly once, and it belongs with your
partner, not with you.

**What the flash-drive tier does and doesn't give you.** The file can be copied and a
drive serial can be spoofed, so this is friction, not proof of possession. What it does
give you is evidence: the secret rotates every minute the key is plugged in, so if a
copy and the original are both ever used, Toolize spots the stale one and records
`COPY DETECTED`. A copy used while the original stays in a drawer is *not* detected
until the original comes back. If that isn't enough, the FIDO2 tier — where the secret
never leaves the device — is the answer, and it plugs into the same interface.

```sh
toolize drives                  # removable drives that could hold a key
toolize enroll-key D: "Partner's key"
toolize keys                    # what's enrolled, and whether a recovery code exists
toolize revoke-key <id>         # needs a key present
toolize recover <code>          # last resort: clears every key, one use only
```

## Testing

```sh
npm run typecheck
npm run test:e2e             # headless end-to-end run in Playwright's Chromium
NO_GPU=1 npm run test:e2e    # same, forcing the GPU-less WASM path
npm run corpus               # false-positive / false-negative rates per preset on your image corpus
dotnet test companion/Toolize.Tests   # lock rules: rotation, clone detection, recovery, weakening
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
