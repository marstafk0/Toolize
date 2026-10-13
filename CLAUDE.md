# Toolize — PC Edition

## What this is

An accountability + focus tool for Windows. Three cooperating components:

1. **Browser extension (MV3, Chrome/Edge/Brave)** — the core product. Client-side NSFW
   detection that blurs immodest/explicit images and video *in the page* (solves the
   "Reddit problem" where site-level blockers pass but content inside allowed sites
   doesn't), plus site-level blocking of known adult domains and distraction-blocking
   feed toggles (Unhook / News Feed Eradicator style).
2. **Windows companion** — a SYSTEM service that owns all state and enforcement, plus a
   GUI and a CLI that are thin clients talking to it over a named pipe. Tamper
   resistance: watches the extension via Native Messaging heartbeat, enforces browser
   policy registry keys, blocks unmanaged browsers. Also handles self-update.
3. **Physical unlock key** — protection can only be weakened while a dedicated USB
   device is plugged in and verified; removing it instantly re-locks and re-arms.
   Two tiers (see *Unlock hardware*). Accountability model: the key is meant to live
   with the accountability partner or somewhere deliberately inconvenient — the
   software can't enforce that, the README says so plainly.

Philosophy: raise tamper friction from "3 clicks" to "deliberate technical effort."
Nothing is unbeatable on a machine the user administers — do not chase kernel-level
anti-tamper. Fail SAFE (blurred/blocked), never fail open. Be honest in docs and UI
about what each tier actually guarantees.

## Architecture decisions (settled — don't relitigate)

### Detection

- **In-page DOM classification, NOT screen capture.** The extension classifies each
  `<img>` / `<video>` / CSS background element individually. Per-element blur, no
  overlay syncing, works with infinite scroll. (Screen-level classification is a
  possible later phase for non-browser apps, and is a separate thing.)
- **Detection model:** NSFWJS MobileNetV2 (224px, softmax over 5 classes), extracted
  from the npm package into real `model.json` + `.bin` at build time and shipped inside
  the extension. Runs in an **offscreen document** (MV3 service workers can't do
  canvas/WebGL). No network calls for inference, ever. v2 upgrade path: ONNX ViT
  (e.g. Falconsai nsfw_image_detection) via onnxruntime-web behind the existing
  `ImageClassifier` interface.
- **Backends:** WebGL when the GPU is real; SIMD WASM when it isn't (a software GL like
  SwiftShader is several times slower than WASM — detect and prefer WASM). Plain-JS CPU
  is the last resort and is unusably slow (~8s/image); surface that in the popup.
- **Safe-reveal (default):** `<img>` and `<video>` are CSS-blurred before first paint
  and only revealed after classifying clean. "Detect, then blur" is an option, not the
  default. CSS backgrounds are the documented exception — see below.
- **Video:** sample playing videos near the viewport ~1/s. Before a video is first
  shown, any flagged or borderline frame in the last 3 keeps it blurred (safe reveal).
  Once it plays in the clear, it takes 2 flagged frames of the last 3, or one obviously
  explicit frame (porn/hentai > threshold + 0.2), to blur it: single odd frames were
  blurring ordinary videos mid-watch. **Only that confirmed rule pauses** — a paused
  video yields no new frames, so pausing on a doubtful frame froze Shorts and feed
  previews blurred for good. **YouTube is never paused** (user's call): flagged video
  there is blurred only. A video clean from its first frame shows at once; after
  anything doubtful it needs 3 consecutive clean frames. Back off to
  one sample every few seconds while a verdict is stable; drop to one video at a time
  when the classifier is saturated, so live frames never starve images and backgrounds.
- **Thresholds:** blur if porn > 0.55 OR hentai > 0.55 OR sexy > 0.75 (balanced).
  Presets strict / balanced / relaxed. For borderline whole-image porn/hentai scores
  (within 0.25 below a threshold), re-score on overlapping full-resolution tiles — a
  224px downscale hides detail. Tiles never decide on "sexy": on a crop, any close-up of
  skin scores it, which blurred ordinary thumbnails and listings. Expect real tuning time here: false positives (beaches, medical, art,
  skin-tone crops) are the #1 quality risk of the whole project.
- **Site blocking:** `declarativeNetRequest` blocks known adult domains before anything
  loads — cheaper and more reliable than classifying their images. Four layers:
  - **OISD NSFW list** (~470k domains, GPL-3.0, chosen over Block List Project for far
    fewer false blocks) merged with our seed list, baked into the static ruleset as one
    `requestDomains` rule (~9MB). Releases refresh it; the extension refetches it daily
    and applies the difference as dynamic rules (new domains blocked, dropped ones
    allowed), refusing a list < 80% of the shipped size or one removing > 5%.
    `NEVER_BLOCK` (sites.ts) can never be blocked by a list, exact match only.
  - **Hostname heuristic:** strong words (porn, xxx, hentai) match anywhere, weak words
    (sex, anal, nude) only as a whole label, so `sussex.ac.uk` is unaffected. Several
    small regex rules (`adultHostRegexes`): Chrome silently drops a regex rule over 2 KB
    compiled, and the original single rule was dropped until 0.8.3. e2e asserts Chrome
    reports no ruleset warnings.
  - **Self-labelled pages:** the RTA label or `<meta name="rating" content="adult">`
    blocks the page and learns the site.
  - **Learned sites:** 3 distinct *explicit* (porn/hentai, not "sexy") images on one
    page block the whole site from then on, except `NO_LEARN` platforms (UGC, search)
    and local addresses. Unblocking from the blocked page is a weakening change
    (`authorize-weakening` verb). The learned list stays in the browser; the service
    only logs that a site was unblocked, never which.
- **DRM video is left alone.** An `encrypted` (EME) event means the frames are
  unreadable by anyone, us included. A site shipping Widevine is a streaming service,
  and real adult sites are blocked at the network layer before this matters.
- **Feed control:** declarative per-site CSS hiding, toggleable from the popup/GUI.
  Each toggle = a named CSS ruleset (`hide` selectors, optional `paths` regex, `notice`
  text, `redirect`) in `extension/sites/*.json`, so new sites are data, not code. The
  companion embeds the same files (`FeedCatalog`) to draw its checkboxes. Settings key
  `feeds["<site>.<toggle>"]`; turning one off is weakening. The protection master
  switch (`enabled`) turns all feed control and the bot shield off too. Done: YouTube
  (home, Shorts + `/shorts/ID` → `/watch?v=ID`, recommendations, comments, end screens)
  and Facebook (news feed = the whole `div[role=main]` on the home path, since its inner
  markup is obfuscated; stories, reels, video tab — unverified against a logged-in
  account). Still to come: X, Reddit, Instagram, LinkedIn, TikTok.
- **Word filter** (`wordFilter`, on by default; `blockedWords` = the user's extras on
  top of `DEFAULT_WORDS` in shared/words.ts): a page whose address or title has a
  blocked word goes to the blocked page (covers searches); on YouTube, tiles whose
  title/channel match are hidden and a matching watch page is blocked. Whole-word,
  case-insensitive, after the same Unicode/lookalike folding as the bot filter; `/re/`
  entries are patterns. Turning it off or removing a word is weakening. Idea from
  DuckySteals/word-guard (no license, so reimplemented, own list). Browser-only; a
  Windows-wide version would need a per-user UI Automation agent (phase 7 territory).
- **Trusted YouTube channels** (`trustedChannels`, shared/channels.ts): videos, Shorts
  and list thumbnails from these channels skip the image check. For channels the model
  reliably misjudges — measured: butchery/cooking Shorts score porn 0.94–0.95 on raw
  meat, on up to 11 frames in a row, so no threshold separates them. The channel comes
  from the player's own `getVideoData().author` (mirrored to `data-tz-author` on every
  `.html5-video-player`'s video) and, for thumbnails, the tile's `/@handle` link or name.
  Names compare as lowercase letters+digits ("Max the Meat Guy" = "@MaxTheMeatGuy").
  With any trusted channel set, a YouTube video's first sample waits (≤1.5 s) for the
  channel, or a trusted Short is paused on frame one. Adding a channel is weakening.
- **YouTube comments** show by default; hiding them is the `youtube.comments` toggle.
  (A "how-to videos only" mode keyed on category + title was built in 0.7.0 and dropped
  at the user's request in 0.7.1; old settings carrying `youtubeComments` still load.)
- **Comment-bot shield** (on whenever protection is on): porn-spam bots in big channels'
  comments lure with a sexual avatar and "look at my profile", and churn faster than
  any blocklist. So commenter avatars are hidden (they're under the 48px classify
  threshold anyway), profile/channel/external links in comments are made unclickable
  (timestamps stay), and comments whose handle or text match a sexual-word /
  solicitation heuristic are hidden — after folding fancy Unicode fonts, Cyrillic
  lookalikes and leetspeak (`looksLikeBot` in shared/feeds.ts).

### Companion: one service, two clients

- **Service (SYSTEM)** owns everything that matters: lock state, settings of record,
  enrolled keys, policy enforcement, watchdog, update installation. State lives under
  `%ProgramData%` with an ACL standard users can't write, encrypted with machine-scope
  DPAPI.
- **GUI (WPF) and CLI are thin clients over a named pipe.** Neither holds authority;
  killing either changes nothing. The GUI is the primary interface — setup wizard, USB
  enrollment, status, settings, update button. The CLI exposes the same verbs for
  scripting and diagnostics (`status`, `doctor`, `enroll-key`, `unlock`, `sites`,
  `set`, `logs`, `update`).
- **Pipe protocol:** newline-delimited JSON, one request/response per line. The pipe
  ACL allows any interactive user to connect: *read* verbs are unrestricted, *weakening*
  verbs are refused by the service unless a verified key is currently present.
  Authority is in the service, never in the client — the GUI must never be the thing
  deciding whether an action is allowed.
- **Extension ↔ service:** Native Messaging host bridges to the same pipe. The service
  is the single source of truth for settings; `chrome.storage` is a cache. The popup
  sends *requests*, the service validates them against lock state and writes back.
  Heartbeat every 30s. If the extension is policy-installed but gets no heartbeat, it
  blocks browsing rather than trusting its own cached settings.
- **Strengthening never needs the key. Weakening always does.** That rule applies to
  every setting, in every client: thresholds, mode, feed toggles, site list removals,
  pausing, uninstall.

### Lockdown

- **Enforcement:** the service writes browser policy registry keys —
  `ExtensionInstallForcelist` (force-install; Remove is greyed out), `ExtensionSettings`
  (block all other extensions except ours), `DeveloperToolsAvailability=2`,
  `IncognitoModeAvailability=1` / `InPrivateModeAvailability=1` / `TorDisabled=1`,
  `BrowserGuestModeEnabled=0`, `BrowserAddPersonEnabled=0`. Roots:
  `HKLM\SOFTWARE\Policies\{Google\Chrome, Microsoft\Edge, BraveSoftware\Brave}`.
  This is the primary lockdown mechanism; the watchdog is secondary.
- **Incognito:** there is no policy to force "Allow in Incognito" for one extension, so
  private browsing is disabled outright. The extension also checks
  `chrome.extension.isAllowedIncognitoAccess()` and reports the gap to the service.
- **Watchdog:** if a managed browser is running and the heartbeat is absent, show a
  full-screen "protection disabled" block and close browser processes after a grace
  period. Service auto-restarts, starts at boot.
- **Unmanaged browsers:** Chrome/Edge/Brave read HKLM policy wherever they're installed,
  including per-user installs, so they stay managed. Firefox (`policies.json`) and
  portable browsers do not — the watchdog kills those, and `doctor` reports them.
  App Control (WDAC) allowlisting is the real fix and belongs in the hardening phase.
- **The account model is the linchpin, and it's deferred by choice.** Everything above
  assumes the daily account is a standard user and the partner holds the admin
  password. A local admin can undo any of it. Revisit when the user is ready; until
  then the product is friction plus tamper-evidence, and the docs must say so.

### Unlock hardware

Be precise about this, because "uncopyable USB" is a real distinction:

- **Tier A — dedicated flash drive (copy-evident, NOT uncopyable).** A 256-bit keyfile
  in a hidden directory, bound to the drive's volume + hardware serial; the service
  stores only a hash. The secret **rotates on every successful unlock** (S→HMAC(S,
  nonce)), so if a clone and the original are both ever used, the service sees a stale
  secret, locks, and records a tamper alert. Honest limits, state them in the UI: the
  files are copyable, the serials are spoofable with effort, and a clone is only
  detected once the *other* copy is used. This is friction plus evidence, not security.
- **Tier B — FIDO2 security key (genuinely uncopyable).** Challenge-response where the
  secret never leaves the device:
  - *YubiKey 5* (~$58): OTP slot 2 HMAC-SHA1 challenge-response, configurable without
    touch — the only option that supports silent periodic re-verification.
  - *Any FIDO2 key with hmac-secret* (~$20–30, including the cheap Security Key series):
    a credential is created at enrollment; each unlock is a fresh assertion. Requires a
    physical touch per challenge, so use it for insert-time and per-weakening
    verification, not for a 60s heartbeat.
  Both sit behind one `IUnlockProvider`. Tier A first (proves the state machine with
  hardware already owned), Tier B second.
- **Presence vs proof:** run a full cryptographic challenge on insertion and before
  every weakening action. Between those, cheap device enumeration is enough to detect
  removal. Never cache a successful challenge across re-insertions, and debounce noisy
  USB arrival events.
- **Unlock state = key presence.** No timers, no unlock windows. Removal re-locks
  instantly, ends any pause, and reverts half-applied weakening.
- **Enrollment wizard (GUI):** list removable drives / detected keys → pick one →
  name it → write or program the secret → force an unplug/replug verification round
  trip → arm. Support two keys (primary + partner backup). Losing the only key with no
  recovery path is the failure mode to design for; offer a one-time recovery code at
  setup, printed sealed-envelope style for the partner. Enrolling another key is a
  weakening change.

### Distribution and updates

- **Install once, update in place.** Both machines (desktop + laptop) get an installer
  once. After that, new versions arrive through the app's **Update** button: the
  service fetches a signed `update.json` from the release host, verifies an Ed25519
  signature against a public key baked into the binary, downloads the installer,
  verifies SHA-256, and applies it silently. A bad signature aborts, loudly.
- **Extension updates ride along.** A force-installed extension updates from the
  `update_url` in the forcelist entry (self-hosted `update.xml` + signed `.crx`,
  stable ID derived from the packing key). Chrome only polls every few hours, so after
  a companion update the service tells the extension over Native Messaging to call
  `chrome.runtime.requestUpdateCheck()`.
- **Extension delivery: Chrome Web Store, unlisted** (decided). Chrome refuses off-store
  policy installs on unmanaged machines, so the store is what makes both installation
  and the phase 5 forcelist possible without enrolling the device. `tools/webstore.mjs`
  builds the upload zip and strips the `key` field; the store id then goes in
  `version.json` so the native messaging host allows both ids. **Live** (unlisted) as
  `mckophjbolaofjkhebkcelhnmjofeajf` — that id is what the installer and enforcement
  force-install, so it must never change.
- **Release host: GitHub Releases** (decided). `tools/release.mjs` creates a tagged
  release and uploads `update.json`, `update.xml`, the `.crx` and the installer. The
  repo must be public, or the assets need a token — and a token baked into an installed
  app is a secret sitting on every machine, so public it is. Nothing sensitive ships in
  a release artifact.
- **Channels:** `stable` and `dev`, distinguished by tag prefix, each with its own
  `update.json`. The laptop sits on `dev`.
- **Network stance:** two kinds of outbound traffic, both carrying nothing about the
  user: the app's update check (version and channel) and the extension's daily
  download of the public adult-domain list. See *Privacy*.
- **Signing keys never live in the repo.** The CRX packing key and the Ed25519 release
  key live outside the working tree; the repo holds only public keys. Losing the CRX
  key changes the extension ID, which breaks the forcelist entry on installed machines.

### Privacy (near-non-negotiable)

- **Content never leaves the machine.** Image/video analysis, unlock verification, and
  settings are 100% local. No URLs, no screenshots, no browsing data, no telemetry.
  Logs record *that* something was blocked, never what was viewed.
- **The exceptions are the update check and the blocklist refresh.** The update check
  sends a version and a channel name to the release host and nothing else. The
  extension downloads the public OISD NSFW list once a day (a plain GET, no
  parameters; decided by the user to keep blocking current). Nothing else touches the
  network, and the README states this plainly.
- A status-only "still armed" heartbeat to an accountability partner is a possible
  future opt-in. It would carry no content. Not built, not assumed.

## Tech stack

- **Extension:** TypeScript, MV3, plain esbuild (no framework). NSFWJS + TF.js
  (tfjs-core/layers + webgl/wasm/cpu backends) in the offscreen document. Vanilla popup.
- **Companion:** C# / .NET 8, published **self-contained single-file** so neither
  machine needs a runtime installed. WPF for the GUI, a console project for the CLI, a
  Windows Service worker for the daemon, a shared library for the pipe protocol and
  state. Chosen over Electron (heavy, easy to kill) and Python (packaging pain).
- **USB/unlock:** `Yubico.YubiKey` NuGet for both YubiKey tiers; `System.IO` + device
  change notifications (`WM_DEVICECHANGE` / CM_Register_Notification) for the flash
  drive tier. FIDO HID access on Windows needs elevation — all key operations happen in
  the SYSTEM service, never in the GUI.
- **Installer:** Inno Setup, **unsigned for now** (decided) — click through
  "More info → Run anyway" once per machine, and revisit if this ever ships to anyone
  else. Registers the Native Messaging host manifest
  (`HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\...`), installs and starts the
  service, and (from phase 5 on) writes policy keys and force-installs the extension.
  A code-signing certificate would remove the warning and make the service binary look
  legitimate to security tools; not worth it for two personal machines yet.
- **Release tooling:** node scripts in `tools/` — version stamping, CRX packing,
  `update.xml` + `update.json` generation, Ed25519 signing, artifact upload.

## Repo layout

```
Toolize/                      # repo root (the product is "Toolize")
  extension/                  # MV3 extension (TS)
    src/content/              # discovery + images/video/backgrounds watchers
    src/offscreen/            # classifier, decode/tiling pipeline
    src/background/           # service worker: routing, badge, DNR rulesets
    src/popup/  src/corpus/   # popup UI; corpus regression page (dev build only)
    src/shared/               # policy/thresholds, settings, messages, site lists
    sites/                    # per-site feed-hiding rulesets (JSON) — phase 6
    test/                     # e2e (Playwright), test pages, corpus (gitignored)
  companion/
    Toolize.Service/          # Windows service: state, enforcement, unlock, updater
    Toolize.Gui/              # WPF client
    Toolize.Cli/              # console client
    Toolize.Core/             # pipe protocol, DTOs, state, crypto
    Toolize.NativeHost/       # Native Messaging bridge (stdio ⇄ pipe)
  installer/                  # Inno Setup script, policy templates
  tools/                      # release scripts (version stamp, CRX, signing, upload)
```

## Build order (phases — each independently useful)

1. **Blur engine MVP** — images, safe-reveal, presets, offscreen classifier. ✅ done
2. **Video + CSS backgrounds + adult-site blocklist.** ✅ done
3. ✅ **Companion v1 (installable, updatable).** Service + GUI + CLI over the named pipe,
   Native Messaging heartbeat, settings sync with the extension, Inno Setup installer,
   and self-update from GitHub Releases with a signed manifest. **Deliberately no
   enforcement in this phase**: no policy keys, no forcelist, no watchdog, no incognito
   lockout. The extension installs the ordinary way. The point is that both machines
   install once and update by button from then on, and that a broken build can't lock
   anyone out of their own browser.
4. **USB unlock.** ✅ Tier A done: enrollment wizard, rotating secret, copy evidence,
   lock/unlock state machine, recovery code, multiple keys. Tier B (FIDO2/YubiKey)
   still to come behind the same `IUnlockProvider`.
5. ✅ **Enforcement.** Policy keys, force-install, incognito off, watchdog, unmanaged
   browser handling, uninstall requires unlock, fail-safe states.
6. **Feed toggles** + sites catalog + lock-aware popup/GUI. ✅ YouTube + Facebook,
   YouTube comment modes, comment-bot shield. X/Reddit/Instagram/LinkedIn/TikTok next.
7. **Beyond the browser** (optional, decide later): local DNS filtering with DoH
   blocked, and screen-level classification for native apps via Windows Graphics
   Capture + ONNX Runtime.

## Dev flow

- **Extension:** `npm run watch` in `extension/`, loaded unpacked from `extension/dist`
  on the dev machine. `npm run test:e2e` (add `NO_GPU=1` for the WASM path),
  `npm run corpus` for threshold regressions, `npm run serve-test` for manual pages.
- **Companion:** `dotnet run --project companion/Toolize.Service -- --console` runs the
  daemon in the foreground with a dev pipe name and a dev state directory, so it never
  fights the installed service. GUI and CLI take `--pipe dev` to match.
- **Installed machines never get a dev build.** They pull from the release host, so the
  loop is: commit → `node tools/release.mjs --channel dev` → click Update in the app.
- **Versioning:** one `version.json` at the repo root is stamped into the extension
  manifest and the .NET assemblies by the build scripts. Never hand-edit either.

## Known gotchas

### Extension

- MV3 service worker lifetime: keep the classifier in the offscreen document, persist
  state to `chrome.storage`, reconnect the Native Messaging port on wake.
- **The offscreen document is a hidden page, so `setTimeout` is throttled to ~1s.** Use
  `MessageChannel` for scheduling, and `dataSync()` rather than the async readback
  (which polls a GPU fence with a timer). This was a 60× latency bug.
- **The GPU is shared with the whole browser.** One long inference call stalls drawing
  in every window (Brave and Edge froze on image-heavy sites with batches of 16), so
  batches cap at 8 and jobs in flight at 8. Measure with `npm run bench` before raising.
- **After an extension update the old content script keeps running** in every open tab,
  in a world the new one can't see, and Chrome never stops it. Two copies guarding the
  same `data-tz` (Stamper.restore puts back its own value) loop forever and freeze the
  tab until a browser restart. So: each new copy dispatches `toolize:takeover` on the
  document (DOM events cross worlds) and older copies stand down; a copy whose
  `chrome.runtime.id` is gone stands down by itself; and restore() yields after a few
  quick restores per element. `npm run test:update` reproduces an update with busy tabs
  (`OLD_DIST=<path>` to start from an older build); it needs developer mode on and
  Playwright's default `--disable-extensions` removed, or the reload disables the
  extension.
- **After an extension update, don't re-check every tab at once.** `onInstalled` also
  fires for browser updates (reason `chrome_update`) — ignore those. On install/update
  every tab gets the blur sheet (cheap, fail safe) but the engine only goes into active
  tabs; the rest are revived on `tabs.onActivated`.
- **TF.js compiles WebGL programs per input shape**; an uncached shape costs seconds.
  Pad batches to fixed buckets and warm each bucket at load, in idle time.
- Threaded WASM needs a cross-origin-isolated document. We don't ship the threaded
  binary, so set `WASM_HAS_MULTITHREAD_SUPPORT=false` or the loader fetches a file that
  isn't there. `enableProdMode()` also silences backend-init warnings — call it after
  backend selection, not before.
- Uncached ("one-shot") classify jobs must never share an in-flight key, or one video's
  verdict lands on another.
- Shadow DOM: manifest CSS doesn't pierce it. A MAIN-world hook adopts the blur sheet
  into every root and re-appends it when frameworks (Lit) overwrite
  `adoptedStyleSheets`. The host marker attribute must be set a **task** later —
  parser-created custom elements throw if they gain attributes during construction.
  Closed roots are reachable from the isolated world via
  `chrome.dom.openOrClosedShadowRoot`.
- `currentSrc` keeps reporting the OLD url until the new image loads, so on a
  `src`/`srcset` change hide the element and wait for the load event. Virtualized lists
  recycle `<img>` nodes constantly.
- A hidden CSS background reports `background-image: none` afterwards (our own rule), so
  never re-derive its state from computed style — that's a hide/reveal flicker loop.
- Cross-origin images taint the page canvas; the offscreen doc refetches them with host
  permissions instead (this doubles bandwidth per image — a known cost). Hotlink-
  protected cross-origin images stay blurred.
- Don't classify images under 48px (icons), but DO classify avatars ≥ 48px.
- Picture-in-Picture and remote playback render outside the page where CSS filters don't
  apply; both are refused in the MAIN-world hook.
- Grayscale + `blur(40px)` together — blur alone at low radii leaves silhouettes.
- Branded Chrome 137+ ignores `--load-extension`, so e2e uses Playwright's Chromium.

### Companion

- Chrome policy keys don't apply if the machine is domain-managed with conflicting
  policy; detect and warn in `doctor`.
- USB arrival events are noisy and duplicated; debounce and re-verify rather than
  trusting a cached "key present" flag.
- YubiKey OTP HMAC: program slot 2, leave slot 1 for its default OTP use. FIDO2-only
  keys have no OTP slot — check capability at enrollment and fall back to hmac-secret.
- The service must survive the GUI and CLI dying mid-operation; every weakening
  operation is transactional and re-verifies key presence at commit time.
- Self-update must not leave the machine unprotected: apply on service restart, keep
  the previous installer for rollback, and never disable enforcement during an update.

## Testing

- **Corpus regression:** labelled images in `extension/test/corpus/{safe,flag}/<category>/`
  (gitignored). `npm run corpus` reports false-positive/false-negative rates per preset
  and saves per-image scores. Run it on every model or threshold change and track the
  rates over time. Safe categories that matter: beaches, medical, art, LEGO minifigs,
  skin-tone-heavy but modest.
- **e2e:** `npm run test:e2e` covers no-flash, shadow DOM, iframes, src swaps, lazy
  loading, video (blob/MSE, cross-origin file, DRM, pause-on-flag, PiP refused), CSS
  backgrounds, site blocking, preset changes, and scroll smoothness against a baseline
  run with the extension disabled. Always run `NO_GPU=1` too: the slow path has caught
  real bugs the GPU path hid.
- **Manual:** Reddit infinite scroll, X media tab, Google Images, YouTube thumbnails and
  playback.
- **Tamper checklist:** disable extension, uninstall extension, kill GUI, kill CLI, stop
  service, install Firefox, portable browser on a USB stick, incognito, delete or edit
  companion state without the key (must fail safe → locked), unplug the key with the
  settings window open (must re-lock instantly and revert half-applied weakening), copy
  the Tier A keyfile and use both copies (must be detected and reported).
