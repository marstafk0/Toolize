/** Search words only. URLSearchParams decodes percent escapes and + once; path
 * queries need their own decoding. Never pass a whole URL to the strong matcher. */
const GENERIC_PARAMS = ['q', 'query', 'search', 'search_query', 'keyword', 'keywords', 'term'];

const on = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const countryHost = (host: string, name: string): boolean =>
  new RegExp(`^(?:www\\.)?${name}\\.[a-z.]+$`).test(host);

function pathQuery(path: string, pattern: RegExp): string | null {
  const encoded = pattern.exec(path)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded.replace(/\+/g, ' '));
  } catch {
    return encoded;
  }
}

/** All query values, including duplicate keys: an engine may use the first or last. */
export function searchQueries(href: string): string[] {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
  const host = url.hostname;
  const path = url.pathname;
  // Shopping's k parameter is intentionally not treated as a general search.
  const keys = new Set(GENERIC_PARAMS);
  if (on(host, 'search.yahoo.com')) keys.add('p');
  if (countryHost(host, 'yandex')) keys.add('text');
  if (on(host, 'baidu.com')) keys.add('wd');
  // Google, Bing, DDG, Brave, Ecosia, Startpage, Qwant, YouTube, Reddit, X/Twitter,
  // Pinterest, DeviantArt, Imgur and TikTok use the generic keys above. This also
  // covers unfamiliar engines, custom search boxes and their mobile subdomains.
  const queries = [...keys].flatMap((key) => url.searchParams.getAll(key)).filter(Boolean);
  const paths: [string, RegExp][] = [
    ['tumblr.com', /^\/search\/([^/]+)/],
    ['pixiv.net', /^\/(?:[a-z]{2}\/)?tags\/([^/]+)/],
    ['giphy.com', /^\/search\/([^/]+)/],
    ['tenor.com', /^\/search\/([^/]+)/],
    ['instagram.com', /^\/explore\/tags\/([^/]+)/],
  ];
  for (const [domain, pattern] of paths) {
    if (!on(host, domain)) continue;
    const query = pathQuery(path, pattern);
    if (query) queries.push(query);
  }
  return queries;
}
