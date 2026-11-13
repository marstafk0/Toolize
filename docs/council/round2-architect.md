# Round 2 — Architect / ML lead

Date 2026-11-12. Read: all three round-1 papers, CLAUDE.md, and the code each paper cites. Code claims are checked at file:line; Windows and Chrome facts link to primary sources. *est.* marks a planning number.

## 0. A gap none of us named (it reshapes M1)

A standard user can impersonate our native messaging host and turn protection off while the watchdog stays happy.

- **The browser picks the user's host first.** Chromium reads `HKCU\…\NativeMessagingHosts` before HKLM unless user-level hosts are disallowed ([CRLAUNCH] `launch_context_win.cc:188-196`). We register HKLM only (`installer/toolize.iss:68-70`).
- **The extension trusts its host.** It adopts whatever settings the host returns (`background/companion.ts:94-97`).
- **The service can't spot a fake.** The pipe admits any authenticated user (`Toolize.Core/Pipe.cs:17-19`), and heartbeats are keyed by the browser brand the extension *reports* (`Services.cs:129`, `companion.ts:63`).

An HKCU host that relays heartbeats to the real pipe but answers the extension with `enabled:false` turns off blur, DNR, words and fail-closed, unseen by the watchdog. Difficulty ~3, no admin. Fix: policy `NativeMessagingUserLevelHosts=0` [NMUSER], and the service identifies the host itself (pipe-client PID → image path → parent browser process). Brand keying also lets one healthy Chrome profile vouch for a `--user-data-dir` instance whose force-install was blocked (e.g. a PAC file dropping the Web Store).

## 1. Adjudications

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | DDA vs WGC | **Both, different jobs.** DDA for always-on discovery; WGC re-checks covered windows | WGC fails when run as SYSTEM; Sunshine's workaround is DDA or a user-context process [SUN2846][SUN3060]. DDA docs name LOCAL_SYSTEM as a caller [DUP]. WGC window capture reads the window's own surface, so it sees under our cover (not when minimized). Borderless needs `RequestAccessAsync(Borderless)` plus a package capability [WGCBORDER]; unpackaged is undocumented → G0 test |
| 2 | 2 fps foreground vs change-driven | **Change-driven, plus a floor** | Foreground-only misses background windows and second monitors; app lists lose to renaming (red team B2); 2 fps adds ≤500 ms and burns idle power. Adopt their safety net: whole-window sample every 2 s for changed windows with no live track |
| 3 | Auto-scroll/minimize vs cover | **Cover first; no synthetic scroll.** Minimize only when a cover can't render, or after 60 s under cover for an unmanaged browser | Scrolling can reveal worse content and races focus. Systems agrees |
| 4 | Guard in the roadmap | **Split.** Session agent + *deterministic* covers = M1. ML shadow (G0) beside the network work; ML covers (G1) after the FP gate; default-on per preset after that | Browser covers need the same agent and windows. "P5 opt-in" delays that; a "phase-4 spike" delays FP data, which needs calendar time |
| 5 | No TLS MITM | **Unanimous.** Also no WinDivert/SNI parsing | DNS + WFP ALE need no payload; ECH defeats SNI parsing anyway |
| 6 | SafeSearch: DNS CNAME vs DNR | **Both layers.** Policy + DNR in managed browsers; resolver CNAMEs for all other apps at N2 | DNR survives DoH and covers engines without a forced-safe host (`search-rules.ts:3-11`). Google: CNAME `www.google.com` + country domains → `forcesafesearch.google.com` [GSAFE]. YouTube: five hostnames → `restrict`/`restrictmoderate.youtube.com`, never `youtube.com` [YTR]. NODATA for HTTPS/SVCB on rewritten names |
| 7 | Dual-Lock, 24 h cooldown | **Adopt as optional "weakening delay"**, off by default; for self-held keys | Keeps "unlock = key presence": request with key → wait → commit only if the key is present again. Covers protection/enforcement off, uninstall, preset down, new key, recovery code. Shortening it is delayed too. Pointless with a partner-held key |
| 8 | Default Watchdog=Close, 15 s grace | **Reject: it closes healthy browsers.** New `Cover` level, default once a key is enrolled and Enforce is on; Close after 60 s under cover | After each service restart (every update) the tracker is empty and heartbeats come every 30 s (`Services.cs:36`, `companion.ts:16`), so 15 s closes healthy browsers. Better signal: `connectNative` keeps the worker alive (Chrome 105+) [SWLIFE], so host exit = extension stopped, near-instantly. Grace from max(service start + 45 s, browser start + 20 s). Enums serialize as strings (`Protocol.cs:27`), so `Cover` fits between Warn and Close |
| 9 | Service DACL hardening | **Adopt as admin friction**, relaxed while the key is present | Standard users already can't stop it: interactive users get only `CCLCSWLOCRRC` (`sc sdshow Toolize`). For admins, 5 s `sc stop` becomes minutes. Never deny SYSTEM; document admin recovery; close "service missing ⇒ uninstall allowed" (`toolize.iss:236`). Friction, not a boundary |
| 10 | ECH blocking via DNS | **Reject** | Our resolver sees the real name with or without ECH; we inspect no SNI |

**Other claims, checked.** ✔ watchdog name list, 2-min grace, name matching (`WatchdogService.cs:27,41-42,143`); ✔ defaults off/Warn (`Settings.cs:69,73,80`); ✔ clock bug (`failclosed.ts:17`; needs admin to exploit, fix anyway); ✔ overlay has no observer, though it returns within 60 s (`content/index.ts:65`); ✔ systems' timings (`EnforcementService.cs:20`, `Services.cs:36`) and RSA-not-Ed25519 (`Updater.cs:70-72`). ✘ "stopping the worker disables DNR": the browser evaluates DNR without it. ✘ "libcef/chrome_elf ⇒ browser": that closes Spotify, Steam, Electron apps; use PE OriginalFilename/ProductName + window class. Blocking `chrome://flags`: test first, Edge warns of "unexpected errors" [URLBL]. Safe Mode: overstated; policy values persist, so managed browsers still fail closed; register `SafeBoot\Network` for the unmanaged-browser gap after a clean-start test.

## 2. Self-check: corrections to my round 1

| Round-1 claim | Verdict | Correction |
|---|---|---|
| SYSTEM token in session N, "[SESSIONS] recommends this split" | **Wrong as cited** | Microsoft says to run the helper "within the context of the interactive user", and that LocalSystem "should not create a window on the interactive desktop" [SESSIONS] |
| "A same-user guard is weak: its owner can always rewrite the DACL" | **Wrong** | An OWNER RIGHTS (S-1-3-4) ACE replaces the owner's implicit READ_CONTROL/WRITE_DAC [OWNER] |
| DDA under SYSTEM "to verify" | **Supported** | [DUP]; Sunshine's service mode uses DDA |
| "8.5 ms measured", batch 1 on the 5070 Ti | **Unsourced** | The repo measures ~20 ms per batch of 8 (`safety-classifier.ts:10`). Batch 1 is *est.* |
| iGPU: 15–30 ms per region | **Plausible** | 12.22 GFLOPs [OCLIP] at ~1–1.4 TFLOPS achieved FP16 on Iris Xe ≈ 9–12 ms batched |
| Gate: >128 colours per 16×16 block ⇒ photo | **Blind spot** | Cel-shaded art (visual novels, hentai) can fall below it. Add the 2 s floor, and measure gate recall on the drawn-style set offline (block statistics are numbers, so nothing is viewed) |
| Capture costs ~0 when idle | **Incomplete** | Unknown whether DDA/WGC demote independent flip or MPO (game latency, battery during video). G0 gate: PresentMon, plus a 1 h video battery A/B |
| Acrylic falls back to a solid tint, so it fails safe | **Unverified** | Covers are opaque by default; acrylic only after a test proves its fallback is opaque |
| Exposure of 2–3 / 3–9 refreshes | **Stands (est.)** | Capture arrives at composition, and the cover lands 1–2 refreshes later. p95 is GPU contention |

**Session 0, per Microsoft.** Services can't show UI since Vista (`NoInteractiveServices`=1) [SESSIONS]. Supported routes: `WTSSendMessage` (today's `SessionNotifier.cs:35`) and `CreateProcessAsUser`. Setting `TokenSessionId` needs "Act as part of the operating system" [TOKEN], which SYSTEM holds. So a SYSTEM-token guard works (remote-access tools do it), but it runs against the documented caution and makes every GUI-thread bug a SYSTEM bug.

**Revised process model.** The guard runs **as the interactive user** (`WTSQueryUserToken`), launched by the service with:
- a process and thread descriptor of SYSTEM full, OWNER RIGHTS = SYNCHRONIZE | QUERY_LIMITED, nothing for the user;
- the same token default DACL, so new threads inherit it;
- a service-held handle, progress heartbeat, relaunch <2 s.

UIPI doesn't separate equal integrity levels, so covers veto `ShowWindow`/`SetWindowPos`/style changes in `WM_WINDOWPOSCHANGING`/`WM_STYLECHANGING` and re-assert. G2 tests a service-raised integrity level and the UIAccess band (needs signing). SYSTEM token only if this fails the tamper checklist. Inference stays in a restricted, no-network child; GPU access under it is a G2 test.

## 3. Unified architecture

```
┌──────────── Toolize.Service — SYSTEM, session 0, the only authority ─────────────┐
│ settings · key + weakening delay · policy reconcile · updater · signed lists (N1)│
│ host identity map (pipe PID → browser PID) · guard supervisor · tamper log       │
└────┬──────────────────────────────┬─────────────────────────────┬────────────────┘
 native messaging             per-session pipe              loopback DNS + WFP (N2)
 (HKLM host only)             (SYSTEM + guard)              every app on the PC
     │                              │                             │
┌────┴── Extension (managed) ──┐ ┌──┴── Toolize.Guard — user identity, hardened ─────┐
│ pre-paint safe-reveal,       │ │ M1: surface watcher — PE identity + host map →    │
│ per-element ML, DNR lists +  │ │     whole-window covers: unmanaged/silent browser,│
│ SafeSearch rewrite, words,   │ │     blocked apps                                  │
│ feeds, bot shield,           │ │ G0+: DDA → gate → proposals → tracks → region     │
│ fail-closed                  │ │     covers; WGC per covered window; SMTC pause    │
└──────────────────────────────┘ │  └ Toolize.Infer: restricted, no net, tensors only│
                                 └───────────────────────────────────────────────────┘
Resolver: block list · CNAME SafeSearch/YouTube · NODATA HTTPS RR on rewritten names
WFP: deny external 53/853 and known DoH/VPN endpoints · browser DoH off by policy
```

| Function | Owner | Backstop | If the owner dies |
|---|---|---|---|
| Settings, key, weakening (+ delay) | Service | — | Extension fails closed (90 s); guard keeps its covers |
| Known adult domains | Extension DNR now → resolver at N2 | The other one | DNR rules persist without the service |
| SafeSearch / YouTube restrict | Policy + DNR in managed browsers | Resolver CNAMEs (N2) | Policy values persist |
| Images and video in managed browsers | Extension | Guard, "obvious" rule only | Blur stays (fail safe) |
| Unmanaged or silent browsers, blocked apps | Guard covers (deterministic) | Service closes the process | Relaunch; closing still works |
| Pixels in native apps, VMs, RDP | Guard ML (G1) | Network plane | Strict: covers stay; adult: degraded banner |
| Word filter, feeds, bot shield | Extension | — | — |
| List download and verification | Service (N1) | Extension's daily fetch until N1 | Last-known-good list |

## 4. Your three decisions

1. **In-memory composites: yes, with guardrails.** Built inside the training process only from images the labelled dataset already holds (no new downloads); never encoded to a file or displayed; only embeddings, boxes and scores persist; the module imports no image writer (test-enforced); a second agent reproduces the numbers. **Why:** the only way to measure recall by on-screen size and train regional heads without anyone viewing positives, within the "never save or show explicit images" rule. **If no:** approximate with downscaled whole images; regional heads train on safe composites only.
2. **Code signing: not yet.** The revised guard runs as the user, which removes most of my round-1 worry about an unsigned SYSTEM agent. Revisit at G2 if Defender/SmartScreen flags the shadow guard or covers keep losing z-order (UIAccess needs a signed binary in a secure location). Individual Artifact Signing is US/Canada only [ARTSIGN]; elsewhere, an OV certificate on a hardware token.
3. **Cover reveal: always needs the key.** Deterministic covers and Kids: key only. Adults on ML covers get "Report false cover" (numbers to the verdict log, cover stays) and "Trust this app" (key). **Why:** a keyless reveal is a one-click bypass for exactly the borderline content the guard exists for; the FP budget (≤1 unwarranted/hour before default-on) and per-app trust handle the annoyance.

## 5. Milestone M1 — "no unprotected browser, no fake host" (~2 weeks, one engineer)

**Scope**

1. **Policy** (PolicyPlan, `AllOwned` and the installer mirror):
   - `NativeMessagingUserLevelHosts=0`.
   - `NativeHostsExecutablesLaunchDirectly=1`, so hosts survive a disabled cmd.exe [NHDIRECT].
   - `DnsOverHttpsMode="off"`, a prerequisite for N2.
2. **Host identity.**
   - `GetNamedPipeClientProcessId` → image must be the installed `Toolize.NativeHost.exe` → walk parents (through cmd.exe if present) to the browser's main process, checking creation times.
   - Key the tracker by browser PID.
   - Host exit means the extension stopped; allow 10 s to reconnect.
3. **`Toolize.Guard` v0, no ML.**
   - The service launches it per session (logon, unlock, user switch) with the hardened descriptor.
   - It identifies browsers by PE identity plus window class.
   - It draws opaque whole-window covers:
     - over unmanaged browsers within 1 s;
     - over silent managed instances once the reconnect allowance is used up;
     - over an optional blocked-apps list (Discord and Telegram desktop → "use it in the browser"; off for adults by default).
   - It closes the process after 60 s when set to Close.
4. **Watchdog levels Off / Warn / Cover / Close.** New enforced setups with a key default to Cover; the setup wizard pre-checks Enforce and BlockOtherExtensions.
5. **Fail-closed.** A future `lastSeen` is stale; stale only after a failed reconnect since `lastSeen` (no overlay flash on wake); re-check on storage change; a dynamic DNR rule redirects `main_frame` while stale; grace 10 min → 90 s.

**Stretch:** service DACL hardening, relaxed while the key is present.

**Acceptance tests** (both machines; Chrome, Edge and Brave)

1. **Fake host.** Register an HKCU `com.toolize.host` that relays to the real pipe. Pass: the browser still launches the HKLM host and settings stay unchanged. Control run without the policy: the attack must succeed.
2. **Renamed and portable browsers.** Renamed portable Firefox (`notepad2.exe`), Tor Browser and LibreWolf. Pass: covered within 1 s at p95 over 20 launches (window shown → cover visible), and closed at 60 s under Close.
3. **Blocked force-install.** `chrome --user-data-dir=%TEMP%\x` with a PAC file that blocks the Web Store. Pass: covered until its own host connects; the main profile is untouched.
4. **Extension stopped.** Kill the host, or end the extension in the browser's task manager. Pass: covered within 15 s, and the cover clears on reconnect.
5. **No false lockouts.** 10 service restarts, 2 button updates, and 5 sleep/wake cycles of at least 30 min. Pass: zero covers, closures and overlays while the extension is healthy.
6. **Standard-user tamper.** taskkill, Task Manager End task, Process Explorer suspend, and a script that hides or moves covers. Pass: access denied, or the cover is restored within 100 ms.
7. **No collateral.** VS Code, Discord (unlisted), Spotify, Steam, Teams/WebView2 and Thunderbird. Pass: never covered over 8 h of normal use.
8. **Unit tests.** Policy values and cleanup; `IsWeakening` for Close→Cover→Warn; fail-closed with a future timestamp and after wake; tracker keyed by PID.
9. **Budget.** Guard idle CPU <0.5%, RSS <80 MB.

**Gain:** closes the commonest difficulty-1–2 bypasses (B1, B2, B5 variants) and a difficulty-3 total bypass; an unprotected browser is covered in ~1 s instead of closed after 210–230 s (never, under the default Warn); builds the agent and cover plumbing G1 reuses. **Not covered:** Discord/Telegram content unless blocked, VMs, local media (G0/G1, N2).

**Then:** N1 signed lists in the service (M) ∥ G0 shadow (S + calendar) → N2 resolver + WFP (L) ∥ G1 → G2 → G3/G4.

## Sources

[CRLAUNCH]: https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/messaging/launch_context_win.cc
[NMUSER]: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/nativemessaginguserlevelhosts
[NHDIRECT]: https://textslashplain.com/2023/03/16/improving-native-message-host-reliability-on-windows/
[URLBL]: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/urlblocklist
[SWLIFE]: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
[SUN2846]: https://github.com/LizardByte/Sunshine/issues/2846
[SUN3060]: https://github.com/LizardByte/Sunshine/issues/3060
[DUP]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput
[WGCBORDER]: https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired
[SESSIONS]: https://learn.microsoft.com/en-us/windows/win32/services/interactive-services
[TOKEN]: https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class
[OWNER]: https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-vista/cc749445(v=ws.10)
[GSAFE]: https://support.google.com/websearch/answer/186669
[YTR]: https://knowledge.workspace.google.com/admin/youtube/control-youtube-content-available-to-users
[OCLIP]: https://github.com/mlfoundations/open_clip/blob/main/docs/model_profile.csv
[ARTSIGN]: https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident
