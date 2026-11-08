/** Build-time DNR data; no queries, URLs or headers are stored at runtime.
 * Parameter evidence and intentionally omitted engines: ../../docs/search.md. */
export const SAFE_SEARCH_ENGINES = [
  { name: 'Google', host: '(www\\.)?google\\.[a-z.]+', path: '/(search|images|videos|imgres)(/[^?#]*)?', key: 'safe', value: 'active' },
  { name: 'Bing', host: '(www\\.)?bing\\.com', path: '/(search|images(/search)?|videos(/search)?)(/[^?#]*)?', key: 'adlt', value: 'strict' },
  { name: 'DuckDuckGo', host: '([a-z]+\\.)?duckduckgo\\.com', path: '/[^?#]*', key: 'kp', value: '1' },
  { name: 'Yahoo', host: '([a-z]+\\.)?search\\.yahoo\\.com', path: '/search/?', key: 'vm', value: 'r' },
  { name: 'Brave', host: 'search\\.brave\\.com', path: '/(search|images|videos|news)/?', key: 'safesearch', value: 'strict' },
  { name: 'Qwant', host: '(www\\.)?qwant\\.com', path: '/[^?#]*', key: 'safesearch', value: '2' },
  { name: 'Startpage', host: '(www\\.)?startpage\\.com', path: '/(sp/search|do/(dsearch|search|asearch|metasearch))/?', key: 'qadf', value: 'heavy' },
] as const;

/** RE2, without lookahead: all strings other than the exact given value. This lets
 * a corrective redirect beat the allow when someone supplies safe=active&safe=off. */
function otherValues(value: string): string[] {
  const alternatives = ['', ...Array.from({ length: value.length - 1 }, (_, i) => value.slice(0, i + 1))];
  for (let i = 0; i < value.length; i++) alternatives.push(`${value.slice(0, i)}[^${value[i]}&#][^&#]*`);
  alternatives.push(`${value}[^&#]+`);
  return alternatives;
}

export function safeSearchRules() {
  return SAFE_SEARCH_ENGINES.flatMap(({ host, path, key, value }, i) => {
    // Optional ports matter for local e2e, and for searches on non-default ports.
    const base = `^https?://${host}(:[0-9]+)?${path}`;
    const condition = { resourceTypes: ['main_frame', 'sub_frame'], isUrlFilterCaseSensitive: true };
    // Chrome replaces only the first duplicate unless the key is removed first.
    const redirect = { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [key], addOrReplaceParams: [{ key, value }] } } } };
    return [
      { id: i * 100 + 1, priority: 1, action: redirect, condition: { ...condition, regexFilter: `${base}(\\?|$)` } },
      // Match a complete query parameter, never its spelling inside another value
      // or a fragment. Already-correct requests load once, with no redirect loop.
      { id: i * 100 + 2, priority: 2, action: { type: 'allow' }, condition: { ...condition, regexFilter: `${base}\\?([^#]*&)?${key}=${value}(&|#|$)` } },
      // Separate alternatives stay under Chrome's 2 KB compiled-regex limit.
      ...otherValues(value).map((other, j) => ({
        id: i * 100 + 3 + j, priority: 3, action: redirect,
        condition: { ...condition, regexFilter: `${base}\\?([^#]*&)?${key}=${other}(&|#|$)` },
      })),
    ];
  });
}

export function youtubeRestrictRules(level: 'Moderate' | 'Strict') {
  return [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'YouTube-Restrict', operation: 'set', value: level }] },
    condition: {
      requestDomains: ['youtube.com', 'youtube-nocookie.com', 'youtubei.googleapis.com', 'youtube.googleapis.com'],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'],
    },
  }];
}
