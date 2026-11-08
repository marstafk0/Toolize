import * as esbuild from 'esbuild';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/** Run by e2e.mjs, or TEST_FILTER=search node test/e2e.mjs. All hosts are local. */
export async function runSearchLockdown({ context, sw, setSettings, waitFor, check, root, dist, port }) {
  const bundled = await esbuild.build({
    stdin: { contents: "export * from './src/shared/words'; export * from './src/shared/search';", resolveDir: root },
    bundle: true, format: 'esm', write: false, define: { __DEV__: 'false' }, logLevel: 'silent',
  });
  const { searchQueries, buildMatcher, DEFAULT_WORDS, matchesWords, matchesStrongQuery } =
    await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const re = buildMatcher(DEFAULT_WORDS);
  const explicit = ['blowjob', 'masturbation', 'masturbating', 'jerking off', 'jerk-off', 'nipples', 'areola',
    'doujinshi', 'ahegao', 'futa', 'shota', 'r-18', 'rule 34', 'foot fetish', 'strap-on', 'sugar baby',
    'p0rn', 'pr0n', 'h3ntai', 's3x', 'ｈｅｎｔａｉ', 'hеntаi'];
  check('search: expanded vocabulary, stems, Unicode and common leetspeak match', explicit.every((q) => matchesWords(re, q)));
  const strong = ['freep0rnvideos', 'bigtitsgirls', 'h 3 n t a i', 'only.f4ns', 'freeR34art', 'e 6 2 1 gallery'];
  check('search: concatenated, spaced-out and numeric strong terms match', strong.every(matchesStrongQuery));
  const ordinary = ['sussex university', 'essex analysis', 'middlesex', 'classic analysis curriculum',
    'reading their height', 'hot tentacle facial hardcore yuri', 'Bikini Bottom'];
  check('search: ordinary words keep their boundaries after folding', ordinary.every((q) => !matchesWords(re, q) && !matchesStrongQuery(q)));
  check('search: strong substrings do not apply to page titles or whole addresses',
    !matchesWords(re, 'bigtitsgirls') && !matchesWords(re, 'https://freehentaigallery.test/about'));

  const addresses = [
    'https://www.google.co.uk/search?q=needle', 'https://www.google.com/images?q=needle',
    'https://www.google.com/videos?q=needle', 'https://www.bing.com/images/search?q=needle',
    'https://www.bing.com/videos/search?q=needle', 'https://duckduckgo.com/?q=needle',
    'https://uk.search.yahoo.com/search?p=needle', 'https://yandex.ru/search/?text=needle',
    'https://search.brave.com/search?q=needle', 'https://www.ecosia.org/search?q=needle',
    'https://www.startpage.com/sp/search?query=needle', 'https://www.qwant.com/?q=needle',
    'https://www.baidu.com/s?wd=needle', 'https://www.youtube.com/results?search_query=needle',
    'https://www.reddit.com/search?q=needle', 'https://x.com/search?q=needle', 'https://twitter.com/search?q=needle',
    'https://www.pinterest.co.uk/search/pins/?q=needle', 'https://www.tumblr.com/search/needle',
    'https://www.deviantart.com/search?q=needle', 'https://www.pixiv.net/en/tags/needle/artworks',
    'https://giphy.com/search/needle', 'https://tenor.com/search/needle', 'https://imgur.com/search?q=needle',
    'https://www.tiktok.com/search?q=needle', 'https://www.instagram.com/explore/tags/needle/',
    ...['q', 'query', 'search', 'search_query', 'keyword', 'keywords', 'term'].map((key) => `https://unknown.test/find?${key}=needle`),
  ];
  check('search: engines, social sites, path queries and generic search keys are extracted',
    addresses.every((url) => searchQueries(url).includes('needle')));
  check('search: duplicate query keys and URL decoding are preserved; shopping k and malformed URLs are skipped',
    JSON.stringify(searchQueries('https://example.test/?q=cats&q=p%30rn+clips')) === '["cats","p0rn clips"]' &&
    searchQueries('https://tumblr.com/search/h%203%20n%20t%20a%20i')[0] === 'h 3 n t a i' &&
    !searchQueries('https://amazon.com/s?k=needle').length && !searchQueries('not a URL').length);

  const rules = JSON.parse(readFileSync(join(dist, 'rules/safesearch.json'), 'utf8'));
  const engineSchemes = [
    ['https://www.google.co.uk/images?q=cats', 'safe', 'active'],
    ['https://bing.com/videos/search?q=cats', 'adlt', 'strict'],
    ['https://html.duckduckgo.com/html/?q=cats', 'kp', '1'],
    ['https://uk.search.yahoo.com/search?p=cats', 'vm', 'r'],
    ['https://search.brave.com/images?q=cats', 'safesearch', 'strict'],
    ['https://www.qwant.com/?q=cats', 'safesearch', '2'],
    ['https://www.startpage.com/sp/search?query=cats', 'qadf', 'heavy'],
    ['https://www.startpage.com/do/dsearch?query=cats', 'qadf', 'heavy'],
  ];
  check('search: every confirmed engine has a matching rewrite and exact-parameter loop guard', engineSchemes.every(([url, key, value]) => {
    const redirect = rules.find((r) => r.priority === 1 && new RegExp(r.condition.regexFilter).test(url));
    const allow = rules.find((r) => r.action.type === 'allow' && new RegExp(r.condition.regexFilter).test(`${url}&${key}=${value}`));
    return redirect?.action.redirect.transform.queryTransform.addOrReplaceParams.some((p) => p.key === key && p.value === value) &&
      allow && !new RegExp(allow.condition.regexFilter).test(`${url}#${key}=${value}`) &&
      !new RegExp(allow.condition.regexFilter).test(`${url}&other=${key}=${value}`);
  }));
  const unsupported = await sw.evaluate(async (rules) => {
    const wrong = [];
    for (const rule of rules) {
      const result = await chrome.declarativeNetRequest.isRegexSupported({ regex: rule.condition.regexFilter, isCaseSensitive: true });
      if (!result.isSupported) wrong.push(`${rule.id}: ${result.reason}`);
    }
    return wrong;
  }, rules);
  check('search: Chrome supports every SafeSearch RE2 regex', !unsupported.length, unsupported.join(', '));

  const sync = async (patch, expected) => {
    await setSettings(patch);
    const ready = await waitFor(async () => sw.evaluate(async (wanted) => {
      const ids = await chrome.declarativeNetRequest.getEnabledRulesets();
      return ['safesearch', 'youtube-moderate', 'youtube-strict'].every((id) => ids.includes(id) === wanted.includes(id));
    }, expected), { timeout: 5000, interval: 50 });
    if (!ready) throw new Error('search rulesets did not synchronize');
  };
  await sync({ enabled: true, blockAdultSites: true, wordFilter: true, safeSearch: true, youtubeRestrict: 'off', blockedWords: [], feeds: {} }, ['safesearch']);
  const page = await context.newPage();
  const engines = [ ['www.google.com', 'safe', 'active'], ['www.bing.com', 'adlt', 'strict'], ['duckduckgo.com', 'kp', '1'] ];
  const go = async (url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch((e) => {
      if (!/ERR_ABORTED|interrupted by another navigation/.test(e.message)) throw e;
    });
    await page.waitForTimeout(650); // > two URL/title guard ticks, including SPA changes
  };
  for (const [host, key, value] of engines) {
    const origin = `http://${host}:${port}/search`;
    const response = await page.goto(`${origin}?q=cats`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const landed = new URL(page.url());
    let request = response?.request();
    let redirects = 0;
    while (request?.redirectedFrom()) { redirects++; request = request.redirectedFrom(); }
    await page.waitForTimeout(650);
    check(`search: ${host} forces ${key}=${value} once and preserves q=cats`,
      landed.searchParams.get(key) === value && landed.searchParams.get('q') === 'cats' && redirects === 1 && page.url() === landed.href, `${redirects} redirects; ${page.url()}`);
    await go(`${origin}?q=cats&${key}=${value}`);
    check(`search: ${host} already-safe URL stays stable`, page.url() === `${origin}?q=cats&${key}=${value}`);
    await go(`${origin}?q=cats&${key}=${value}&${key}=off`);
    check(`search: ${host} cannot bypass SafeSearch with conflicting duplicate parameters`,
      JSON.stringify(new URL(page.url()).searchParams.getAll(key)) === JSON.stringify([value]), page.url());
  }
  await go(`http://localhost:${port}/pages/frame.html`);
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    document.body.append(frame);
  }, `http://www.google.com:${port}/search?q=cats`);
  check('search: SafeSearch also rewrites embedded search frames', !!(await waitFor(() =>
    page.frames().some((frame) => frame.url().includes('/search?q=cats&safe=active')), { timeout: 5000 })));
  await go(`http://localhost:${port}/pages/frame.html`);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/search?q=freep0rnvideos';
    document.body.append(frame);
  });
  check('search: embedded custom search frames get the word guard', !!(await waitFor(() =>
    page.frames().some((frame) => frame.url().includes('reason=search')), { timeout: 5000 })));
  await sync({ safeSearch: false }, []);
  for (const [host, key] of engines) {
    await go(`http://${host}:${port}/search?q=cats`);
    check(`search: safeSearch=false disables ${host} rewriting`, !new URL(page.url()).searchParams.has(key));
  }
  await sync({ safeSearch: true, enabled: false, youtubeRestrict: 'strict' }, []);
  for (const [host, key] of engines) {
    await go(`http://${host}:${port}/search?q=cats`);
    check(`search: enabled=false disables ${host} rewriting`, !new URL(page.url()).searchParams.has(key));
  }
  await go(`http://www.youtube.com:${port}/echo-headers`);
  check('search: master switch also disables YouTube Restricted Mode', !(await page.locator('body').innerText()).includes('youtube-restrict'));
  await sync({ enabled: true, youtubeRestrict: 'off' }, ['safesearch']);
  for (const query of ['nude photography', 'freep0rnvideos', 'bigtitsgirls', 'h 3 n t a i', 'ahegao', 's3x']) {
    await go(`http://www.google.com:${port}/search?q=${encodeURIComponent(query)}`);
    check(`search: explicit query blocked (${query})`, page.url().includes('reason=search'), page.url());
  }
  check('search: blocked page explains searches without retaining the query',
    (await page.locator('#why').innerText()).includes('This search') && !page.url().includes('s3x'));
  for (const query of ['sussex university', 'essex analysis', 'middlesex', 'reading their height']) {
    await go(`http://www.google.com:${port}/search?q=${encodeURIComponent(query)}`);
    check(`search: ordinary query allowed (${query})`, !page.url().includes('/blocked/'), page.url());
  }
  await go(`http://localhost:${port}/search?q=cats`);
  await page.evaluate(() => history.pushState({}, '', '?q=freep0rnvideos'));
  check('search: SPA query changes are blocked', !!(await waitFor(() => page.url().includes('reason=search'), { timeout: 3000 })));
  await sync({ wordFilter: false }, ['safesearch']);
  await go(`http://www.google.com:${port}/search?q=freep0rnvideos`);
  check('search: SafeSearch operates independently when the word filter is off',
    !page.url().includes('/blocked/') && new URL(page.url()).searchParams.get('safe') === 'active');
  await sync({ wordFilter: true, safeSearch: false }, []);
  await go(`http://localhost:${port}/search?q=freep0rnvideos`);
  check('search: word filtering operates independently when SafeSearch is off', page.url().includes('reason=search'));
  await sync({ safeSearch: true }, ['safesearch']);
  await go(`http://www.google.freeporn.test:${port}/search?q=cats&safe=active`);
  check('search: SafeSearch allow never overrides the adult-host blocker',
    page.url().includes('/blocked/blocked.html') && !page.url().includes('reason='), page.url());

  for (const level of ['strict', 'moderate', 'off']) {
    await sync({ youtubeRestrict: level }, ['safesearch', ...(level === 'off' ? [] : [`youtube-${level}`])]);
    await go(`http://www.youtube.com:${port}/`);
    const headers = await page.evaluate(() => fetch('/echo-headers').then((r) => r.json()));
    await go(`http://www.youtube.com:${port}/echo-headers`);
    const navigationHeaders = JSON.parse(await page.locator('body').innerText());
    const expected = level === 'off' ? undefined : level === 'strict' ? 'Strict' : 'Moderate';
    check(`search: YouTube ${level} sends the correct request header for navigation and fetch`,
      headers['youtube-restrict'] === expected && navigationHeaders['youtube-restrict'] === expected);
  }
  await page.close();
}
