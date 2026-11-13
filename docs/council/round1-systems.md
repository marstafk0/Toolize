# Round 1 — Systems engineering proposal

**Recommendation:** retain the extension, give the Windows service network enforcement, and add an optional native-app screen guard. An app cannot reproduce DOM safe-reveal, and capture overlays cannot guarantee zero exposure. DNS plus Windows Filtering Platform (WFP) improves coverage without decrypting traffic, but cannot distinguish every private tunnel from legitimate HTTPS. Offer adult accountability and stricter standard-user configurations, with explicit coverage indicators. Prioritize independent network blocking and trustworthy updates, then a measured screen guard. Avoid display drivers and injection unless experiments establish a compelling benefit.

Research date: 2026-11-12, America/Chicago. Read the requested product docs, offscreen pipeline, service, enforcement, and both update implementations. API facts cite primary documentation. Performance budgets are estimates, not Toolize hardware measurements.

## A. Screen-wide filtering on Windows 11

### Available mechanisms

| Approach | Mechanism and privileges | Frame latency and resource implications | Assessment |
|---|---|---|---|
| **Windows.Graphics.Capture (WGC) + overlay** | `IGraphicsCaptureItemInterop::CreateForMonitor/CreateForWindow`, `Direct3D11CaptureFramePool::CreateFreeThreaded`, `GraphicsCaptureSession`. D3D11 textures feed preprocessing/inference; a topmost, no-activate, click-through HWND displays blurred copies of regions through DirectComposition/D3D. No custom driver or admin needed for ordinary capture; picker/consent and capture-border behavior depend on activation path and capabilities. [WGC] [INTEROP] | Asynchronous capture, inference, then another composition/present. Budget **50–100 ms** for a warm, accelerated implementation; no Windows latency SLA. GPU copies, shaders, and inference dominate; CPU should handle scheduling and small scores. | Best first prototype. A topmost window cannot apply CSS-like blur to another process: render a blurred captured texture or an opaque cover. WPF can host controls, but avoid CPU `UpdateLayeredWindow` bitmap uploads every frame. |
| **Desktop Duplication (DDA)** | `IDXGIOutput1::DuplicateOutput`, `IDXGIOutput5::DuplicateOutput1`, `AcquireNextFrame`, dirty/move rectangles. One duplication per output/adapter; same overlay renderer. Ordinary desktop access needs no driver/admin. [DDA] [DUP] | Same detection latency budget as WGC; dirty rectangles can reduce work. GPU-resident processing remains essential. Four concurrent duplication applications are the default limit. Recreate after desktop/mode changes. | Useful fallback and fullscreen experiment; not an earlier point in the display pipeline. |
| **Magnification API** | `MagInitialize`, `MagSetFullscreenTransform`, `MagSetFullscreenColorEffect`; windowed `WC_MAGNIFIER`, `MagSetWindowSource`, `MagSetColorEffect`, exclusion lists. Native x64 build; WOW64 unsupported. Input transformation requires UIAccess, with signing/trusted-install requirements. [MAG] | Color/scale operations add compositor work without ML or CPU readback; roughly one display refresh to observe an update, not a guaranteed timing. Cost scales with pixels. | Supported transforms provide zoom and a **5×5 color matrix, not spatial blur**. Grayscale/dimming is a low-cost comfort option, not concealment. `MagSetImageScalingCallback` is deprecated since Windows 7, has no replacement, and is unsuitable as a modern filtering hook. [MAGCALL] |
| **DWM / Indirect Display Driver (IDD)** | No supported third-party global DWM postprocess plugin. An IddCx **UMDF** driver creates a virtual display and consumes its swapchain using `IddCxSwapChainReleaseAndAcquireBuffer` or newer variants. Admin installs the driver package. [IDD] | A virtual-display-to-physical-viewer arrangement adds copies and usually one or more refreshes, **16.7–33.3+ ms at 60 Hz before ML**; a planning estimate. Rendering/inference cost remains. | Feasible for an appliance/research mode, not a transparent filter on existing HDMI/DisplayPort outputs. A physical fullscreen viewer must show the processed virtual desktop; disabling that route exposes the original. Input, cursor, recovery, display switching and gaming become product responsibilities. |
| **Generic display “filter driver”** | A PnP class/device filter does not receive every final GPU scanout surface. Building/replacing a WDDM display path or relying on private DWM hooks is a different, hardware-sensitive project. | No credible latency/cost number exists without an actual supported design. Kernel faults can crash Windows. | Reject as the default. A network filter driver cannot filter locally decoded pixels. |
| **Per-app DLL injection/hooks** | Intercept DXGI `Present`, Chromium/Electron rendering, or app-specific media paths. Cross-integrity injection needs privileges; code integrity, protected processes and anti-cheat can prevent it. | At least shader/copy/inference work per hooked stream; blocking `Present` can delay frames until classified, but breaks frame pacing. Resolution costs below still apply. | Brittle across versions, architectures, sandboxes and child processes; risks AV alerts, game bans and credential exposure. A giant privileged injection surface is a poor privacy/security trade. |

**IDD signing:** EV, attestation and WHQL are not interchangeable. Microsoft's dashboard requires an associated, valid EV certificate for attestation/WHCP submissions; submissions may use a registered Authenticode certificate. Attestation is not WHQL certification and does not provide retail Windows Update publication; WHCP uses HLK testing. IDD is user-mode: distinguish PnP package/catalog signing from kernel binary requirements. Confirm the selected package's release route in a spike. Signing adds certificate custody and release maintenance, not anti-tamper. [SIGN] [ATTEST] [DRIVERSIGN]

### Coverage boundaries

| Case | WGC / DDA + overlay | Magnification | IDD / hooks |
|---|---|---|---|
| DRM/protected surfaces | May be black, omitted or unavailable; DDA reports `ProtectedContentMaskedOut`. Black capture is **not evidence that the viewer sees black**. | No right to read protected pixels or perform ML. | IDD protected-content support is not permission to read/decrypt DRM. Hooks cannot promise access. |
| Exclusive fullscreen games | DDA supports fullscreen capture, including original buffer formats with `DuplicateOutput1`; a normal topmost overlay may still fail to appear above exclusive presentation. WGC/game compatibility requires testing. | No universal game guarantee. | Virtual-display routing changes compatibility/VRR/latency; hooks conflict with anti-cheat. |
| UAC secure desktop / lock screen | Ordinary per-user capture and overlays cannot cover it. DDA docs allow secure-desktop access only to LOCAL_SYSTEM; that is not a reason to put a capture UI there. Preserve Windows' security boundary. | Do not promise coverage or disable secure desktop. | No accepted requirement to intercept credentials. |
| Multiple monitors / HDR | Per-output capture and overlays; handle rotation, negative coordinates, DPI, hotplug and cross-GPU copies. WGC HDR needs FP16 throughout plus explicit tone mapping for the model. DDA `DuplicateOutput1` avoids forced BGRA conversion for supported formats. [WGC] [DUP1] | Virtual-screen transforms exist; mixed HDR/accessibility interactions need validation. | IddCx 1.10+ includes HDR/WCG DDIs, not automatic HDR correctness. [IDDHDR] |
| Capture exclusion | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` can hide an app's own top-level window from supported capture. Toolize cannot simply remove another process's affinity. | Not a reliable workaround for excluded content. | Routing through IDD does not establish an entitlement to protected/excluded pixels. |

**Feedback:** mark Toolize's own overlay `WDA_EXCLUDEFROMCAPTURE` and verify exclusion on each capture backend/build; per-window WGC naturally avoids unrelated overlay HWNDs. Never briefly hide the overlay to sample underneath: that creates exposure. If exclusion fails, keep an opaque shield while changing capture strategy. Exclusion is not DRM or a security boundary. It also means recordings/screenshares may omit Toolize's cover and expose underlying pixels; distinguish local-display protection from recording protection. A hostile ordinary app can use the same flag. [AFFINITY]

### Performance and stable reaction

Analytical lower bounds for one monitor, BGRA8, 60 Hz; these are **memory traffic, not measured GPU utilization**:

| Resolution | One frame | One full-frame read + write at 60 Hz | Three retained frames |
|---|---:|---:|---:|
| 1920×1080 | 8.29 MB | 1.00 GB/s | 24.9 MB |
| 2560×1440 | 14.75 MB | 1.77 GB/s | 44.2 MB |
| 3840×2160 | 33.18 MB | 3.98 GB/s | 99.5 MB |

WGC/DDA copies add comparable traffic; separable blur needs multiple passes, reduced by regional masks. Magnification avoids inference but processes the output. IDD/viewer adds an output/copy path; hooks consume each app's frame budget. FP16 HDR doubles these counts; two identical monitors double them again. Avoid full-frame CPU readback. CPU percentages require hardware/load measurements.

The repo documents ~20 ms per **batch of eight** 224px safety inputs on its GPU, versus ~470 ms for one WASM input. The former is throughput, not 2.5 ms end-to-end response. Native ONNX Runtime/DirectML must be benchmarked independently. A fixed 224px input costs roughly the same across resolutions but misses small content at 4K; tiling increases inference with tile count. CLIP-RN50 supplies a score, **not bounding boxes**. Start with whole-window covers; regional blur requires a localizer or carefully validated tiling.

Proposed accelerated budget: sampling wait ≤33 ms at 30 Hz, capture/preprocess 2–10 ms, inference 10–30 ms, next 60 Hz present ≤17 ms: **62–90 ms worst-budget sum**, excluding contention. Test p95 <100 ms at 1080p/1440p/4K; downgrade unsupported hardware visibly. Use latest-frame-only queues, GPU timestamps, changed regions, and motion tracking. Strong positives cover immediately; uncertain positives hold a cover while confirming. Require 300–500 ms clean history before uncovering; never animate through translucent unsafe frames. Two-positive confirmation can push latency above 100 ms. Short flashes between samples remain undetectable, and capture always follows original presentation: **zero unsafe frames is not a valid claim**.

| When blur is unavailable | Concrete action | Limit/cost |
|---|---|---|
| Known uncovered/protected app | Opaque window/monitor cover; optionally minimize via `ShowWindowAsync(SW_MINIMIZE)` | Topmost is cooperative, not a secure compositor boundary; competing windows/fullscreen can defeat it. Hardware display power-off is not a security boundary either. |
| Playing media | `GlobalSystemMediaTransportControlsSessionManager.RequestAsync()`, enumerate matching sessions, `TryPauseAsync()` | Only apps integrating SMTC; target the correct session and verify success. `globalMediaControl` capability applies where required. Cover first. [SMTC] |
| Browser/tab | Extension closes/redirects the precise tab; UI Automation `InvokePattern`, `ScrollPattern`, `WindowPattern` as adapters | UIA depends on accessible controls, localization and integrity. Tab close can lose work. |
| Scroll/back/escape | App adapter or carefully targeted `SendInput` | Foreground/focus races, UIPI restrictions and accidental actions; scrolling can reveal worse content. Never substitute blind repeated input for a cover. [INPUT] |

## B. Network blocking independent of the browser

### Enforcement mechanisms

| Layer | Implementation | Strength and remaining gap |
|---|---|---|
| **Local DNS policy resolver** | Service-managed, mature resolver/proxy bound only to `127.0.0.1` and `::1`, TCP/UDP 53; suffix-matching domain trie, cache, CNAME-chain checks and deliberate A/AAAA/HTTPS/SVCB handling. Configure every adapter with `Set-DnsClientServerAddress`; reconcile new Wi-Fi, USB tether and virtual adapters. | Covers normal DNS consumers across apps; literal IPs, private DoH and tunnels bypass DNS. A loopback listener must not become a LAN open resolver. |
| **NRPT / Windows DNS policy** | Where supported, namespace `.` NRPT rule to loopback using `Add-DnsClientNrptRule`; preserve corporate split-DNS rules. Pro can manage DNS-client policy through Group Policy. | NRPT influences the Windows resolver, not arbitrary socket-based DNS implementations. Home requires capability testing; adapter settings plus WFP are the baseline, not an assumed Home GPO feature. [NRPT] [DNSPOLICY] |
| **WFP from SYSTEM** | `FwpmEngineOpen0`, owned provider/sublayer, `FwpmFilterAdd0`, `FWP_ACTION_BLOCK` at `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6`; conditions include app identity, address, protocol and remote port. Use transactions and persistent filters. | **No custom callout driver is required for ordinary IP/port/app blocks.** Windows' existing kernel engine enforces user-mode-installed rules. Payload parsing/redirection is a separate problem. [WFP] [CONDITIONS] |
| **DNS escape / tunnel controls** | Deny external TCP/UDP 53 and TCP/UDP 853 except the resolver's approved upstream; block known DoH/VPN/proxy/Tor endpoints. Optionally deny UDP 443 to force common browsers off QUIC. | DoH over TCP 443, private endpoints, Tor bridges, custom-port WireGuard and HTTPS proxies remain possible. CDN/shared-IP blocking causes collateral damage; UDP denial disrupts calls/games. |
| **Hosts file** | Static exact-name overrides, ACL protected | No wildcard coverage, limited maintenance, no arbitrary-DoH/IP/tunnel control. Emergency seed only, not the enforcement foundation. |

Persistent WFP policy survives Toolize service termination; a dynamic-session-only filter disappears when that session closes. Include tested boot policy if startup gaps matter. Ensure explicit resolver/updater allowances and test filter arbitration with Defender Firewall/VPNs: a blanket block plus an allow is not automatically ordered as intended. Do not turn hundreds of thousands of domains into CDN IP blocks. In strict mode, restrict network-capable applications; a process-name denylist alone is easily renamed around. WFP app-path identity is not cryptographic publisher allowlisting.

Set `DnsOverHttpsMode` **REG_SZ `off`** in the managed Chrome/Edge/Brave roots and verify effective browser policy. `BuiltInDnsClientEnabled=0` can favor the system resolver where supported, but **does not itself disable DoH**. Control Windows' separate encrypted-DNS setting (`netsh dnsclient`/DNS-client policy); Pro exposes “Configure DNS over HTTPS” → Prohibit DoH. Test exact Windows/browser versions and Home support rather than merely checking registry writes. Toolize's current `PolicyPlan` does not set these controls. [CHROMEDOH] [EDGEDOH] [BUILTINDNS] [WINDoH]

**SNI/ECH:** basic ALE filters do not inspect TLS hostnames. A custom parser needs TCP reassembly, QUIC handling and evasions, and cannot see ECH's encrypted inner ClientHello hostname. ECH is standardized in RFC 9849 and deployed by browser/CDN stacks; outer names/IPs identify a shared front, not reliably the site. Stripping HTTPS DNS records or disabling browser ECH is not universal app control. Avoid TLS MITM/root-certificate installation: it exposes content, breaks pinning and expands risk. [ECH] [ECHDEPLOY]

Apply every relevant rule to IPv4 **and IPv6**, including AAAA DNS, DoT/DoQ, alternate interfaces and transition/tunnel paths. Test existing connections and cache invalidation on newly blocked domains. WFP can deny a VPN process's outer transport or a known peer, but cannot infer every arbitrary encrypted tunnel. Guest VM traffic needs separate controls; see D.

### Optional upstreams, after local filtering

| Provider | Useful behavior | Tradeoff |
|---|---|---|
| CleanBrowsing Adult / Family | Adult: `185.228.168.10`, `185.228.169.11`; allows mixed-content sites. Family: `.168.168`, `.169.168`; also blocks mixed-content sites and proxy/VPN domains and applies search restrictions. [CLEAN] | Family can block Reddit outright; neither provides per-post modesty filtering. |
| Cloudflare Families | `1.1.1.3` / `1.0.0.3`, IPv6 `2606:4700:4700::1113/::1003`; malware/adult domain filtering. [CF] | Simple fallback; no Toolize-specific categories or per-user exceptions. |
| NextDNS | Custom blocklists, allow/deny lists, parental categories, optional query-log settings. [NEXT] | Account/configuration identifier and provider dependence; select logging off. |
| OpenDNS FamilyShield | `208.67.222.123` / `208.67.220.123`, preset family filtering. [OPEN] | Coarse remote categorization; confirm current transport/privacy requirements. |

**Privacy qualification:** upstream DNS receives queried names and client IP even with DoH. Logging disabled is not “names never leave.” Default to local decisions and the existing disclosed resolver; family upstreams are optional. Images, search text, screenshots, verdicts and visited-domain logs never go to Toolize infrastructure. Keep no persistent DNS history; answer local blocks without upstream contact.

### Lists and updates

Counts below are retrieved artifacts/README observations during this research, not comparable recall measurements. False-positive judgments are maintainer positioning or Toolize's experience, **not an independent ranking**.

| Source | Size / licence | Cadence and practical choice |
|---|---|---|
| **OISD NSFW** | **487,647** suffix entries, 8.62 MB raw; GPL-3.0. [OISD] [OISDFILE] | FAQ says at least daily; live header advertises hourly expiry. Existing Toolize default, curated for low breakage. Keep it; broad OISD “big” is not the adult list. |
| **HaGeZi NSFW** | README: **77,141** entries; GPL-3.0. [HAGEZI] | GitHub daily, build mirror approximately 4–8 hours. Evaluate adult list and DoH/VPN/Tor bypass lists separately; “Ultimate” ad/tracker blocking is not better modesty detection. |
| **StevenBlack** | Porn-only **76,801**; unified+porn **154,595**; MIT repository, preserve upstream source notices. [STEVEN] | Retrieved README updated November 8; maintenance-driven, no guaranteed daily SLA established. Transparent recipes; base hosts alone is not adult filtering. |
| **1Hosts** | Lite **202,954**, 4.93 MB; Xtra domains asset 22.37 MB; MPL-2.0. [ONE] | Primarily ads/trackers/threats, not an adult-list replacement. Retrieved Lite/latest release dated September 3: do not assume advertised provider refresh means fresh source data. Xtra explicitly warns of greater breakage. |
| **BlockListProject porn** | **953,393**, 18.47 MB; artifact says **MIT**, root `LICENSE` says **Unlicense**. [BLP] [BLPFILE] [BLPLIC] | README describes daily monitoring and weekly cleanup, but retrieved porn artifact dated July 18. Reconcile licence/freshness before redistribution. Toolize documents prior higher false blocks; evaluate incremental value rather than merging blindly. |

Publish **separate, signed data bundles** from a scheduled maintainer build; clients download them through the service, not each extension. Manifest: sequence, creation time, source versions/licences, normalized count, digest, schema, expiry and delta base hash. Use a pinned public key and offline/controlled release signing; the current updater verifies RSA-SHA256, despite conflicting prose elsewhere mentioning Ed25519. A signature authenticates the publisher, not classification quality.

Keep the existing **80% shipped-count floor / 5% removal guard** initially, plus syntax/public-suffix validation, canary domains, protected exceptions and source-specific growth alarms. Signed reviewed releases can intentionally reset the baseline; otherwise a permanent floor would freeze legitimate cleanup. Preserve last-known-good and embedded seeds on timeout, bad signature, expiry or truncation; report staleness, never silently switch to empty. Approved routine list corrections are maintenance under an explicit update contract; manual local allowlisting remains a key-gated weakening action.

Fetch daily with jitter, ETag and bounded downloads. Apply compressed add/remove deltas only against the exact signed base; verify the resulting full digest, atomically swap resolver state, and retain rollback. Ship periodic full snapshots. No accounts, device IDs, submitted domains or per-user delta requests: all clients request the same public artifacts. The host still sees client IP/timing. Keep learned browsing-derived blocks browser-local by default; a cross-app learned-domain feature needs separate privacy consent. Sync public list versions/deltas to DNR through native messaging, retaining the extension's offline baseline and MV3 quota checks.

## C. Can everything be done in the app?

One installation and desktop control surface: **yes**. One service replacing every filtering mechanism: **no**, without losing substantial quality.

| Owner | Responsibilities |
|---|---|
| **SYSTEM service** | Authoritative settings/unlock, signed list retrieval/storage, local DNS lifecycle, WFP, policy reconciliation, installation/update, per-session helper supervision. Move external list fetching and public-list authority here. Keep image/screenshot handling out of this privileged process. |
| **Browser extension** | Pre-paint DOM safe-reveal, per-element image/video classification, closed/open shadow-root handling, precise search-query extraction, feed hiding, comments, safe tab redirects, SafeSearch request rules, DNR defense in depth. Retain offscreen inference initially. |
| **Per-user/session screen guard** | WGC/DDA, local GPU inference, covers, native-app adapters/SMTC. Covers Discord, Telegram, image viewers and players where capturable; games are qualified support. No pixel disk logs or outbound network. |
| **WPF / CLI / popup** | Thin controls, coverage/status, exceptions and recovery. Closing the GUI does not stop either enforcement plane. |

An extension sees DOM boundaries, upcoming elements and semantic context before presentation. A desktop image cannot reliably distinguish a thumbnail, medical image, search query, feed or permitted channel; OCR is slower and privacy-invasive in memory. Conversely, the extension cannot filter a downloaded file in an image viewer or a native Telegram attachment. Browser CSS-background filtering and periodically sampled video already have documented exceptions; do not extend the “before paint” guarantee to all media.

Services run in session 0; launch a separate helper for **each interactive session**, using supported session/token mechanisms and authenticated, session-scoped IPC. Microsoft explicitly recommends this split. Signing/UIAccess is an accessibility capability, not secure-desktop entitlement. Validate helper process identity and lifecycle; self-reported “healthy” pipe messages are not proof that pixels were inspected. A same-user helper can be killed: service supervision repairs it, but cannot eliminate the gap. [SESSIONS]

## D. Anti-bypass: knowledgeable adult or teenager

The main boundary is **standard user versus administrator**, not age. Home has WFP, services and browser machine policy; Pro improves management, virtualization controls and full BitLocker administration. Current Microsoft documentation says App Control policies work on all editions and AppLocker enforcement is available on all Windows 11 editions; Home lacks some authoring tools. “AppLocker requires Enterprise” is outdated. Audit before enforcing: allowlisting can break development tools and interpreted-code workflows. [APPCONTROL] [APPLOCKER]

| Bypass | SYSTEM counter on Home | Pro addition / operational cost and residual gap |
|---|---|---|
| VPN / WireGuard / proxy / Tor | WFP peer/port/app controls; deny unapproved executables and tunnel installation. | Same underlying limit: HTTPS private proxies/bridges evade endpoint lists. Strict egress/app allowlisting breaks legitimate work VPNs and tools. |
| App DoH / literal IP / IPv6 | Loopback DNS, browser DoH policies, V4+V6 WFP controls. | GPO simplifies OS DNS policy. Private DoH over permitted HTTPS remains unless apps/destinations are constrained. |
| Portable/renamed browser | Publisher/hash-based app allowlisting, extension policy for approved browsers; no process-name-only guarantee. | Easier policy tooling. Costs: browser/update compatibility; permitted interpreters can themselves fetch/show content. |
| Linux live USB / boot order / BIOS | Partner-held firmware password, disable external boot where supported, supported Home Device Encryption with partner-held recovery access. These require setup beyond a service. | Full BitLocker management/TPM+PIN options. Secure Boot alone permits signed Linux; encryption protects the installed disk, not browsing from another OS. Physical firmware reset/reinstall remains possible. [BITLOCKER] |
| Sandbox / Hyper-V / VirtualBox / QEMU | Home lacks native Sandbox/full Hyper-V, **not** all VMs. Disable unnecessary virtualization components; app allowlist hypervisors and user-mode emulators. | Pro enables Sandbox/Hyper-V: disable if unsuitable. VMs needed for work need enforced guest/network controls; host ALE rules do not automatically cover bridged guest traffic. |
| WSL | Restrict `wsl.exe`, distro/package execution and optional features if unnecessary. | WSL2 exists on Home too. On supported builds configure Hyper-V firewall; test NAT, mirrored networking, DNS tunneling and forwarded traffic explicitly. Blocking only Windows DNS packets is insufficient. [HVFW] [WSL] |
| Safe mode / recovery | Standard account, protect recovery/admin credentials; do not register invasive SafeBoot persistence. | Neither edition guarantees ordinary Toolize service/filter availability in every recovery mode. Offline disk protection and controlled boot matter. |
| Kill service / helper | Service ACL, binary/ProgramData ACLs, SCM recovery, persistent WFP, helper supervision. | No edition makes same-user overlay immortal. Network policy can survive service death; local visual filtering may briefly stop. |
| Registry/state edits / uninstall | HKLM and installer/service/state ACLs; key-gated supported uninstall. | Admin can take ownership/replace policy or binaries; 30-second reconciliation is repair, not prevention. |
| Local admin | Recommend daily standard account, partner controls separate admin credentials. | No reliable Toolize guarantee against an administrator with recovery/boot control. Kernel watchdog escalation does not solve physical ownership. |
| RDP / remote browser / streaming | Block unapproved remote clients/services and known destinations; screen guard classifies decoded remote pixels if capturable. | Outbound RDP clients exist on Home; disabling Pro's inbound RDP host does not stop remote browsing. Browser-based remote desktops blend into HTTPS. |
| Phone hotspot / USB tether | Reconcile every interface; WFP covers host traffic regardless of gateway. | Defeats router-only filtering; work/private network compatibility needs testing. |
| Second device / phone | No PC-side counter. Partner/device-level policies if separately agreed. | Requires control of that device/network; do not imply PC software prevents it. |

**Existing windows of exposure:** code reconciles policies every **30 s**, checks watchdog state every **10 s**, regards extension heartbeats as stale after **90 s**, then applies a **2-minute** close grace; default watchdog is warning-only. From the last valid heartbeat, closure can therefore take roughly **210–230 s**, depending on tick alignment. The enforced extension's separate missing-service cover is documented at **10 minutes**. Process renaming and spoofed health reports further limit watchdog assurance. Independent persistent network policy closes many browser-specific holes, not local-file or secure-desktop ones.

## My recommended architecture

Planning estimates including testing, for one experienced Windows engineer: S ≈ 2–5 engineer-days, M ≈ 2–4 weeks, L ≈ 6–12+ weeks.

| Phase | Deliverable / exit condition | Effort |
|---|---|---|
| 1 | Service-owned signed OISD bundles, freshness/floor/rollback, extension synchronization. Test bad signatures, stale/delta mismatch and offline restart; preserve privacy text accurately. | M |
| 2 | Loopback DNS + persistent transactional WFP; browser/OS DoH controls; adapter/IPv6 reconciliation. Prove operation with extension removed, service restart, tethering and IPv6-only access; document arbitrary-HTTPS limits. | L |
| 3 | Optional strict setup: standard account, partner admin/recovery custody, audit-first app control, VM/WSL/remote-work exceptions. Clear status for each unprotected route. | M–L |
| 4 | Screen-guard spike: WGC then DDA fallback; whole-window covers before regional blur. Measure p50/p95 reaction, frame exposure, misses/false covers, GPU contention and battery at all three resolutions, mixed HDR and two monitors. Shipping depends on acceptable measurements. | S spike; L productization |
| 5 | Add targeted pause/redirect adapters and, only if quality warrants it, a local region detector. Keep IDD, global injection and kernel display filters outside the roadmap pending evidence. | M adapters; L localization |

## Open questions for the other council members

1. What observed exposure duration and false-cover rate are acceptable for adult versus child configurations?
2. Which modesty categories require a localized detector, and does the training corpus represent desktop composites and small subjects?
3. Which development workflows must survive: WSL/VMs, portable tools, custom HTTPS clients, VPNs, remote desktops?
4. Does optional family-DNS disclosure meet the privacy promise, or should local lists plus the existing resolver be the only default?
5. Who controls admin, firmware and recovery credentials, and what usable recovery path survives network/screen-guard failure?

Sources are linked at each citation; list sizes and artifact timestamps are observations from this session.

[WGC]: https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture
[INTEROP]: https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nn-windows-graphics-capture-interop-igraphicscaptureiteminterop
[DDA]: https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api
[DUP]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput
[DUP1]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_5/nf-dxgi1_5-idxgioutput5-duplicateoutput1
[MAG]: https://learn.microsoft.com/en-us/windows/win32/winauto/magapi/magapi-intro
[MAGCALL]: https://learn.microsoft.com/en-us/windows/win32/api/magnification/nf-magnification-magsetimagescalingcallback
[IDD]: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview
[IDDHDR]: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/iddcx1.10-updates
[SIGN]: https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-reqs
[ATTEST]: https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-attestation
[DRIVERSIGN]: https://learn.microsoft.com/en-us/windows-hardware/drivers/install/driver-signing
[AFFINITY]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity
[SMTC]: https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager
[INPUT]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
[NRPT]: https://learn.microsoft.com/en-us/powershell/module/dnsclient/add-dnsclientnrptrule
[DNSPOLICY]: https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-admx-dnsclient
[WFP]: https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmfilteradd0
[CONDITIONS]: https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-
[CHROMEDOH]: https://chromeenterprise.google/policies/#DnsOverHttpsMode
[EDGEDOH]: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/dnsoverhttpsmode
[BUILTINDNS]: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/builtindnsclientenabled
[WINDoH]: https://learn.microsoft.com/en-us/windows-server/networking/dns/doh-client-support
[ECH]: https://www.rfc-editor.org/rfc/rfc9849.html
[ECHDEPLOY]: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/ssl/edge-certificates/ech.mdx
[CLEAN]: https://cleanbrowsing.org/filters/
[CF]: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/1.1.1.1/setup/index.mdx
[NEXT]: https://nextdns.io/
[OPEN]: https://www.opendns.com/setupguide/#familyshield
[OISD]: https://oisd.nl/faq
[OISDFILE]: https://nsfw.oisd.nl/domainswild2
[HAGEZI]: https://github.com/hagezi/dns-blocklists#nsfw
[STEVEN]: https://github.com/StevenBlack/hosts
[ONE]: https://github.com/badmojr/1Hosts
[BLP]: https://github.com/blocklistproject/Lists
[BLPFILE]: https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt
[BLPLIC]: https://github.com/blocklistproject/Lists/blob/master/LICENSE
[SESSIONS]: https://learn.microsoft.com/en-us/windows/win32/services/interactive-services
[APPCONTROL]: https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/feature-availability
[APPLOCKER]: https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/requirements-to-use-applocker
[BITLOCKER]: https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/
[HVFW]: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall
[WSL]: https://learn.microsoft.com/en-us/windows/wsl/networking
