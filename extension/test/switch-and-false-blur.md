# Master switch and false-blur regressions

These cases assert the behavior specified in `CLAUDE.md`. Existing product bugs stay
red; there are no expected-failure annotations or weakened assertions. Product code
is unchanged.

## Run

From `extension/`, in PowerShell:

```powershell
npm ci
node build.mjs --dev
$env:TZ_TEST_PORT = '18877'
$env:TEST_FILTER = '^(A|B)[0-9]'
node test/e2e.mjs
$env:NO_GPU = '1'
node test/e2e.mjs
```

`TEST_FILTER` is a regex on the case names below. For example,
`^B1-single-mild-paused-seek$` runs just the paused-frame regression. `legacy` selects
the original sequential suite as a single group. With no filter, both groups run.
The model cold-start check runs regardless of filter. A filter matching no group
fails instead of reporting a misleading success.

`TZ_TEST_PORT` reserves that port and the next port for the second origin. The
harness waits for its own server to bind both ports and reports a port collision.
The server also substitutes those ports in the original HTML/JS fixtures, so their
cross-origin images, srcdoc and video paths still work. Standalone `serve-test.mjs`
continues to accept `PORT`.

The harness uses `isolatedDist()` to remove the native messaging permission from a
temporary copy. The installed service therefore cannot overwrite test settings.
Every regression resets the complete settings object, clears learned sites, and
uses a fresh page. `tube8.com` (a static-list seed) and `switch-porn.test` (hostname
regex) resolve to the local server; no adult site is contacted.

The fixtures record their own synthetic WebM clips. Their finite duration is resolved
before insertion so the pause tests exercise VOD rather than accidentally exercising
the live-stream exemption. Clean media carries an explicit `__tz_test_clean` tag;
after the single mild override, subsequent frames are deterministic clean frames.

Race tests install a response gate on the existing content-world classification
transport through `chrome.scripting.executeScript`. The real classifier produces the
response, then the gate holds its delivery until the test has observed `off`. It
does not fabricate scores or change watcher state or decisions. Mutation histories
catch even temporary re-stamping after release. Visibility tests override
`document.hidden` in the isolated content world, because a page-world override does
not reach that world's `Document` wrapper.

Machine-readable results include every assertion and actual state in
`test/.artifacts/switch-and-false-blur-{gpu,no-gpu}-<run-id>.json`. Each invocation
returns nonzero if any assertion fails. Cases have a 45-second outer deadline.

## Results (2026-11-07)

Regular Chromium and `NO_GPU=1` have the same final results: **16 passing cases,
9 failing cases** (10 failing assertions, because A1 checks two hosts). All 25 cases
were exercised in regular Chromium across the initial run and focused recheck; the
WASM run exercised all 25 in one invocation. The legacy suite was not run.
`node build.mjs --dev`, JS syntax checks, `git diff --check`, and a direct smoke check
of the original fixtures on custom ports also completed successfully.

| Case / exact `TEST_FILTER` name | Result | Coverage / diagnosis |
| --- | --- | --- |
| `A1-static-and-regex-master-switch` | FAIL | Static and hostname rules still block while disabled; D1. Re-enable controls pass. |
| `A2-learned-master-switch` | FAIL | Learned site still blocked while disabled; D2. Re-enable control passes. |
| `A3-words-master-switch` | PASS | Default words in URL/title and YouTube tiles are ignored while off. Tile hiding returns on re-enable. |
| `A4-youtube-feeds-bots-shorts-master-switch` | PASS | Feed/comment elements shown, bot style disconnected, markers removed, avatars/links restored, Shorts URL retained while off. |
| `A5-open-page-disable-reenable` | PASS | All images/videos become shown `off`, blocked backgrounds restored, flagged VOD can play, clean media returns to clean without reload. |
| `A5-reenable-pending-video-without-reload` | FAIL | Pending video never resumes classification after re-enable; D3. |
| `A5-inflight-image-after-disable` | PASS | Slow image, real transient failure, successful retry held in flight: late result respects off; re-enable returns clean. |
| `A5-inflight-video-after-disable` | FAIL | Late flagged frame overwrites off and pauses playback; D4. |
| `A5-inflight-poster-after-disable` | FAIL | Late poster result re-blurs while off; D5. |
| `A5-inflight-background-error-after-disable` | FAIL | Late transient failure hides background while off; D6. |
| `A6-iframe-inflight-image-after-disable` | PASS | Same-origin `frame.html` image result respects off. |
| `A6-iframe-inflight-video-after-disable` | FAIL | Same-origin `frame.html` video result overwrites off and pauses playback; D4. |
| `B1-single-mild-playing` | PASS | Exactly one non-obvious flagged frame cannot blur a video already shown clean. |
| `B1-single-mild-paused-seek` | FAIL | A shown video blurs on one mild seeked still; D7. |
| `B2-obvious-vod-paused` | PASS | One obviously explicit frame blurs and pauses finite VOD. |
| `B2-obvious-youtube-never-paused` | PASS | Explicit video blurs with zero pause events on `youtube.test`. |
| `B3-image-transient-failure-recovers` | PASS | Actual first classify failure followed by automatic retry ends clean, not error. |
| `B4-idle-video-posters` | PASS | Never-played clean poster reveals; flagged poster remains blurred. |
| `B5-image-src-swaps-both-directions` | PASS | Flagged-to-clean and clean-to-flagged src swaps go through pending to the correct verdict. |
| `B5-inflight-src-swap-flag-to-clean` | PASS | Late old flagged verdict cannot overwrite a new clean image. |
| `B5-inflight-src-swap-clean-to-flag` | PASS | Late old clean verdict cannot reveal a new flagged image. |
| `B6-tiny-video-settles` | FAIL | Intrinsic 32px video stays pending beyond five seconds; D8. |
| `B6-paused-hover-preview-settles` | PASS | Normal-size, never-played paused preview gets a verdict within five seconds. |
| `B7-hidden-pending-video-recovers-on-visible` | PASS | Actually pending while hidden, then clean within five seconds of visibility returning. |
| `B8-trusted-youtube-thumbnail-and-video` | PASS | `/@Trusted` tile and `data-tz-author="Trusted"` video stay skip despite flag tags; untrusted controls block. |

## Failing assertions and product diagnoses

Paths and line numbers refer to product code under `extension/`.

| ID | Failing assertion / observed result | Diagnosis |
| --- | --- | --- |
| D1 | With `enabled:false`, expected local URL for both `tube8.com` and `switch-porn.test`; actual `/blocked/blocked.html`. | `src/background/index.ts:186` computes whether the static adult ruleset is wanted using only `blockAdultSites`. It ignores the master switch. This ruleset includes the hostname regex rules too. |
| D2 | Learned site should load normally while off; actual `/blocked/blocked.html?reason=images&site=switch-learn.test`. | `src/background/blocklist.ts:69` likewise checks only `blockAdultSites`; `syncDynamicRules()` keeps learned redirect rules installed at line 79. |
| D3 | Expected `clean` within five seconds of re-enabling a pending video; actual `pending`, blurred, still playing. | `src/content/video.ts:135` deletes disabled videos from `candidates`. For an existing same-source track, re-enable only restores the old/pending state at line 151. Observation is only started for a new track at line 145, so a stationary visible video gets no new intersection event to re-add it. |
| D4 | After disable and response release, expected shown `off` and playing, with no non-off transitions; actual `blocked`, `blur(40px) grayscale(1)`, `paused:true` in both the top frame and iframe. | `src/content/video.ts:253` checks track identity after awaiting a frame, but never checks whether protection is still enabled. `setVerdict()` at line 384 guards exemptions only; it stamps at line 387 and pauses at line 390 even after disable. |
| D5 | Poster response released after observing off should leave off; actual `blocked` with blur. | `src/content/video.ts:189` checks track identity only after awaiting the poster. Line 191 stamps blocked without checking `settings.enabled`. |
| D6 | A background failure released while off should leave `data-tz-bg` absent and background visible; actual `data-tz-bg="blocked"`, `background-image:none`. | `src/content/backgrounds.ts:150` unconditionally calls `hide()` in the catch path. The success path's enabled guard at line 142 has no equivalent here. |
| D7 | A shown video's single mild seeked still must stay clean; actual `blocked` with blur, with a recorded clean-to-blocked transition. | `src/content/video.ts:355`, `recordStill()`, includes unconditional `frame === 'flagged'` in its blur rule. `shown` only protects doubtful frames. This conflicts with `CLAUDE.md`'s two-of-last-three-or-obvious rule for a video already shown clean; the playing counterpart passes. |
| D8 | Tiny never-played video must reach skip/clean/a real blocked verdict in five seconds; actual `pending`, readyState 4, intrinsic width 32. | `src/content/video.ts:146` stamps pending on discovery, but `tick()` filters intrinsic dimensions below 64 at line 212 without assigning skip or any other terminal state. |
