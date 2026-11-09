# Search vocabulary audit

Audited all 54 original `STRONG_QUERY_WORDS` entries against these public lists on
2026-11-08. Downloads and audit scripts are in ignored `extension/.cache/search-audit/`.

- [dwyl words_alpha.txt](https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt): 370,105 entries.
- [Google 20,000 English words](https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt): 20,000 entries.

Counts below exclude the exact term, include plurals/derivatives, and are substring
counts, not counts of innocent words. The dictionary includes rare/archaic words;
the common list also contains sexual queries, names and sites. Decisions use the
actual matching words, rather than treating every dictionary collision as innocent.

| Term | Dictionary / common hits | Decision and evidence |
| --- | --- | --- |
| porn | 23 / 4 | Keep substring: mostly pornography derivatives. Rare collisions include agapornis, epornitic, nonporness and unporness; no common innocent collision. |
| nude | 17 / 1 | Whole-word context: denude, denuded, denudement, denuder, denudes, undenuded. |
| nudes | 2 / 0 | Whole-word context: denudes, nudest. |
| naked | 11 / 0 | Whole-word context: snaked, nakedweed, nakedwood, plus polysemous phrases. |
| tits | 4 / 0 | Whole-word context: petits, bushtits, squawtits, tomtits. Not in constituents. |
| pussy | 9 / 1 | Whole-word context: pussycat(s), pussyfoot(ed/er/ing/ism/s), pussytoe. |
| milf | 2 / 4 | Whole-word: milfoil(s), Milford; retain explicit milf compounds. |
| ecchi | 11 / 0 | Whole-word: becchi, cecchine, libecchio, orecchion, secchio, specchie, zecchin(i/o/os/s); also orecchiette and Vecchio in the clean corpus. |
| lewd | 9 / 0 | Keep substring: all extensions retain the sexual meaning (lewder, lewdest, lewdly, lewdness(es), lewdster, overlewd(ly/ness)). No clewd entry. |
| hooker | 5 / 0 | Require sexual phrase: backhooker, hookera, hookerman, hookers, pothookery; many ordinary names, tools and occupations. |
| dildo | 3 / 1 | Whole-word context: dildoe(s), dildos; Dildo Island is an ordinary place. |
| xxx | 0 / 1 | Whole-word context: xxxx is the only listed extension; Roman numerals cause ordinary phrase collisions. |
| rule34, r34, e621 | 0 / 0 each | Exact numeric names/internal hyphen or underscore; `rule 34` is an explicit phrase. Never suffix-match chapter 34/page 621. Cars/additives have context rules. |
| blowjob | 1 / 1 | Keep substring: blowjobs. |
| handjob | 0 / 1 | Keep substring: handjobs. |
| cumshot | 0 / 1 | Keep substring: cumshots. |
| hentai, nsfw, boobs, titties, boobies, creampie, onlyfans, ahegao, futanari, doujin, gangbang, bdsm, nhentai, xvideos, pornhub, xnxx, xhamster, brazzers, chaturbate, yiff, lolicon, shotacon, paizuri, bakunyuu, bukkake, deepthroat, spankbang, redtube, youporn, bangbros, fapello, thothub, gelbooru, danbooru, femdom, fleshlight | 0 / 0 each | Keep within-token substring matching. |

Also checked `futa` (30 / 0: confutation/refutation and derivatives) and `shota`
(0 / 0). Both were already whole-word only and remain so. `futatsu` and `shotai`
stay clean; Shota Imanaga/Rustaveli and FUTA tax have ordinary-context rules.

Removed from unrestricted substring matching: **nude, nudes, naked, tits, pussy,
milf, ecchi, xxx, hooker, dildo, rule34, r34, e621**. Explicit compound patterns retain
`bigtitsgirls`, `nudesleaked`, `nakedgirls`, `hotmilf`, `milfhunter` and `ecchivideos`.

Built-in context patterns retain sexual uses of cum, cleavage, bondage, nipples,
areolas, stripper, escort, vibrator, naked/nude, tits, FUTA, numeric ratings, XXX,
NTR, Shota, anal, sex/sexual, body paint, sugar baby and bikini. Additional clean
corpus contexts cover smut, horny, whore, orgy, threesome, pussy, playboy and Dildo.
Standalone hooker requires a sexual phrase; generic see-through, steam, bed scene
and kiss scene entries were removed because their everyday uses dominate.

The clean corpus is unchanged: **142/310 false positives before, 0/310 after**.
The new explicit corpus catches **230/230 before and after**. Additional regressions
cover 49 clean edge cases, local exceptions, URL IDs, literal user extras and bot
heuristics. The sole changed search-lockdown expectation is `freeR34art`: embedded
numeric names are now clean, with `r-34 art` replacing it as the blocked example.

## Validation

- `node test/search-false-positives.mjs`: 310 clean, 0 false positives. Only diagnostics changed; the independent clean-query list is untouched.
- `node test/search-blocked.mjs`: 230/230 blocked (also 230/230 on the original implementation).
- `node test/search-regressions.mjs`: passed (49 additional clean cases, local contexts, URL values, custom words/regexes, built-in regex compilation and unchanged bot heuristics).
- `node test/blocklist-concurrency.mjs`: passed (concurrent learns/removals, delayed and denied authorization, queued disable and serialized DNR writes).
- `node test/search-lockdown.mjs`: module loads; its browser assertions run through e2e below.
- `npm run typecheck` and `node build.mjs --dev`: passed.
- Full `TZ_TEST_PORT=18277 node test/e2e.mjs`, run once: 336 passed, 2 failed. Both failures were newly added Google root-path assertions that ignored the fixture server's subsequent `/` to `/pages/index.html` redirect. All other checks passed.
- Corrected the new assertions to inspect the DNR redirect hop before the fixture redirect. Rebuilt, then ran `TZ_TEST_PORT=18277 TEST_FILTER=search node test/e2e.mjs`: **57 passed, 0 failed**, including both corrected checks and additional query/title/opaque-ID regressions. The full suite was not repeated.
