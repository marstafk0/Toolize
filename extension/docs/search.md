# Search filtering

`wordFilter` checks extracted URL queries before checking whole words in the page's
address/title. The generic query keys are `q`, `query`, `search`, `search_query`,
`keyword`, `keywords`, and `term`; Yahoo's `p`, Yandex's `text`, Baidu's `wd` and the
search/tag paths on Tumblr, Pixiv, Giphy, Tenor and Instagram are also understood.
Amazon's shopping `k` is omitted. All duplicate query values are checked. Each frame
is checked, and the 300 ms URL/title poll covers history-based SPA navigation.

The expanded built-in list matches whole words. A separate strong list matches
substrings only in extracted queries after Unicode/lookalike/leet folding and
removal of spacing/punctuation. Numeric names (`r34`, `rule34`, `e621`) are checked
before lossy digit folding so ordinary words such as “reading” and “their” survive.
Short ambiguous words (`sex`, `anal`, `cum`, `ass`, `tit`) never become substring
patterns. Matches go to `reason=search`, with no query retained in that URL or logs.

`safeSearch: boolean` defaults to `true`. Independent of `wordFilter`, it enables
the static `safesearch` DNR ruleset. `youtubeRestrict: 'off' | 'moderate' | 'strict'`
defaults to `'off'`; exactly one of `youtube-moderate` and `youtube-strict` is enabled
when requested. `enabled: false` disables all these rulesets. The companion remains
the authority for settings changes: disabling SafeSearch or lowering Restricted Mode
is weakening and requires its key, as with the other protection controls.

## SafeSearch parameter evidence

Reviewed 2026-11-07. Only URL schemes with evidence are generated in
`src/background/search-rules.ts`; engine behavior can change independently of us.

| Engine | Forced URL parameter | Evidence |
| --- | --- | --- |
| Google (country domains) | `safe=active` | Google's public `/search?q=cats&safe=active` scheme preserves this value. [Google SafeSearch help](https://support.google.com/websearch/answer/186669?hl=en) describes the filter and its limits. |
| Bing | `adlt=strict` | [SearXNG's current Bing integration](https://github.com/searxng/searxng/blob/master/searx/engines/bing.py) sends this query parameter and maps strict to the strongest setting. |
| DuckDuckGo | `kp=1` | [Official URL parameter reference](https://duckduckgo.com/duckduckgo-help-pages/settings/params) lists `1` as On, `-1` Moderate, `-2` Off. Includes HTML/lite subdomains. |
| Yahoo | `vm=r` | [Current Yahoo integration](https://github.com/searxng/searxng/blob/master/searx/engines/yahoo.py) maps strongest filtering to `r`. Includes regional `*.search.yahoo.com` hosts. |
| Brave Search | `safesearch=strict` | A benign `/search?q=cats&safesearch=strict` response initializes its settings with `safesearch:"strict"`. [Official Safe Search help](https://search.brave.com/help/safesearch) defines Strict. |
| Qwant | `safesearch=2` | A benign `/?q=cats&safesearch=2` response reads this into `urlParams`; [current integration](https://github.com/searxng/searxng/blob/master/searx/engines/qwant.py) forwards the same numeric strictness to its search API. |
| Startpage | `qadf=heavy` | [Current Startpage integration](https://github.com/searxng/searxng/blob/master/searx/engines/startpage.py) maps strongest filtering to `heavy` and sends `qadf` with the search. Covers `/sp/search` and legacy `/do/*search` endpoints. |

Omitted from network rewriting:

- **Ecosia:** could not confirm `safesearch=2`; the results endpoint returned a
  challenge. Its [official enforcement guide](https://support.ecosia.org/article/562-how-to-enforce-safe-search-at-your-organization)
  documents a DNS CNAME to `strict-safe-search.ecosia.org`, rather than a URL value.
- **Yandex:** could not confirm `family=yes`; help URLs returned 404 and the search
  endpoint returned a CAPTCHA. Query extraction with `text` still works.
- **Baidu:** no verified URL enforcement parameter; `wd` queries still get word checks.

Rules redirect main/sub-frame searches with `queryTransform.addOrReplaceParams`.
A higher-priority RE2 allow matches a complete, already-correct query parameter to
stop loops. A corrective redirect beats that allow if a conflicting duplicate
parameter is present. It removes every existing copy before adding the enforced
value, since Chrome otherwise replaces only the first duplicate. Alternatives use
separate small regex rules to stay below Chrome's 2 KB compiled-regex limit.
All adult-list/hostname/learned rules have higher priorities,
so an already-safe URL cannot bypass site blocking. Tests run actual requests
through Chrome, including duplicate parameters and adult-host rule precedence.

## YouTube headers and limits

[Google's network configuration documentation](https://support.google.com/a/answer/6214622?hl=en)
specifies `YouTube-Restrict: Moderate` and `YouTube-Restrict: Strict`. The generated
header rules cover main frames, subframes and XHR/fetch on `youtube.com`,
`youtube-nocookie.com`, `youtubei.googleapis.com`, and `youtube.googleapis.com`.

These are the engines' own filters, whose classification and coverage we cannot
control. Google SafeSearch in particular is Google's filter, not Toolize's image
detector. Unknown vocabulary, languages and search schemes can evade word checks;
POST-only queries that are absent from URLs cannot be inspected by this URL guard
(Startpage offers POST in its settings). Search inputs and other applications are
not monitored. Queries are processed locally and never stored or transmitted by
Toolize; ordinary searches still go to the engine chosen by the user.
