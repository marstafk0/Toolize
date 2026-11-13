# Toolize 2.0 — the council's pitch

Council: Codex gpt-6.1-sol (systems), Gemini 4 Argon (red team / market), Claude Opus 5.5
(architect / ML). Two rounds each; sources and evidence in `round1-*.md` and `round2-*.md`.

## The answer to "extension + app, or app only?"

**Keep both, but flip who's in charge.** All three members converged on this independently.

- The **extension** is the only thing that can blur an image *before it is ever drawn*
  (0 frames shown). Anything that works on the screen reacts after pixels appear: at best
  2–3 frames (~30–50 ms), realistically 3–9. People recognise a picture in 13 ms. So an
  app-only design is strictly worse inside the browser, where most exposure happens.
- The **app (service)** becomes the authority for everything that must not depend on the
  extension: the site lists, DNS, the firewall, SafeSearch, and watching every window on
  screen — browsers it doesn't manage, Discord, Telegram, image viewers, games.
- They **check each other**. The extension is a sensor the service verifies; the screen
  guard watches for a browser whose extension has gone quiet, and for explicit pixels in a
  tab the extension called clean.

```
                ┌──────────────────────── Toolize.Service (SYSTEM) ─────────────────────────┐
                │ settings · lock/USB key · signed list updates · loopback DNS · WFP firewall │
                │ browser policies · watchdog · launches + supervises the Guard per session   │
                └───────┬──────────────────────┬───────────────────────────┬────────────────┘
          pipe (PID-verified)            per-session launch           DNS :53 / WFP
                │                              │                           │
      NativeHost ⇄ Extension         Toolize.Guard (user, locked ACL)   every app's traffic
      in-page blur before paint      screen change → detect → cover      blocked/forced safe
      search/feeds/words             covers unmanaged browsers, apps     DoH/DoT/IPv6 closed
```

## Ranked build plan

| # | Milestone | What it closes | Effort |
|---|---|---|---|
| **M1** | **"No unprotected browser, no fake host"** (2 weeks): policies `NativeMessagingUserLevelHosts=0`, `NativeHostsExecutablesLaunchDirectly=1`, `DnsOverHttpsMode=off`, internal-page blocklist; pipe verifies the caller is the real native host launched by a real browser (PID chain); watchdog identifies browsers by binary identity, not name; new **Cover** level (opaque cover over any unmanaged/silent browser within 1 s, close after 60 s); fail-closed overlay fixes (future-timestamp fail-open, removable overlay, 10 min → 90 s, DNR navigation shield); extension tamper fixes (forged takeover event, faked DRM signal); video scene-change re-check | Renamed/portable browsers, fake heartbeats, per-user fake native host, DoH, browser-side kill of the overlay, ~5 s video gap | M |
| **M2** | **Network moves into the service**: service downloads signed, versioned lists (OISD/Hagezi), keeps last-known-good, serves a loopback DNS resolver for the whole PC; persistent WFP rules block other DNS (53/853), known DoH endpoints, IPv6 escape; SafeSearch forced at DNS too (CNAMEs) on top of the browser rules | Every non-browser app, other browsers, apps' own DoH, extension disabled | M–L |
| **M3** | **Screen guard, shadow mode**: captures changes only (DDA for the whole screen, WGC to re-check covered windows), runs safety-v3 on the NPU/GPU via Windows ML, logs numbers only — no covers yet. Measures exposure, false covers/hour, battery, game frame-time on both machines | Gives the data to switch covers on safely | M |
| **M4** | **Screen guard live**: region covers (DWM acrylic or opaque), whole-window fallback, pause media for fullscreen/DRM, follows virtual desktops, never touches anti-cheat game processes (opaque normal window instead), password managers and Zoom/Teams allow-listed | Native apps, image viewers, games' menus, Discord/Telegram media | L |
| **M5** | **Hardening for knowledgeable users**: Tier B FIDO2/YubiKey (uncopyable), optional **weakening delay** (key + e.g. 24 h) for people who hold their own key, service-permission lockdown, schedules/curfew, `doctor` hardening checklist (standard daily account, partner holds admin, BitLocker, Secure Boot, BIOS password + boot order) | Admin-in-the-moment bypasses, cloned keys, 2 a.m. impulses | M |
| **M6** | **Modesty taxonomy models**: explicit / nudity / underwear-swim / revealing / suggestive / romance, with Kids, Teen, Adult-modest, Explicit-only presets; screen-specific training (games, anime, ads) | Fine control per family member; fewer false blurs | L |

## What it will and won't stop — honestly

- **Stops (once M1–M4 ship):** other browsers, renamed/portable browsers, disabled
  extension, apps' built-in DoH, DNS tricks, most VPN/proxy *apps* via WFP, explicit
  images in native apps (after a few frames), SafeSearch-off domains, fake heartbeats.
- **Still can't stop:** a local administrator (the account model is the real lock — the
  app will guide and verify it), booting another OS from USB (BIOS password + boot order +
  BitLocker), a second device, an arbitrary encrypted tunnel disguised as HTTPS, and
  zero-frame exposure outside the browser. The UI must say this plainly.
- **Never:** TLS interception, uploading screenshots, cloud inference. Logs stay
  numbers-only.

## Real bugs the council found in today's code (go into M1)

- Watchdog matches 8 process names → renaming `firefox.exe` evades it; default is Warn only.
- Fail-closed overlay: a future `lastSeen` timestamp fails open; the overlay can be removed
  from the page; 10-minute grace.
- Any process can send counterfeit `extension-heartbeat` over the pipe.
- A standard user can register an HKCU native host that Chrome prefers over ours.
- A page can forge the takeover event or fake the DRM signal to stand the engine down.
- Video sampling backs off to 4 s once clean with no scene-change reset (~4–5 s gap).

## Decisions only you can make

1. **Training composites in memory only** (never saved or shown) — needed to train and
   measure screen-region detection. Council: **yes, with guardrails** (no image writer in
   the code, independent reproduction).
2. **Code signing** — still unsigned? Council: **not yet**; revisit if Defender flags the
   guard or covers lose z-order.
3. **Revealing a screen cover** — Council: **needs the key**; adults get "report false
   cover" (numbers only) and "trust this app" (key). Gemini wanted a rate-limited keyless
   dismiss for non-explicit covers on adult accounts; Claude and Codex rejected it as a
   one-click bypass.
4. **Default watchdog for new enforced setups**: **Cover** (council) rather than Close.
5. **Weakening delay** (key + 24 h) for solo adults — optional, opt-in.
