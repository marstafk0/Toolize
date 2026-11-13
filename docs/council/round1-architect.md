# Round 1 — Product architect + ML/perception proposal

Role: product architect and ML/perception lead. Date: 2026-11-12.

**What I read:** CLAUDE.md, README.md, `tools/safety-model/{README,ensemble-audit,ensemble-review}.md`, `extension/src/offscreen/*`, `extension/src/content/{engine,video}.ts`, `extension/src/shared/{policy.ts,blur.css}`, `round1-systems.md`, and `round1-redteam.md` (after drafting).

**Numbers:** *measured* figures come from the repo's audits; *est.* figures are planning estimates that G0 must replace.

## Summary

1. **Keep the extension as the browser's visual layer.** Only DOM safe-reveal keeps an `<img>` hidden from the very first frame. Any screen-level layer shows something before it can react.
2. **Add a screen guard** for native apps, VMs, remote desktops and unmanaged browsers. It also backstops the extension.
   - It cannot promise "never seen". People get the gist of a picture shown for 13 ms [POTTER].
   - The best screen pipeline still shows content for 2–3 refreshes (cover-new mode) or 3–9 (classify-then-cover).
   - The UI must say so, as HarmBlock does [HARMBLOCK].
3. **Make the guard change-driven, not frame-driven.** Stages, in order:
   1. DDA dirty rects.
   2. A block map separating photos from screen content.
   3. Region proposals.
   4. The **same** safety-v3 ONNX plus NSFWJS, running on Windows ML (NPU first).
   5. The temporal rules from `video.ts`.
   6. Covers that are excluded from capture.

   Normal use needs 0–15 inferences per second, not 60.
4. **Launch the guard with a SYSTEM token into the user's session**, with inference in a restricted child process that has no network access.
   - A standard user cannot kill, suspend or inject it. That closes the gap round1-systems accepts for a same-user helper.
   - Admins can still stop it. Protected Process Light (PPL) is not available to us.
5. **Modesty-first models.** Train a multi-label head on the frozen RN50 embeddings, with outputs for explicit, nudity, underwear/swim, revealing, suggestive and romance.
   - It learns from weak labels we already have or can compute numerically. No explicit image is saved or shown.
   - Presets: Kids, Teen, Adult-modest and Explicit-only.
6. **Cross-checks:**
   - Cover a browser window as soon as its extension goes silent. Today the browser is only closed after about 210–230 s.
   - Treat disagreement between the extension and the guard as tampering or a missed image.
   - Cover windows that hide themselves from capture [GETAFF][WINHIDER].
7. **Order:** run the guard in shadow mode (numbers only, draws nothing) alongside the signed-list phase. False-cover data needs calendar time, not engineering time.

## A. PC-wide visual detection pipeline

### A.1 End to end

```
DDA per output (BGRA8, or FP16 when HDR) on the adapter that owns the output
  │ dirty rects, move rects, ProtectedContentMaskedOut flag
  ▼
GATE     GPU compute over dirty area only: 16×16 block stats (unique colours,
         gradient energy, luma variance) → "natural image" vs "screen content"
  ▼
PROPOSE  photo-like components ∩ window client rects (z-order, DWM bounds)
         → boxes ≥48 px; boxes >~900 px get 2×2 tiles; perceptual-hash cache
  ▼
INFER    restricted worker: crop + squash to 224 on GPU → safety-v3 + NSFWJS;
         buckets 1/2/4/8; per-second token bucket; NPU ▸ vendor GPU EP ▸ DirectML
  ▼
TRACK    per (HWND, region) state machine = the video.ts rules
  ▼
ACT      region cover ▸ window cover ▸ SMTC pause ▸ opaque full-screen window ▸
         ask the extension. Overlays carry WDA_EXCLUDEFROMCAPTURE.
```

### A.2 Capture: DDA first, WGC second (the reverse of round1-systems)

| Need | DDA | WGC |
|---|---|---|
| No capture border | Never shows one | Shows a yellow border unless `IsBorderRequired=false` is set after user consent. Consent needs the `graphicsCaptureWithoutBorder` package capability, which an unpackaged SYSTEM helper doesn't have [WGCBORDER] |
| Runs under SYSTEM in a user session | Docs name LOCAL_SYSTEM as the most privileged caller [DUP]; G0 verifies it on the Default desktop | User-context API; untested under SYSTEM |
| Change information | Dirty and move rects on every supported build | Dirty regions only from 24H2, thinly documented [WGC24H2] |
| Hybrid-GPU laptops | Must run on the adapter driving the panel, or fails with `DXGI_ERROR_UNSUPPORTED` [DDAHYBRID] | Captures across adapters |
| Exclusion | Respects display affinity, plus the DDA-only `WCA_EXCLUDED_FROM_DDA` [WCA] | Respects display affinity |

Use DDA for the always-on path. Use WGC per-window samples only for the cross-check in C.3. On hybrid laptops, capture and infer on the iGPU or NPU so the discrete GPU stays asleep.

### A.3 Change detection, scroll, cache

- **Gate.** Only dirty rects are examined.
  - Text and UI use few colours and sharp edges. Photos and video are continuous-tone.
  - A 16×16 block with more than 128 unique colours is a standard "natural image" cue in screen-content coding [SCC].
  - Gradient energy keeps smooth gradients out.
  - Cost: est. 0.3–1 ms of GPU time for a full 1440p change, about 0 when idle.
- **Scroll.** Use DDA move rects when reported, otherwise phase correlation on a 1/8-scale luma strip.
  - The detected scroll vector moves covers and verdicts instead of re-classifying.
  - Covers are padded by velocity × latency (3,000 px/s × 33 ms ≈ 100 px), so the leading edge never peeks out.
- **Window moves.** An out-of-context `SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE)` moves covers before the next capture. Nothing is injected.
- **Cache.** A 64-bit perceptual hash of each 224 px crop maps to its verdict. The cache holds 5,000 entries, the same as the extension's `CACHE_MAX`.

### A.4 Region proposal

- **What counts as a region:** photo-like components, clipped to window client rects. Per-app UI Automation bounds are an optional adapter, never a dependency.
- **Size floor:** under 48 px is skipped, as in the extension.
- **Whole-window classification is only a fallback.** Squashing a 2560 px window to 224 px shrinks a 150 px thumbnail to about 13 px, which the model cannot see.

### A.5 Classifier

- **Same model, native runtime.**
  - Ship `safety-v3.onnx` unchanged, with its pinned SHA and its `pixels[B,3,224,224] → probs[B,1]` interface.
  - Add NSFWJS MobileNetV2 as ONNX, because `decide()` and the "obviously explicit" rule need both models.
  - Port `policy.ts` once, with a parity test, so the extension and the guard can't drift apart.
- **Windows ML** (generally available since September 2025) includes CPU and DirectML, which it labels "legacy". On 24H2+ it downloads vendor providers: QNN, OpenVINO, VitisAI, NvTensorRtRtx and AMD GPU [WINML][WINMLEP].
  - Order: NPU first (it leaves the GPU to games), then the vendor GPU provider, then DirectML.
  - RN50 on the CPU is too slow (about 470 ms on WASM). Without an accelerator the guard runs visibly degraded.
- **A converted or quantized model is a new model.** An int8 NPU build must pass every v3 gate (full and deduplicated recall, drawn floor, held-out swimwear/lingerie, video-frame false positives) plus the v3 review's "ONNX on pixels" check.
- **Cost.** The RN50 image tower costs about 12.2 GFLOPs at 224 [OCLIP]; NSFWJS adds about 0.6. Tiling a whole window at 448 px means about 24 tiles at 1440p and 45 at 4K, so it runs on demand only.
- **GPU contention.**
  - Batches are capped at 8, the extension's lesson.
  - The guard has its own D3D12 queue.
  - A game profile starts when `SHQueryUserNotificationState` reports a full-screen D3D app [QUNS].

### A.6 Compute budget

| | iGPU laptop (Iris Xe / 780M class) | Copilot+ laptop (NPU ≥40 TOPS) | Desktop RTX 5070 Ti |
|---|---|---|---|
| One region, batch 1 | 15–30 ms *est.* | 3–6 ms *est.* (ResNet-50: 2.07 ms on X Elite NPU [AIHUB]; ours is ~1.5× its FLOPs) | 8.5 ms *measured* (WebGPU); 2–4 ms native *est.* |
| Per region, batch of 8 | 8–15 ms *est.* | 2–4 ms *est.* | 2.7 ms *measured* (WebGPU) |
| Office/IDE (0–1 region/s) | <3% iGPU | ~0 GPU, <1% NPU | <1% |
| Scrolling an image grid (~10 new regions/s after cache) | 8–15% | 2–4% NPU | ~3% |
| Native video region (2 samples/s) | 3–6% | ~1% | <1% |
| Whole-window sweep, 1440p (24 tiles) | 200–360 ms, on demand only | 50–100 ms | ~65 ms |
| Game profile (whole window, 0.5–1/s) | 1–3% | ~0.5% NPU | <1% |

- **Budget in new pictures per second, not frames.** A token bucket allows 15 regions/s on an iGPU and 40 on an NPU or dGPU.
- **Over budget:** strict presets cover regions not yet classified (fail safe). Adult presets classify the largest regions first.

### A.7 Exposure window

Assumptions: capture delivers the composed frame at about the vsync where it becomes visible, and a cover appears 1–2 refreshes after the decision. All rows are *est.* until G0 measures them with GPU timestamps and a test glyph.

| Path | 60 Hz | 144 Hz |
|---|---|---|
| Extension, `<img>`/`<video>` before first reveal | **0 frames** (CSS applied before first paint) | 0 |
| Guard, **cover-new** (cover every new photo region, reveal once clean) | 2–3 refreshes, ~33–50 ms | ~15–25 ms |
| Guard, classify-then-cover, dGPU/NPU | p50 2–3, p95 ~4 refreshes (~70 ms) | p50 ~25 ms |
| Guard, classify-then-cover, iGPU | p50 3–4, p95 6–9 refreshes (100–150 ms) | p95 ~100 ms |
| Shown video turns explicit (extension today) | Sampling has backed off to every 4 s, and scene changes don't reset it. Obvious content is caught in ≤4 s, anything else in ~5 s | same |

- **Cover-new is the screen version of safe-reveal.** It suits Kids and strict presets, at the cost of a grey flicker on every new picture.
- **A cheap scene-cut detector closes the backoff hole.** A frame-difference histogram resets sampling to 4/s after a cut. Port it to `video.ts` too.

### A.8 Temporal smoothing: port the video rules

| `video.ts` rule | Guard rule |
|---|---|
| Before first show, any doubtful frame keeps it blurred | Cover-new for new photo regions (strict) |
| Once shown: 2 flagged frames of the last 3, or 1 obvious frame (safety > 0.97 **and** NSFWJS flagged) | Same, per region track. Safety alone never skips the window |
| Borderline frames count as clean for video | Same |
| 3 clean frames to reveal; a still image needs 1 verdict | Same, plus a cover stays up at least 1 s and never fades through |
| Pause only when confirmed; never pause YouTube | SMTC pause only when confirmed; browser media is left to the extension |
| Back off while stable; one video at a time when saturated | Same, plus the scene-cut reset |

Tracks match across frames by window, IoU ≥ 0.7 and perceptual hash, so a moving thumbnail keeps its verdict.

### A.9 Actuators, in escalation order

| Action | When | Notes |
|---|---|---|
| Region cover: solid or mosaic + grayscale, or compositor acrylic (see red-team notes) | Default | Click-through by default. In strict mode it swallows clicks, so "click to enlarge" fails |
| Window client cover | Tracking lost, too many regions, strict over budget, or the window hides from capture | |
| SMTC pause | Confirmed video in an app that supports SMTC | Cover first [SMTC] |
| Opaque, normal full-screen window | Exclusive full-screen, or anti-cheat present | Most games run under Fullscreen Optimizations, which can still show overlays. Legacy exclusive mode can't [FSO] |
| Extension acts (blur, redirect, close tab) | Managed browser window | Guard covers until the extension confirms |
| Kids escalation | Repeated explicit hits in one app within 10 min | Block the app for the session; the partner log holds counts only |

- Covers exist only while something is flagged, so independent flip is unaffected the rest of the time.
- No synthetic scrolling or other input.

### A.10 Process model and protection

```
Session 0                       Session N (interactive)
┌──────────────────┐ CreateProcessAsUser ┌──────────────────────────────────────┐
│ Toolize.Service  │ (dup SYSTEM token,  │ Toolize.Guard — SYSTEM, session N    │
│ SYSTEM authority │  TokenSessionId=N,  │ DDA ▸ gate ▸ proposals ▸ tracks      │
│ supervisor, WFP  │  winsta0\default)   │ overlay HWNDs ▸ SMTC                 │
│                  │◀─ SYSTEM-only pipe ─│ 500 ms heartbeat with counters       │
└──────────────────┘                     │   │ shared memory (tensors only)     │
                                         │ Toolize.Infer — restricted, low IL,  │
                                         │ no network (WFP), explicit DACL      │
                                         └──────────────────────────────────────┘
```

- **Launch.** The service already targets the console session (`SessionNotifier.cs`) and needs session-change handling added.
  - On logon or unlock, it duplicates its token, sets `TokenSessionId` and starts the guard on `winsta0\default`.
  - Remote-access tools run elevated capture helpers in the user session for the same reason [RUSTDESK].
  - Microsoft recommends this split over interactive services [SESSIONS].
- **Protection.** The guard's DACL is set explicitly to SYSTEM and Administrators, so a standard user can't terminate, suspend, write to or debug it.
  - UIPI blocks most messages and hooks from lower-integrity processes.
  - A same-user guard would be weak, because a process's owner can always rewrite its DACL.
- **Inference in a separate process.** A SYSTEM process shouldn't run a model runtime and GPU driver code on pixels an attacker can influence. The child process:
  - has a restricted, low-integrity token;
  - can't write files or reach the network;
  - receives tensors only, so no image format is parsed anywhere;
  - has its own explicit DACL.
- **Job object (service-owned).**
  - Memory cap, below-normal priority, no breakaway, die on an unhandled exception.
  - Deliberately *not* kill-on-close: if the service crashes, the covers stay up while the Service Control Manager restarts it and it re-adopts the guard.
- **Heartbeat carries progress.**
  - It reports frames acquired, regions classified, covers drawn and backend state.
  - "Alive but no frames for 3 s with the display on" counts as failure and triggers a relaunch (target under 2 s).
  - The pipe's ACL is SYSTEM-only, so nothing can impersonate the guard.
- **Limits.** An admin can kill all of it. PPL requires an ELAM driver and Microsoft's anti-malware program [PPL].

## B. Modesty-first models

### B.1 Taxonomy and presets

| Level | Content | Kids | Teen | Adult-modest | Explicit-only |
|---|---|---|---|---|---|
| 5 Explicit | sex acts, genitals, hentai | hide | hide | hide | hide |
| 4 Nudity | exposed breasts or buttocks, nude art | hide | hide | hide | hide |
| 3 Underwear/swim | bikini, lingerie, briefs | hide | hide | hide | — |
| 2 Revealing | cleavage, midriff, sheer or very short | hide | hide | option | — |
| 2s Suggestive | sexualised pose while clothed | hide | option | option | — |
| 1 Romance | kissing, intimate embrace | hide | option | — | — |

- **Drawn and anime images** get their own attribute and thresholds. anime-gap.md shows false positives on drawings are the costly side.
- **Today's single head answers "is this level 3–5?"** because swimwear and lingerie were trained as "block".
  - So `relaxed` asks the same question at a higher threshold. It is not "explicit only".
  - Separate heads make each preset mean what it says.

### B.2 Building it without saving explicit images

| Signal | Gives | How |
|---|---|---|
| Existing labels (nsfw_detection_xl, MIT) | nsfw / sfw | Stored |
| NSFWJS 5-class scores | porn, hentai, sexy, drawing | Stored as numbers |
| NudeNet 640m (AGPL; offline only, never shipped) | Exposed vs covered body parts with boxes → levels 2–5 | Decoded in memory, as `labelfilter.py` does. Rejected as a veto, fine as one noisy vote |
| CLIP RN50 text prompts vs the stored image embeddings | Soft romance / swim / revealing / drawn scores | Numbers only, no pixels |
| Human review of Commons, levels 0–3 only | Gold labels for the levels that can be viewed | The existing review flow and `exclude.txt` |
| Screen composites (**needs your sign-off**) | Screen-scale positives with free bounding boxes | In memory: paste a decoded image onto a UI or game background, embed, discard. Never written or displayed |

- **Training:** a weighted label model combines the signals [SNORKEL], then 5-seed multi-label heads train on the frozen embeddings, following the v3 recipe.
- **Levels 4–5 are never labelled by hand.** Agreement among the dataset label, NudeNet and NSFWJS stands in, and the disagreement rate is published.

### B.3 Localization from the same backbone

- **Method.** RN50 stays convolutional up to its attention pool. MaskCLIP gets usable dense predictions by recasting that pool's projections as 1×1 convolutions [MASKCLIP]. Run our heads on the per-location embeddings to get a 7×7 map at 224 px, or 14×14 at 448.
- **Status: experimental.** The shift from pooled to per-location embeddings is untested.
- **Training data for a dense head.** Composites supply exact paste boxes, so it can be fine-tuned without anyone viewing an image.
- **Payoff.** Region blur without a second detector.

### B.4 Screen imagery, and not covering UI

- **New negatives:**
  - Playwright-rendered UI from curated safe pages;
  - documents, code, maps and charts;
  - locally rendered frames from open-source games (SuperTuxKart, Luanti);
  - CC-licensed safe anime;
  - e-commerce clothing, which marks the revealing-vs-fine boundary.
- **The gate keeps most UI away from the model.** A cover over pure UI chrome is a P1 bug, tracked by its own metric.
- **Game titles and ad sources are held out whole**, as YouTube channels are today.

### B.5 Evaluation discipline

1. Each source has a frozen held-out set, looked at once. Every round adds a fresh slice, because the v3 review flagged a second look at the same set.
2. Dedupe held-out items with cosine > 0.995 to any training item. Report full and deduplicated results.
3. Hold out whole groups: Commons category, channel, game title, app family, artist.
4. Claim a gain only above about 2× the paired-seed standard deviation (measured at 4.66 items).
5. Report recall by on-screen size, using composites: 48–96, 96–192, 192–384 and ≥384 px.
6. Count covers per hour in scripted sessions and shadow-mode logs (numbers only).
7. Check parity: the same image in a desktop viewer and in the browser scores within 0.05 safety on ≥95% of a safe set.
8. A second agent reproduces the results before release, as for v3.

## C. "Extension + app" vs "app does everything"

| | Extension + screen guard + network | App only (guard + network) |
|---|---|---|
| First exposure in the browser | 0 frames for images and video | 2–9 refreshes |
| Context (URL, query, channel, feeds, comments, learned sites) | Yes | Pixels only |
| Native apps, VMs, RDP, WSLg, unknown browsers | Guard | Guard |
| Bypass by a standard user | Policy stops disabling the extension, the guard can't be killed, the network layer is independent | Same, minus the DOM layer |
| Cost | Each element classified once, cached by URL | Continuous capture, driven by change |
| Maintenance | Site DOM churn + Windows capture churn | Windows churn only, and browser quality is lost |
| Distribution | Unlisted Web Store extension works on unmanaged PCs | Unsigned SYSTEM agent may trip Defender/SmartScreen heuristics |
| Privacy | Content stays local | Content stays local, but the agent sees every pixel, so no frame is ever saved |

App-only gives up the one thing no competitor offers, zero-frame safe-reveal, to avoid maintenance we would still be paying for. **The layered design wins.**

### C.2 Ownership

```
        ┌──── Network layer (service-owned): signed lists ▸ loopback DNS ▸ WFP ────┐
        └──────────▲──────────────────────────────────────────────▲───────────────┘
 ┌ Extension ──────┴───────────────┐   verdict summaries   ┌───────┴ Screen guard ──────────┐
 │ authoritative in managed        │◀── via the service ──▶│ authoritative outside them;    │
 │ browsers: DOM blur, DNR, words, │                       │ backstop inside ("obvious"     │
 │ feeds, SafeSearch               │                       │ rule only)                     │
 └──────────▲──────────────────────┘                       └───────▲────────────────────────┘
            └── native messaging ── Toolize.Service ── pipe ──────┘
                 authority · key · policy · supervisor · tamper judge
```

- **The service remains the only authority.**
- **Managed browsers are sampled only at the backstop rate.** Images the extension has already blurred are grey and low-detail, so the gate skips them.

### C.3 Cross-checks

| Signal | Meaning | Action |
|---|---|---|
| Browser window visible but no heartbeat from that browser, or an unknown browser | Extension disabled or crashed, or browser unmanaged | **Cover the window at once**; the watchdog's close stays as the escalation |
| Guard sees an obvious hit in a managed tab the extension reports clean | A miss, or tampering (CSS override, modified browser) | Cover; log a `DISAGREE` count; send the numbers to the verdict log for tuning |
| `GetWindowDisplayAffinity` ≠ `WDA_NONE` on a top-level window (readable from any process [GETAFF]) | WinHider-style hiding [WINHIDER], or a legitimate privacy app | Cover unless the publisher is allowlisted (allowlisting needs the key) |
| DDA reports `ProtectedContentMaskedOut` | DRM | Leave alone (settled policy) |
| A WGC sample of the foreground window shows content DDA doesn't | `WCA_EXCLUDED_FROM_DDA` trick [WCA] | Cover; log tampering |
| Guard heartbeat stops showing progress | Crash, or an admin killed it | Relaunch; log |

## D. Pitch

### D.1 Roadmap

| Phase | Deliverable | Exit gate | Size |
|---|---|---|---|
| **G0** (alongside systems phase 1) | User-level shadow guard: DDA, gate, proposals, safety-v3 + NSFWJS ONNX on Windows ML, numbers-only log. **Draws nothing.** Latency harness where a test glyph counts as flagged in dev builds, like `devOverride` | 2+ weeks on both machines: p50/p95 exposure, inferences/s, accelerator %, would-cover events/hour by app | S + calendar |
| **G1** | Region and window covers, SMTC, affinity detector, covers for silent browsers, game-safe profile | ≤1 unwarranted cover/hour (adult), 0 on UI chrome, anti-cheat matrix clean | M |
| **G2** | SYSTEM-token guard, restricted inference worker, job object, progress heartbeat, new tamper-checklist rows | A standard user can't kill or suspend it; relaunch <2 s | M |
| **G3** | Taxonomy heads v4 and the four presets, in both extension and guard | Per-level gates; no regression in NSFW recall or the drawn floor | M–L |
| **G4** | Screen-domain training (composites if approved, UI/game negatives), dense localization | Recall by size bucket; UI false positives/hour | L |
| **G5** | Cover-new mode for Kids/strict | p95 exposure ≤3 refreshes at 60 Hz | M |

**Biggest real-world gain first:**
- The systems member's service-owned lists plus DNS/WFP stop every app from reaching known adult sites.
- G0–G1 then cover what the network can't see: content inside allowed apps, downloaded files, VMs and remote sessions.

### D.2 Risks

| Risk | Mitigation |
|---|---|
| A false screen cover hurts more than a blurred thumbnail | Shadow mode first, the gate, regions before windows, an FP/hour gate, per-app exemptions (key) |
| Laptop GPU load and battery | Change-driven, NPU first, iGPU on hybrids, caps; degrade visibly, never switch off silently |
| **Anti-cheat.** Anti-cheats enumerate topmost windows, and a transparent same-size topmost window is the classic ESP pattern [OVERLAYAC]. BattlEye bans only for real cheats but may *kick* for some programs [BEFAQ]. Vanguard is the strictest, and reportedly broke OBS Game Capture in July 2026 [VGOBS] | No handles to game processes, injection, hooks or input. Documented capture APIs only, as OBS uses. While EAC, BattlEye, Vanguard or FACEIT runs, use an opaque normal window, never a transparent overlay. Test on throwaway accounts |
| SYSTEM process near untrusted pixels; an unsigned SYSTEM agent looks suspicious | Restricted worker sees tensors only; see question 1 |
| Tools that hide windows from capture | The C.3 detectors |
| Accessibility | Covers never take focus. "Image hidden" is announced via `UiaRaiseNotificationEvent` [UIANOTIFY]. Test Magnifier, colour filters, HDR and high contrast |
| Privacy perception | No frame is ever saved, logs hold numbers only, and the worker has no network |

### D.3 Success metrics

| Area | Target |
|---|---|
| Exposure, classify-then-cover | p95 ≤100 ms on dGPU/NPU, ≤150 ms on iGPU |
| Exposure, cover-new | ≤3 refreshes at 60 Hz |
| False covers | ≤1 unwarranted per hour (adult) over 20+ hours of mixed use; 0 on UI chrome |
| Recall | Composites ≥192 px within 2 pp of the extension's whole-image recall |
| Overhead on the iGPU laptop | ≤3% accelerator, ≤2% CPU on the desktop; ≤2% frame time in games |
| Reliability | 0 anti-cheat kicks; relaunch <2 s |

## Agreements and disagreements with round1-systems.md

**Agree:**
- keep the extension;
- DNS + WFP with no TLS man-in-the-middle;
- signed, service-owned list bundles;
- no IDD, injection or display filter drivers;
- no claim of zero unsafe frames;
- a separate process per session;
- cover before pause, and no blind input.

**Disagree or extend:**

1. **"A same-user helper can be killed."** Use a SYSTEM token in the user's session (A.10). Against a standard user, the only boundary the product claims, that gap closes.
2. **WGC first, DDA as fallback.** Reverse it for the always-on path: border consent, running under SYSTEM and pre-24H2 dirty rects all favour DDA (A.2).
3. **Whole-window covers before regional blur.** That misses a 150 px thumbnail at 1440p and covers an entire Discord window for one avatar, so users will switch it off. Region proposals need no new model, and dense heads reuse the backbone (B.3).
4. **Per-frame budgets.** Their 62–90 ms fits one detection, but capacity is planned in new regions per second (A.6). Planned that way, laptops are viable.
5. **Screen spike in phase 4.** Run G0 alongside phase 1 instead. It's small, and false-positive data needs weeks of real use.
6. **VMs, RDP and WSL as residual gaps.** When windowed they are just pixels on screen, and the guard covers them.
7. **Watchdog takes 210–230 s.** Cover the window as soon as the heartbeat is missing, and keep closing the browser as the escalation.
8. **Our overlay excluded from capture.** Agreed. Also detect *other* windows that exclude themselves.

## Notes on round1-redteam.md (read after drafting)

- **Agree.**
  - Keep the extension and move blocking into the service.
  - Their modesty tiers match B.1.
  - Before accepting kissing as an honest limit, measure a romance head (CLIP prompts + Commons labels) on video that isn't DRM-protected.
- **Adopt DWM acrylic as a cover style.** The compositor blurs live content under the overlay on every frame, so a covered video or a scrolling list stays blurred with no capture lag. Caveats:
  - `ACCENT_ENABLE_ACRYLICBLURBEHIND` is undocumented and build-sensitive.
  - Silhouettes must be tested; the extension needed 40 px blur plus grayscale.
  - With transparency effects off it falls back to a solid tint, which fails safe.
- **Challenge.**
  1. Foreground-only WGC at 2 fps misses background windows and second monitors, and adds up to 500 ms before inference starts.
  2. "~2 ms/frame" is a desktop-GPU figure. An iGPU needs 15–30 ms per region.
  3. No `VK_NEXT` auto-scroll: blind input can reveal worse content.
  4. Don't make the guard an opt-in P5. Start G0 now, and make it default-on per preset once G1's gates pass.

## Open questions for the other members

1. **User, red team — signing.** "Unsigned for now" is settled, but a SYSTEM agent drawing on the user's desktop is new information. Signing would cut Defender heuristics and unlock UIAccess's higher z-order band [UIACCESS]. Artifact Signing's individual validation covers only the US and Canada [ARTSIGN]. Revisit?
2. **User — composites.** Is compositing explicit training images in memory only, never written or shown, within the "never render" rule? B.2 and B.4 depend on the answer.
3. **Red team — exposure wording.** What wording about exposure is honest and acceptable, for Kids and for adults?
4. **User — revealing a cover.** Revealing one cover is weakening, so it needs the key. Is that tolerable for screen covers, or should adults get "report false cover", which logs numbers and keeps the cover?
5. **Red team — gender-selective blur.** HaramBlur-style blurring by gender [HARAMBLUR] is popular with modesty users. I lean out (misgendering, bias) and would offer "hide all people" instead.
6. **Systems — DDA under SYSTEM.** Does DDA work from a SYSTEM-token process on the 24H2 Default desktop across Intel, AMD and NVIDIA? Is `WCA_EXCLUDED_FROM_DDA` readable from another process?
7. **Systems — older builds.** The downloadable Windows ML providers need 24H2+. Is DirectML alone the floor for older builds?

## Sources

[POTTER]: https://pubmed.ncbi.nlm.nih.gov/24374558/
[HARMBLOCK]: https://safetonet.com/
[DUP]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput
[DDAHYBRID]: https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/error-when-dda-capable-app-is-against-gpu
[WCA]: https://learn.microsoft.com/en-us/windows/win32/dwm/windowcompositionattrib
[WGCBORDER]: https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired
[WGC24H2]: https://github.com/robmikh/Win32CaptureSample/issues/82
[SCC]: https://arxiv.org/abs/2305.05996
[OCLIP]: https://github.com/mlfoundations/open_clip/blob/main/docs/model_profile.csv
[WINML]: https://blogs.windows.com/windowsdeveloper/2025/09/23/windows-ml-is-generally-available/
[WINMLEP]: https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/supported-execution-providers
[AIHUB]: https://huggingface.co/qualcomm/ResNet50
[QUNS]: https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shqueryusernotificationstate
[SMTC]: https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager
[FSO]: https://devblogs.microsoft.com/directx/demystifying-full-screen-optimizations/
[RUSTDESK]: https://rustdesk.com/docs/en/client/windows/windows-portable-elevation/
[SESSIONS]: https://learn.microsoft.com/en-us/windows/win32/services/interactive-services
[PPL]: https://www.elastic.co/security-labs/sandboxing-antimalware-products
[SNORKEL]: https://arxiv.org/abs/1711.10160
[MASKCLIP]: https://arxiv.org/abs/2112.01071
[GETAFF]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowdisplayaffinity
[WINHIDER]: https://github.com/aamitn/winhider
[OVERLAYAC]: https://github.com/PierreCiholas/NotAnOverlay
[BEFAQ]: https://www.battleye.com/support/faq/
[VGOBS]: https://win.gg/obs-game-capture-not-working-valorant-league-of-legends-fix/
[UIANOTIFY]: https://learn.microsoft.com/en-us/windows/win32/api/uiautomationcoreapi/nf-uiautomationcoreapi-uiaraisenotificationevent
[ARTSIGN]: https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident
[UIACCESS]: https://dev.to/alia5/overlay-windowsstore-apps-uwp-without-code-signing-2h89
[HARAMBLUR]: https://github.com/alganzory/HaramBlur

Also consulted: [capture-bypass](https://github.com/londopy/capture-bypass), [SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity), [Riot's Vanguard ban-rate post](https://playvalorant.com/en-us/news/dev/vanguard-hits-new-bans-per-second-record/).
