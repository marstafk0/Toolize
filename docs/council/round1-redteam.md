# Design Council Round 1: Red Team, Market Analysis & User Advocacy

**Author:** Council Member 1 (Red Team / Market Analyst / User Advocate)  
**Target Repo:** [Toolize](file:///E:/GithubProjects/Toolize) (`v0.9.x` baseline)  
**Principles:** Fail safe, honest about limits, content never leaves the machine.

---

## Executive Summary

Toolize already ships the strongest client-side browser blur engine in its category: pre-paint CSS safe-reveal (`blur(40px)` + grayscale), closed Shadow DOM adoption (`main-world.ts`), a 5-seed CLIP RN50 + NSFWJS ensemble running in an offscreen WebGPU context at ~2.5 ms/image, a 470k-domain daily-refreshed OISD NSFW blocklist (`blocklist.ts`), a lookalike-aware search/word filter (`words.ts`), and a hardware-key-gated Windows `SYSTEM` service (`Toolize.Service`).

Evaluating Toolize against a **technically skilled teenager** and a **struggling adult at 2 a.m.** exposes two core architectural gaps:

1. **The browser extension is currently the sole content and network choke point.** While registry policies (`Enforcement.cs`) and the process watchdog (`WatchdogService.cs`) guard Chrome, Edge, and Brave, any traffic outside those three browsers—renamed portable browsers, Electron apps (Discord, Telegram, Steam), proxy domains (`translate.goog`), or unblocked Chromium policies (`DnsOverHttpsMode`, `URLBlocklist`)—bypasses site blocking, SafeSearch, and image blurring completely.
2. **OS-level defaults currently fail open or allow long grace windows.** In `Settings.cs`, `Enforce` defaults to `false`, `BlockOtherExtensions` defaults to `false`, `Watchdog` defaults to `Warn` (with a 2-minute grace period in `WatchdogService.cs`), and the extension's fail-closed overlay waits **10 minutes** (`GRACE_MS` in `failclosed.ts`) after the service stops. Two minutes in an unmanaged browser—or ten minutes after killing the service—is all a 2 a.m. relapse requires.

To own **"modesty-first, 100% on-device, hard to bypass"** across the whole PC, Toolize should **keep the browser extension** (only DOM hooks can deliver zero-flash pre-paint safe-reveal and per-element blur inside infinite-scroll feeds) while **moving domain/DNS/SafeSearch blocking and blocklist auto-updates down into `Toolize.Service`**, tightening browser policy defaults, and adding an **opt-in, low-FPS Windows Graphics Capture (WGC) + DWM Acrylic / action-reroute safety net** (`Toolize.ScreenGuard`) for native desktop apps.

---

## A. Bypass Catalogue

We model two adversaries:
- **The Determined Teen ("The Tinkerer"):** Has time, Reddit/GitHub access, USB drives, and knowledge of portable apps, proxies, dev flags, VMs, and Windows internals.
- **The Struggling Adult at 2 a.m. ("The Impulse Adversary"):** Set up Toolize voluntarily in a moment of clarity, but faces acute late-night craving. Knows how the machine is configured and will exploit any 30-second grace window or unguarded app if friction is low.

*Difficulty Scale: **1** = Trivial (<1 min) · **2** = Easy (basic settings/downloads) · **3** = Moderate (CLI, registry, portable tools) · **4** = Advanced (BIOS, dual-boot, tunnels) · **5** = Expert (custom code, hardware/disk attacks).*

### A.1 In-Browser Bypasses

| # | Vector / Attack | Diff. | Common? | Stopped Today? (Code Evidence) | Best Countermeasure |
|---|---|:---:|:---:|---|---|
| **B1** | **Alternative & Portable Browsers** (Firefox, Tor Browser, Opera GX, Vivaldi, LibreWolf, Waterfox, Mullvad, DuckDuckGo, Floorp, Zen) | 1 | Very High | **Partial.** `WatchdogService.cs` only checks 8 process names (`firefox`, `opera`, `opera_gx`, `vivaldi`, `librewolf`, `waterfox`, `palemoon`, `tor`), waits **2m** (`Grace`), and defaults to `Watchdog.Warn`. | Default `Watchdog` to `Close` with ≤15s grace; detect browsers via PE version metadata (`OriginalFilename`) and loaded engine DLLs (`mozglue.dll`, `xul.dll`, `chrome_elf.dll`); enforce OS-level DNS/SNI blocking. |
| **B2** | **Renaming an Unmanaged Browser** (copying `firefox.exe` or `tor.exe` to `notepad2.exe`) | 2 | High | **No.** `WatchdogService.cs` uses `Process.GetProcessesByName(n)`. A renamed binary runs indefinitely without warning or termination. | Inspect PE headers (`FileVersionInfo.OriginalFilename`) or loaded modules (`mozglue.dll`, `libcef.dll`) rather than process filename. |
| **B3** | **Disabling Extension / Incognito / Guest / New Profile** | 1 | Very High | **Yes (when `Enforce=true`).** `Enforcement.cs` sets `ExtensionInstallForcelist`, `IncognitoModeAvailability=1`, `BrowserGuestModeEnabled=0`, `BrowserAddPersonEnabled=0`, `TorDisabled=1`. *(Default `Enforce` is `false` in `Settings.cs`).* | Enable `Enforce=true` by default during setup whenever an unlock key is enrolled. |
| **B4** | **Browser VPN, Proxy, or CSS-Override Extensions** (Hola VPN, Stylus, uBlock zapper) | 1 | High | **No by default.** `Settings.cs` defaults `BlockOtherExtensions` to `false`. Only when toggled on does `Enforcement.cs` write `ExtensionSettings\*\installation_mode = blocked`. | Default `BlockOtherExtensions` to `true` under enforcement, with a GUI allowlist for safe extensions (Bitwarden, 1Password, Dark Reader). |
| **B5** | **Launch Flags** (`chrome.exe --disable-extensions`, `--user-data-dir=C:\temp`) | 2 | Medium | **Partial.** Chrome ignores `--disable-extensions` for policy force-installed extensions, and `WatchdogService.cs` checks per-browser heartbeats, but gives **2 full minutes** before closing. | Cut watchdog grace from 120s to **15s** (extension connects in <2s on startup). |
| **B6** | **Extension-Killer Tricks & Internal URLs** (`chrome://hang`, `chrome://kill`, `chrome://serviceworker-internals`, `LTMEAT`) | 3 | Medium (Teens) | **Partial.** Pre-paint `blur.css` still blurs images if the worker hangs, but stopping the worker in `chrome://serviceworker-internals` disables dynamic DNR rules and word filtering until wake. | Add `URLBlocklist` in `Enforcement.cs` blocking `chrome://serviceworker-internals*`, `edge://serviceworker-internals*`, `chrome://hang*`, `chrome://kill*`, and `chrome://flags*`. |
| **B7** | **DevTools DOM Deletion** (Inspect → delete overlay or `data-tz`) | 2 | High | **Yes (when `Enforce=true`).** `Enforcement.cs` sets `DeveloperToolsAvailability=2`, and `Stamper.restore` guards `data-tz`. | Keep `BlockDevTools=true` by default under enforcement. |
| **B8** | **Reader Mode / Distiller** (Chrome Reading Mode side panel) | 2 | Low–Med | **Partial.** Reading Mode runs in a WebUI panel where content scripts do not run, though it mostly strips media. | Disable via policy (`DomDistillerEnabled=0`) or `URLBlocklist`. |
| **B9** | **Translate & Web Archive Proxies** (`*.translate.goog`, `web.archive.org`, `archive.is`, CroxyProxy) | 1 | Very High | **Partial.** Visiting `example-com.translate.goog` bypasses DNR `requestDomains` for `example.com`. In-page image blur and `words.ts` still run in the proxied frame, unless rendered via `<canvas>`. | Add DNR regex rules matching blocked domains inside `*.translate.goog` and `web.archive.org/web/*/`, plus block proxy domains at the DNS/SNI layer. |
| **B10** | **Alternate Search Engines** (Yandex, Baidu, Ecosia, SearXNG) | 1 | High | **Partial.** `search-rules.ts` forces SafeSearch on 7 engines. Yandex (`yandex.com/images`) is not network-rewritten (only query-checked and blurred in-page). | Add Yandex Family Search parameter enforcement (`family=yes`), or offer a toggle to block unfilterable image search engines. |
| **B11** | **Raw CDN URLs, `data:` / `blob:` URLs, `<canvas>` & `<svg>`** | 2 | High | **Mostly Yes.** `images.ts` and `video.ts` classify `blob:`, `data:`, and raw image tabs. **Gap:** `<canvas>`-rendered media (PDF.js, WebGL image viewers) and standalone `<svg>` are not matched by `img, video` in `blur.css`. | Extend watchers to sample large non-game `<canvas>` elements and set `AllowFileAccess` policy for `file://` tabs. |
| **B12** | **Embedded WebView2 / CEF Browsers** (Steam Overlay browser, Epic Launcher, in-game popups) | 1 | High | **No.** Embedded Chromium (`steamwebhelper.exe`, `WebView2`) ignores Web Store extensions and browser policies. | OS-level DNS/SNI blocking stops adult sites inside WebView2; `Toolize.ScreenGuard` covers visual rendering in `steamwebhelper.exe`. |

### A.2 Desktop, Electron & Chat Apps

| # | Vector / Attack | Diff. | Common? | Stopped Today? (Code Evidence) | Best Countermeasure |
|---|---|:---:|:---:|---|---|
| **A1** | **Discord Desktop App** (NSFW servers, DMs, Tenor/Giphy embeds) | 1 | Extreme | **No.** `NEVER_BLOCK` in `sites.ts` exempts `discord.com` / `discordapp.net`, and native `Discord.exe` runs outside the browser. | Block `Discord.exe` desktop app so Discord runs in the managed browser (where DOM blur and word filter work), OR monitor `Discord.exe` with `Toolize.ScreenGuard`. |
| **A2** | **Telegram Desktop / Unigram / WhatsApp** (Public NSFW channels, bots, groups) | 1 | Extreme | **No.** `Telegram.exe` uses its own encrypted MTProto protocol and renders natively. | Monitor `Telegram.exe` via `Toolize.ScreenGuard`, or allow blocking/scheduling `Telegram.exe` in Companion. |
| **A3** | **Reddit / X Desktop Store Wrappers** | 1 | High | **No** (for non-PWA store wrappers). | Block standalone social wrappers so social media routes through the managed browser. |
| **A4** | **Electron App DevTools / Webviews** (`<iframe src="...">` inside VS Code, Slack, Notion, Spotify) | 3 | Medium (Teens) | **No.** Any Electron app can act as an unfiltered browser if navigated to an external link. | OS-level DNS/SNI filter blocks all 470k+ adult domains and forces SafeSearch across **all** processes on the PC. |

### A.3 OS-Level & Network Bypasses

| # | Vector / Attack | Diff. | Common? | Stopped Today? (Code Evidence) | Best Countermeasure |
|---|---|:---:|:---:|---|---|
| **N1** | **DNS-over-HTTPS (DoH) in Browsers or Apps** | 1 | High | **Partial.** DNR catches requests inside managed browsers, but `Enforcement.cs` does **not** set `DnsOverHttpsMode`, which would bypass a Phase 7 local DNS filter. | Set `DnsOverHttpsMode = "off"` in `Enforcement.cs`, block port 853 (DoT), and block known public DoH resolver IPs/SNIs via WFP. |
| **N2** | **VPN Apps, Proxies, WARP, Tor, SSH Tunnels** | 2 | Very High | **Partial.** Extension still acts inside managed browsers over a VPN, but outside the browser VPNs bypass network DNS completely. | Set `ProxyMode = "system"` in `Enforcement.cs`; optionally block known VPN/proxy binaries (`wireguard`, `openvpn`, `warp-svc`, `psiphon`) unless whitelisted with the key. |
| **N3** | **Blocking the Daily Blocklist Refresh** (`nsfw.oisd.nl`) | 2 | Low | **Partial.** `blocklist.ts` keeps ~470k static domains and rejects truncated updates (`MIN_RATIO = 0.8`), but extension fetches can be blocked locally. | Move daily list fetching into `Toolize.Service` (`SYSTEM`) with fallback mirrors and sanity checks. |
| **N4** | **Killing `Toolize.Service` or Removing Fail-Closed Overlay** | 2 (Admin)<br>5 (Std) | High | **Vulnerable.** If an admin stops the service, `failclosed.ts` waits **10m (`GRACE_MS`)**, and its `<div id="toolize-protection-unavailable">` has no `MutationObserver`—a `javascript:document.getElementById('toolize-protection-unavailable').remove()` bookmarklet deletes it! | Cut `GRACE_MS` in `failclosed.ts` from 10m to **90s**; guard the fail-closed overlay with `Stamper`/MutationObserver **and** a high-priority DNR rule blocking `main_frame` when fail-closed. |
| **N5** | **System Clock Tampering** (Setting clock forward then back) | 2 | Medium | **Bug in `failclosed.ts:17`!** `Date.now() - cache.lastSeen > GRACE_MS` never triggers if `lastSeen` was saved while the clock was set to 2030 and then reverted to 2026 (`Date.now() - lastSeen < 0`). | Change check to `Math.abs(Date.now() - cache.lastSeen) > GRACE_MS` so future timestamps immediately fail closed. |
| **N6** | **Local Admin (`sc stop Toolize`, Registry Delete, Uninstall)** | 2 | Very High (Adults) | **No (By Design, `CLAUDE.md`).** An admin can run `sc stop Toolize && sc delete Toolize` in 5s, bypassing `InitializeUninstall()` in `toolize.iss:238`. | Guide user to run as **Standard User**; lock the `Toolize` service DACL (`SetServiceObjectSecurity`) while locked so even Local Admins cannot `SERVICE_STOP` or `DELETE` without the key. |
| **N7** | **Windows Safe Mode (`Shift + Restart`)** | 3 | Medium | **No.** `Toolize.Service` is not registered under `SafeBoot`, so Safe Mode with Networking boots unfiltered. | Register `Toolize` under `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal` and `SafeBoot\Network`. |
| **N8** | **Windows Sandbox, VMs, WSLg (Linux Browser), BlueStacks** | 3 | High (Teens) | **No.** `wsl --install` + Linux Firefox (`wslg.exe` / `msrdc.exe`), `WindowsSandbox.exe`, or BlueStacks (`HD-Player.exe`) evade `WatchdogService`. | Add VM/emulator/WSLg binaries to Companion's restricted/monitored process list and scan their host windows via `Toolize.ScreenGuard`. |
| **N9** | **Cloning Tier A Flash Drive Key** | 3 | Low–Med | **Tamper-Evident Only.** `FlashDriveProvider.cs` rotates `S -> HMAC(S, nonce)`, detecting a clone only when *both* copies are used. | Ship **Tier B (FIDO2 / YubiKey `hmac-secret`)** where hardware-bound keys cannot be extracted or cloned. |

### A.4 Hardware, Second-Device & Non-Site Content Routes

| # | Vector / Attack | Diff. | Common? | Stopped Today? | Best Countermeasure |
|---|---|:---:|:---:|---|---|
| **H1** | **Live Linux USB Boot or Dual-Boot** | 3 | Medium | **No.** Dormant Windows cannot enforce anything. | **Hardening Checklist (`doctor`):** Verify UEFI Secure Boot + BitLocker on `C:`, and guide partner to set a BIOS Supervisor Password with USB boot disabled. |
| **H2** | **Remote Desktop / Game Streaming** (RDP, Parsec, Steam Remote Play, AnyDesk) | 2 | Medium | **No.** Remote pixels stream inside a local client window. | `Toolize.ScreenGuard` inspects `mstsc.exe` / `parsecd.exe` windows on screen; web streams are caught by browser `<video>`/`<canvas>` blur. |
| **H3** | **Local Media Files / USB Video (`vlc.exe`, `Photos`, `.mp4`, `.cbz`)** | 1 | High | **No.** Native media players bypass the browser. | `Toolize.ScreenGuard` monitors `vlc.exe`, `mpv.exe`, `Microsoft.Photos.exe`; enable `AllowFileAccess` for browser `file://` viewing. |
| **H4** | **Local AI Image Generators** (Stable Diffusion WebUI, ComfyUI, Fooocus on `127.0.0.1:7860`) | 3 | High & Growing | **Partial.** In Chrome/Edge, `images.ts` blurs `localhost` images! **Gap:** Standalone desktop wrappers (Pinokio, Stability Matrix) bypass the browser, and `sites.ts:62` (`canLearn`) skips `localhost`. | Keep in-browser blur active on `localhost`; optionally detect local diffusion server ports (`7860`, `8188`) or cover standalone UIs via `Toolize.ScreenGuard`. |
| **H5** | **Games with Adult Mods / Visual Novels (`Ren'Py`, Unity, Steam)** | 2 | High | **Partial.** Browser blocks adult mod/game sites (`f95zone`, `nutaku`), but native `.exe` games run on GPU. | `Toolize.ScreenGuard` samples windowed/borderless games at 1–2 FPS without breaking frame pacing. |
| **H6** | **Phone Hotspot / Changing Wi-Fi** | 1 | Very High | **Yes (in browser).** Endpoint filtering stays active regardless of Wi-Fi network. | Keep all network & visual filtering **on-endpoint** so hotspots never bypass it. |

---

## B. Competitive Landscape

### B.1 Master Comparison Table (18 Competitors)

| Product | Category | Windows Architecture | What is Filtered / Monitored | Accountability Model | Privacy Stance (Screenshots Uploaded?) | Price (USD) | Known Bypasses & Weaknesses | Reviews & Sentiment |
|---|---|---|---|---|---|---|---|---|
| **Toolize (Current)** | Modesty + Focus + Accountability | MV3 Extension (WebGPU CLIP RN50 + NSFWJS) + `SYSTEM` Service + USB Key | In-page images, video, CSS bg; 470k adult domains; search/words; 7 social feeds | Physical USB key (Tier A flash / Tier B FIDO2) held by partner; zero-content logs | **100% On-Device.** Zero screenshots, URLs, accounts, or telemetry. | Free / Open / Self-hosted | Renamed browsers; Electron apps (Discord/Telegram); 2m watchdog / 10m fail-closed grace; clock skew; local admin `sc stop`. | Baseline under review |
| **[Covenant Eyes](https://www.covenanteyes.com/) (Victory)** | Accountability + Porn Blocker | `SYSTEM` Service + WFP Driver + Browser Policies + Screen Capture (`Victory Shield`) | Full-desktop screenshots (~1/min) scored by local AI; domain blocking; SafeSearch | Cloud feed & blurred flagged screenshots sent to "Ally" via **Victory App** | **Uploads blurred screenshots & activity metadata to cloud** (AES-256). | $18/mo or $198/yr (~$950 lifetime); up to 10 users | **Reactive surveillance, not real-time blur**; VPNs break domain block; Linux live USB; Safe Mode removal if Admin. | High brand awareness, but users resent screenshot anxiety, banking/work privacy risk, and post-facto shame. |
| **[Accountable2You](https://www.accountable2you.com/)** | Accountability | Service + Browser Extensions + Window Title Monitor | Browser URLs (incl. Incognito), searches, window titles, app names, trigger words | Real-time email/SMS alerts and full text logs sent to partners | **No screenshots**; uploads **full text logs of URLs, searches, and window titles** to cloud. | $11/mo or $121/yr (6 dev); $16/mo (Family, 20 dev) | **Zero blocking or blurring**; explicit images on X/Reddit with innocent titles pass unblurred; killed by admin. | Liked for no screenshots, criticized because it *prevents* nothing at 2 a.m. |
| **[Ever Accountable](https://everaccountable.com/)** | Accountability + Optional Block | Background Agent + On-Device AI Screen Scanner + Browser Hooks | Web URLs, searches, app text, and AI-flagged screenshots | Weekly summary emails + instant partner alerts | **Uploads flagged screenshots & URL/app logs** to cloud (ISO 27001/27701). | $14.99/mo or $129/yr; unlimited devices | Reactive reporting rather than pre-paint modesty blurring; desktop agent weaker than Android. | Strong mobile reputation; Windows app is secondary. |
| **[Truple](https://truple.io/)** | Screenshot Accountability + DNS | Service + Randomized Screen Capture + OCR Redaction + Optional DNS | Randomized screenshots (30s–5m) + "Smart Capture" on bad URLs | Cloud dashboard for partner; optional E2E encryption | **Uploads blurred/redacted screenshots** & timeline logs to cloud (redacts banking sites). | $16/mo or $160/yr ($13.33/mo) | **Reactive surveillance, not active blur**; 30s–5m interval misses quick views; admin/Safe Mode kill. | Popular on `r/pornfree` for E2E encryption and OCR redaction, but still relies on fear of capture. |
| **[Canopy](https://canopy.us/)** | Real-Time Image Filter + Parental | `SYSTEM` Service + Local VPN/Proxy Driver + **Root TLS Certificate (MITM)** | Strips NSFW/swimwear images & video in transit; blocks adult sites & AI chatbots | Cloud Parent/Ally dashboard ("Protector" vs "Protected") | Local AI + Cloud sync; **installs Root CA to decrypt all HTTPS traffic**; sends URL alerts. | $8.33/mo (1 dev), $9.99/mo (3 dev), $15.99/mo (10 dev) annual | **TLS MITM breaks cert-pinned apps, dev tools, and VPNs**; causes page lag; solo adults can access own Protector login unless handed away. | Closest competitor on real-time image filtering, but technical users hate the MITM root cert and cloud account. |
| **[HaramBlur](https://haramblur.com/) / [SafeGaze](https://safegaze.com/)** | Modesty Blur Extension / Kahf Browser | MV3 Extension (TF.js + NSFWJS + `human` face/gender) + Kahf Browser (Brave fork) | Blurs NSFW, immodest clothing, and male/female faces/bodies in-page | None (Self-managed toggle / basic password) | **100% On-Device.** No cloud uploads. | Free | **Trivial to bypass on PC** (3 clicks to disable extension, switch browser, or use DevTools); no Windows service or hardware key. | Loved for *ghadd al-basar* modesty coverage, but users constantly ask for tamper resistance. |
| **[Plucky (Pluckeye)](https://www.pluckeye.net/)** | Deterministic Self-Control Filter | Kernel/WFP Driver (`pluck + system`) + Extension + CLI Daemon | Blocks or "blots" **all** images/videos (`block image/`, `block video/`) unless whitelisted | Mandatory **Time-Delay State Machine** (e.g., 24h delay to weaken) + optional Helper | **100% Local filtering** (never inspects pixels or takes screenshots). | Free (≤1h delay); ~$5–$15/mo for longer delays | **Blots ALL images/video by default**—breaks the visual web unless whitelisted site-by-site; steep CLI curve. | Revered by programmers for `system` mode (`nodoh`, `nofirefox`, `locksecurity`), too extreme for normal browsing. |
| **[Cold Turkey Blocker](https://getcoldturkey.com/)** | Hardcore Focus & Domain/App Blocker | `SYSTEM` Service (`CTBL`) + `hosts` + Firewall + Mandatory Extensions | Blocks domains, URLs, keywords, `.exe` apps, and full-PC schedules ("Frozen Turkey") | Time locks, random text locks, schedules, or passwords | **100% Local.** No cloud, no telemetry, no screenshots. | Free (basic) / **$39–$45 one-time** Lifetime Pro | **Zero AI image/video blurring**—must block all of Reddit/YouTube/X or leave NSFW inside them unblurred. | Gold standard for pricing ($45 lifetime), local privacy, and anti-tamper UX. |
| **[Qustodio](https://www.qustodio.com/)** | Parental Control | `SYSTEM` Service (`qengine.exe`) + WFP Driver + Root TLS Cert | Category web filtering, app blocking, screen time, YouTube monitoring | Cloud Parent Dashboard + mobile app | **High surveillance:** MITM cert, logs full web history and searches to cloud. | Free (1 dev basic); $54.95/yr (5 dev); $99.95/yr (Unlimited) | No in-page image blurring; VPN conflicts; bypassed by teens via portable apps or BIOS clock. | Good parent UI for young kids; resented by teens. |
| **[Net Nanny](https://www.netnanny.com/)** | Parental Control | Local Daemon + Network Filter Driver + DOM Text Scanner | Dynamic page text/context analysis, profanity masking, category blocking | Cloud Parent Dashboard | Logs flagged categories and searches to parent cloud. | $39.99/yr (1 PC); $54.99/yr (5 dev); $89.99/yr (20 dev) | No modern CLIP per-image modesty blur inside social feeds; struggles with SPAs and Discord. | Aging Windows architecture and frequent false blocks. |
| **[Bark](https://www.bark.us/)** | Exception-Based Parental Alerting | Browser Extensions + Cloud OAuth APIs + Optional DNS (`Bark Home`) | Scans email/social APIs and browser activity for bullying, self-harm, explicit content | Sends **only flagged snippets** to parents | **Requires cloud OAuth access** to read raw emails, DMs, and drives on Bark's servers. | $49/yr (Bark Jr); $99/yr or $14/mo (Premium) | Weak Windows desktop enforcement (extension-only without process lockdown); no real-time blur. | Good alert philosophy, ineffective as a real-time PC modesty filter. |
| **[Microsoft Family Safety](https://www.microsoft.com/en-us/microsoft-365/family-safety)** | OS Parental Control | Native Windows Service (`WpcMon.exe`) + Microsoft Account | Screen time limits, app execution blocks, web filtering (**Edge only**) | Parent Microsoft Account dashboard | Tied to Microsoft cloud telemetry; logs Edge history and app usage. | **Free** on Windows ($99.99/yr M365 for mobile extras) | **Web filtering only works in Edge**; no in-page image blur; bypassed by portable binaries. | Useful free baseline for OS app/time limits on a child's Standard User account. |
| **[CleanBrowsing](https://cleanbrowsing.org/) / [NextDNS](https://nextdns.io/) / [Cloudflare `1.1.1.3`](https://one.one.one.one/family/)** | DNS Filtering | Network Adapter DNS / DoH / Roaming Client (`NextDNS`, `WARP`) | Blocks adult domains, proxies/VPNs, and forces CNAME SafeSearch | Cloud dashboard or stateless IP (`1.1.1.3`) | Stateless (`1.1.1.3` / CleanBrowsing Free) or optional query logs (NextDNS). Zero content inspection. | Free (`1.1.1.3`, CleanBrowsing Free, NextDNS <300k/mo); NextDNS Pro **$19.90/yr**; CleanBrowsing **$75/yr** | **Blind to mixed-content sites** (Reddit, X, YouTube, Discord); bypassed if browser DoH or adapter settings aren't locked. | Essential network layer, cannot replace in-page blur. |
| **[BlockerX](https://blockerx.net/) / [Bulldog Blocker](https://bulldog-blocker.com/) / [Safe Vision](https://safe.vision/)** | Anti-Porn / YouTube Whitelist | BlockerX: Local Proxy; Bulldog: Android-only Accessibility AI; Safe Vision: Sandboxed YouTube app | BlockerX: adult sites + words; Bulldog: Android screen AI; Safe Vision: curated YouTube channels | PIN / Delay / Partner email | BlockerX uses cloud account/telemetry; Bulldog is local AI on Android. | BlockerX: ~$110/yr; Bulldog: ~$9.99/mo; Safe Vision: Freemium | BlockerX Windows config deletion bypasses uninstall lock; Bulldog has **no Windows app**; Safe Vision only filters inside its own window. | BlockerX Windows client has poor reliability reviews. |
| **[Freedom.to](https://freedom.to/) / [LeechBlock NG](https://www.proginosko.com/leechblock/)** | Focus Blockers | Freedom: Local Proxy + Process Killer; LeechBlock: Browser Extension | Scheduled or timed blocking of distracting domains and apps | Timers, random access codes, locked sessions | LeechBlock: 100% local open-source; Freedom: cloud session sync. | LeechBlock: **Free**; Freedom: $39.99/yr or $99.50 lifetime | Zero NSFW/modesty vision; LeechBlock defeated by switching browsers; Freedom killed via Task Manager. | Built for productivity, not modesty or adversarial bypasses. |

### B.2 The Gap Toolize Can Own

Every existing tool forces an ugly trade-off:
- **Covenant Eyes / Truple / Ever Accountable** rely on **surveillance and reactive shame**—uploading screenshots of your desktop (including work, banking, and private chats) to the cloud *after* you've already seen the content.
- **Canopy / Qustodio** filter in real time, but require a **MITM Root TLS Certificate** that decrypts all HTTPS traffic and breaks developer workflows, cert-pinned apps, and VPNs.
- **Plucky / Cold Turkey** are local and tamper-resistant, but have **no computer vision**—forcing you to either block all images on the web or block Reddit, YouTube, and X entirely.
- **HaramBlur / SafeGaze** blur immodesty locally, but have **zero OS enforcement**—defeated in 3 clicks.

> **Toolize's Position: "Modesty-First, 100% On-Device, Hard to Bypass."**  
> Toolize is the only product combining **pre-paint, local WebGPU computer vision** (solving the mixed-content problem on Reddit/YouTube/X without a MITM certificate or cloud uploads) with a **hardware-key-gated Windows `SYSTEM` service** (solving the 3-click bypass problem without uploading screenshots to anyone).

---

## C. Kids vs. Adults: Needs, Modes & Concrete Modesty Definition

### C.1 How the Needs Differ

| Dimension | Adult (Partner-Backed or Solo Self-Regulating) | Kid / Teen (Parent-Managed) | Product Design Requirement |
|---|---|---|---|
| **Consent & Authority** | High setup consent ("protect my eyes/focus"), followed by acute 2 a.m. impulse resistance against their own earlier choice. | Negotiated or low consent; persistent boundary-testing ("Can I outsmart the filter?"). | Support both **Hardware Key Lock** (partner/parent holds key) and **Dual-Lock (Key + Cooldown Timer, e.g., 24h)** so solo adults who keep their own key in a lockbox still cannot impulse-unlock at 2 a.m. |
| **Modesty Level** | Wants immodest clothing (swimwear, lingerie, thirst traps, suggestive ads, anime fan-service) blurred while keeping full access to work tools, GitHub, Reddit tech subs, and news. | **Young Kid (6–11):** Strict SafeSearch, curated YouTube, zero social media.<br>**Teen (12–17):** Explicit + swimwear blur, bot shields, schedules, and Discord/game protection without breaking homework. | Decouple **Visual Sensitivity (`Strict`/`Balanced`/`Relaxed`)** from **Feed/App Toggles** and **Schedules**. |
| **Reporting Without Shame** | Fear of exposing a spouse to explicit URLs or screenshots causes adults to avoid or uninstall surveillance apps. | Parents need to know *if* tampering or repeated blocks occurred without reading private journals or DMs. | **Zero-Content Integrity Log:** Record *that* a system/tamper event occurred (`copy detected`, `unmanaged browser closed`, `unlock refused`) and optional aggregate counts (`blurred: 12`), **never** *what* URL, query, or pixel was viewed. |
| **Relapse Moments (2 a.m.)** | Late-night fatigue + algorithmic feeds (Shorts, Reels, X, Reddit Popular) drive the vast majority of adult relapses. | Late-night bedroom browsing/gaming after parents are asleep. | **Scheduled Step-Up / Night Curfew:** Automatically step sensitivity up to `Strict` + hide all feeds (or lock browsers/Discord) during user-defined night hours (e.g., 11 PM – 6 AM). |
| **Making the Safe Path Easy** | False positives on cooking ("Max the Meat Guy"), medical skin, art, or coding tutorials create friction that rationalizes turning protection off. | False blocks on school biology, history, or literature (*Sussex*, *Essex*) force parents to unlock. | Keep context-aware `words.ts` rules, `TrustedChannels`, and numeric-only `verdicts.ts` diagnostics. |

### C.2 What "Modesty-First" Means Concretely

Unlike standard "porn blockers" that only flag explicit nudity, a **modesty-first** filter addresses the entire visual trigger spectrum while staying honest about model limits:

| Content Tier | Concrete Examples | How Toolize Catches It | Preset Behavior |
|---|---|---|---|
| **1. Explicit (`Porn` / `Hentai`)** | Nudity, sexual acts, rule34/hentai, porn spam bots. | 470k OISD domain blocklist → URL/search word filter → pre-paint CLIP RN50 + NSFWJS (`safety`, `porn`, `hentai` + tile refinement) → 3-hit site learning + comment-bot shield. | Blocked in **all presets** (`Strict`, `Balanced`, `Relaxed`). |
| **2. Immodest Clothing & Swimwear** | Bikinis, lingerie, underwear ads, cleavage close-ups, shirtless gym thirst traps, "try-on hauls". | CLIP RN50 `safety` head (explicitly trained with swimwear/lingerie as positive `block`, 83.3% recall on Commons swimwear at 1.86% safe FP) + `nsfwjs.sexy` + `words.ts` (`bikini`, `lingerie`, `cleavage`, `try-on haul`, `thirst trap`). | Blurred in **`Strict`** (`safety > 0.3`, `sexy > 0.75`) and **`Balanced`** (`safety > 0.5`, `sexy > 0.85`). |
| **3. Suggestive Poses & Display Ads** | Provocative influencer thumbnails, tabloid bait, suggestive product ads. | Holistic CLIP RN50 `safety` embedding + feed hiding (`Shorts`, `Reels`, `Explore`) + CSS background sweep (`backgrounds.ts`). | Blurred in **`Strict`** and **`Balanced`**. |
| **4. Anime Fan-Service (`Ecchi`) & Game Art** | Revealing anime/manga art, gacha character designs, `ecchi` thumbnails. | `nsfwjs.hentai > 0.4` (`Strict`) / `0.5` (`Balanced`) beside `safety` (95.0%–98.9% drawn NSFW recall) + `words.ts` (`ecchi`, `doujin`, `ahegao`, `oppai`, `gravure`). | Blurred in **`Strict`** and **`Balanced`** *(Honest limit: ~4.3%–8.5% FP on stylized SFW anime).* |
| **5. Kissing Scenes & Music Videos** | Movie/TV romance scenes, pop music videos on YouTube or DRM streaming services. | **Honest Limit:** Clothed kissing frames often score low on visual nudity models, and Widevine DRM video (`Netflix`, `Prime`) is encrypted. Mitigated via `YouTubeRestrict` (`Moderate`/`Strict`), feed hiding, and customizable `BlockedWords`. | Caught when attire is immodest or via `YouTubeRestrict` / `BlockedWords`. |

### C.3 Recommended Onboarding Presets

1. **Modesty & Focus (Adult Default):** `Preset: Balanced`, `Mode: Safe`, Shorts/Reels/Explore/Popular feeds hidden, `Enforce: true`, `BlockIncognito: true`, `BlockDevTools: true`, `BlockOtherExtensions: true`, `Watchdog: Close`.
2. **Maximum Guard (Recovery / High-Risk Adult):** `Preset: Strict`, all social feeds + YouTube comments hidden, `YouTubeRestrict: Moderate`, OS DNS/SNI filter + `ScreenGuard` on, Night Curfew schedule, and **USB Key + 24h Cooldown** combined.
3. **Teen Shield (Ages 13–17):** `Preset: Balanced`, `SafeSearch: true`, `YouTubeRestrict: Moderate`, Shorts/Reels hidden, unmanaged browsers/VMs blocked, `ScreenGuard` on for Discord/Telegram/VLC, bedtime schedule.
4. **Young Explorer (Ages 6–12):** `Preset: Strict`, `SafeSearch: true`, `YouTubeRestrict: Strict`, all social feeds/comments hidden, optional YouTube Trusted-Channels-Only mode.

---

## D. Recommended Product Shape & Threat Model

### D.1 Core Architectural Decisions

1. **Keep the Extension + Companion Split, Move Network Authority to the Service:**
   - **Why keep the extension:** Only an in-browser MV3 extension can apply pre-paint CSS blur (`Safe-reveal`), pierce Shadow DOM (`main-world.ts`), hide specific feed containers (`feeds.ts`), and blur individual `<img>`/`<video>` elements without installing a fragile TLS MITM root certificate or blurring surrounding page text.
   - **What moves to `Toolize.Service`:** Daily OISD blocklist downloading, signature/sanity verification, domain/DNS blocking, and SafeSearch CNAME enforcement must run in `Toolize.Service` (`SYSTEM`) so they cover **every** browser and application on the PC, syncing dynamic deltas to the extension over the named pipe.
2. **PC-Wide Native App Protection (`Toolize.ScreenGuard`) — WGC + DirectML Blur/Reroute:**
   - Do **not** attempt 60 FPS pixel-replacement overlays across the entire desktop (causes 1–2 frame drag lag and breaks DWM Independent Flip).
   - Instead, monitor foreground `HWND`s of non-managed-browser apps (`Discord.exe`, `Telegram.exe`, `vlc.exe`, `mpv.exe`, `steamwebhelper.exe`, VMs) at **2 FPS** using `Windows.Graphics.Capture` and score frames on-GPU with `safety.onnx` via `Microsoft.ML.OnnxRuntime.DirectML` (~2 ms/frame).
   - **Action on Hit:** Attach a zero-lag DWM Acrylic blur overlay (`ACCENT_ENABLE_ACRYLICBLURBEHIND`) to the target `HWND` with `SetWindowDisplayAffinity(overlayHwnd, WDA_EXCLUDEFROMCAPTURE)` so WGC keeps sampling the underlying window cleanly and auto-clears the blur once 2 consecutive clean frames are seen (or optionally send `VK_NEXT` / minimize the window to scroll/reroute away).
3. **OS-Level DNS + WFP Network Enforcement:**
   - Intercept port 53 DNS system-wide in `Toolize.Service` to block the ~470k adult domains + learned sites + keyword regexes, synthesize CNAME responses for `forcesafesearch.google.com` / `strict.bing.com` / `safe.duckduckgo.com`, block outbound port 853 (DoT) and known public DoH resolver IPs via Windows Filtering Platform (`FwpmFilterAdd0`), and strip DNS `HTTPS`/`SVCB` (Type 64/65) records so Encrypted Client Hello (ECH) falls back to visible SNI.

### D.2 Priority-Ordered Action Plan (Keep, Change, Add)

| Prio | Type | Target | Concrete Change |
|:---:|:---:|---|---|
| **P0** | **KEEP** | Extension Core | Keep pre-paint `blur.css`, `main-world.ts`, WebGPU CLIP RN50 v3 + NSFWJS, `words.ts`, `feeds.ts`, and content-free `verdicts.ts`. |
| **P1** | **CHANGE** | Fix 5 Immediate Bypass Gaps | 1. **`failclosed.ts`:** Fix clock-skew bug (`Math.abs(Date.now() - cache.lastSeen) > GRACE_MS`), cut `GRACE_MS` from 10m to **90s**, guard overlay with `MutationObserver`, and block `main_frame` via DNR when fail-closed.<br>2. **`Enforcement.cs`:** Add `DnsOverHttpsMode = "off"`, `ProxyMode = "system"`, and `URLBlocklist` (`chrome://serviceworker-internals*`, `chrome://hang*`, `chrome://kill*`, `chrome://flags*`).<br>3. **`Settings.cs`:** Default `Enforce = true`, `BlockOtherExtensions = true`, and `Watchdog = Watchdog.Close` when a key is enrolled.<br>4. **`WatchdogService.cs`:** Cut grace from 120s to **15s**; detect browsers by PE `OriginalFilename` and loaded DLLs (`mozglue.dll`, `libcef.dll`) instead of process name.<br>5. **Safe Mode:** Register `Toolize` under `HKLM\...\SafeBoot\Minimal` and `SafeBoot\Network`. |
| **P2** | **ADD** | Service Blocklist Updater & OS DNS/WFP Filter | Move daily OISD list refresh to `Toolize.Service`; enforce 470k blocklist + SafeSearch CNAMEs + DoH/DoT blocking across all Windows processes. |
| **P3** | **ADD** | Tier B FIDO2 Key + Cooldown Lock | Ship `Fido2UnlockProvider` (YubiKey / FIDO2 `hmac-secret`, uncloneable) and optional **Cooldown Delay (1h–24h)** for solo adults. |
| **P4** | **ADD** | Hardening Wizard (`doctor`) & Service DACL | Add Service DACL protection (`SetServiceObjectSecurity` denying `SERVICE_STOP`/`DELETE` while locked) and interactive GUI Hardening Checklist. |
| **P5** | **ADD** | `Toolize.ScreenGuard` (PC-Wide Native App Blur/Reroute) | Opt-in 2 FPS per-window WGC + DirectML (`safety.onnx`) for Discord, Telegram, media players, and VMs, with `WDA_EXCLUDEFROMCAPTURE` DWM blur overlay or auto-scroll/minimize. |
| **P6** | **ADD** | Schedules & Role Presets | Add Night Curfew schedules and 1-click onboarding presets (*Adult Modesty*, *Maximum Guard*, *Teen Shield*, *Young Explorer*). |

### D.3 Honest Threat Model & Hardening Checklist

| User / Adversary Tier | Windows Account | Lock Configuration | What Toolize Stops | Honest Limits (What It Won't Stop) |
|---|---|---|---|---|
| **Solo Adult (2 a.m. Impulse)** | Local Admin or Standard User | Key in inconvenient place + 24h Cooldown + Service DACL lock | Impulse searches, adult sites, Reddit/X/YouTube immodesty, extension disabling, alternate browsers, quick `sc stop` / Task Manager kills. | Sustained, sober effort (20+ min) by someone holding the Windows Admin password and recovery tools. |
| **Adult with Partner / Spouse** | **Standard User** (Partner holds Admin password) | **Tier B FIDO2 Key** held by Partner | All browser tricks, renamed browsers, DoH/VPNs, service/registry tampering, Safe Mode, key cloning, and native apps (Discord/Telegram/VLC). | Live Linux USB boot or offline disk edits *unless* the BIOS/BitLocker checklist below is completed. |
| **Tech-Savvy Kid / Teen** | **Standard User** (Parent holds Admin password) | Key held by Parent + BIOS/BitLocker Checklist | All browser/extension tricks, web proxies, USB portable browsers, WSLg/Sandbox/VMs, Safe Mode, clock skew, Live USB boot. | Unmonitored second devices (phones, consoles) and DRM-encrypted video streams (Netflix/Prime Widevine). |

**The 6-Step Hardening Checklist (Guided & Verified by `toolize doctor`):**
1. **Standard User Daily Account** *(Verified via `WindowsPrincipal`)* — Daily user is demoted to Standard User; Partner/Parent holds the `ToolizeAdmin` password.
2. **Service DACL Lock** *(Applied automatically by `Toolize.Service`)* — Strips `SERVICE_STOP` and `DELETE` from `Administrators` while locked.
3. **Safe Mode Persistence** *(Verified in `HKLM\...\SafeBoot`)* — Ensures `Toolize.Service` runs in Safe Mode and Safe Mode with Networking.
4. **BitLocker Enabled on `C:`** *(Verified via WMI / `manage-bde`)* — Prevents offline disk modification from WinRE or external media.
5. **UEFI Secure Boot Enabled** *(Verified via `UEFISecureBootEnabled == 1`)* — Blocks unsigned bootloaders.
6. **BIOS/UEFI Supervisor Password & USB Boot Disabled** *(Guided Partner Attestation)* — Prevents booting a Live Linux USB.

---

## Open Questions for the Other Council Members

1. **For the Systems / Windows Architect (Member 2):**
   - For OS-level network filtering (`P2`), should we use **user-mode WFP rules (`FwpmFilterAdd0`) + a local loopback DNS proxy** in `Toolize.Service` (zero third-party kernel drivers needed), or ship **WinDivert** so we can also inspect and reset TLS `ClientHello` SNI packets when apps connect via cached IPs?
   - In `Toolize.ScreenGuard` (`P5`), any edge cases with `Windows.Graphics.Capture` + `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` across multi-DPI monitors when attaching a DWM Acrylic overlay to hardware-accelerated Electron (`Discord.exe`) windows?
2. **For the ML / Extension / Product Lead (Member 3):**
   - Can `Toolize.Service` (running `Microsoft.ML.OnnxRuntime.DirectML`) and the browser extension share a single `safety.onnx` file under `%ProgramData%\Toolize\models\`, or should the extension keep its own copy for standalone Web Store users?
   - What is the cleanest heuristic in the extension to classify large `<canvas>` elements (PDF viewers, image galleries, web VNC) without blurring interactive 60 FPS WebGL games?
   - Should the **Cooldown Delay** (`P3`) be an optional modifier on any key (requiring *both* key insertion and a timer, or a timer when no partner is available)?
