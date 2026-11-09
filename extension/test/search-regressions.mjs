import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await esbuild.build({
  stdin: { contents: "export * from './src/shared/words'; export * from './src/shared/search'; export * from './src/shared/feeds';", resolveDir: root },
  bundle: true, format: 'esm', write: false, define: { __DEV__: 'false' }, logLevel: 'silent',
});
const { buildMatcher, DEFAULT_WORDS, matchesWords, matchesStrongQuery, urlAsText, searchQueries, looksLikeBot } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const re = buildMatcher(DEFAULT_WORDS);
const blocked = (text) => matchesWords(re, text) || matchesStrongQuery(text);
const clean = [
  'snake diet', '7175', '71754', '71 75', 'chapter 34', 'page 621', 'r 34', 'r 18', 'e 621',
  'freeR34art', 'r345', 'e6210', 'milfoil', 'Milford weather', 'denudes', 'snaked', 'petits fours',
  'pussyfooting', 'orecchiette', 'Ponte Vecchio', 'futatsu', 'shotai', 'constituents',
  'summa cum laude', 'oxidative cleavage', 'cell cleavage', 'bondage of the will Luther',
  'pipe nipple fitting', 'areola pregnancy', 'Richard Hooker theology', 'Hooker headers',
  'wax stripper', 'floor stripper', 'escort radar detector', 'ultrasonic vibrator',
  'naked put options', 'naked seed plants', 'nude Matisse', 'nude Duchamp',
  'asexual reproduction', 'steamy kitchen', 'see through fireplace', 'Bikini Atoll',
  'Matisse blue nude', 'Duchamp nude', 'Exodus bondage', 'bondage Maugham',
  'insulation R-18 rating', 'nipple baby bottle replacement',
];
for (const query of clean) assert.equal(blocked(query), false, query);

// These contexts are local to an occurrence, not a whitelist for the entire query.
for (const text of ['blue tits and tits', 'naked eye naked', 'cum laude cum', 'Ford Escort escort service']) {
  assert.equal(blocked(text), true, text);
}
for (const text of ['p.o.r.n', 'h 3 n t a i', 'p0rn', 's3x video', 'n u d e pics', 'r-34', 'r_34', 'rule 34', 'e-621', 'sex_abc', 'nude_pics', '_r34_']) {
  assert.equal(blocked(text), true, text);
}

for (const key of ['v', 'id', 'si', 't', 'list', 'feature', 'token', 'sig', 'video_id', 'access_token', 'utm_source']) {
  const url = `https://www.youtube.com/watch?${key}=sex`;
  assert.equal(matchesWords(re, urlAsText(url)), false, url);
}
for (const url of [
  'https://www.youtube.com/watch?v=abc_sex_123',
  'https://example.test/page?opaque=abc_sex_123',
  'https://example.test/page?opaque=abc%5Fsex%5F123',
  'https://example.test/%ZZ?v=sex',
  'https://example.test/biological-sex',
  'https://example.test/naked_eye',
]) assert.equal(matchesWords(re, urlAsText(url)), false, url);
for (const url of [
  'https://example.test/nude_photography', 'https://example.test/page?description=nude+pics',
  'https://example.test/page#nude-art', 'https://example.test/page?q=sex+video&id=cats',
]) assert.equal(matchesWords(re, urlAsText(url)), true, url);
assert.deepEqual(searchQueries('https://www.google.com/webhp?q=cats'), ['cats']);
assert.deepEqual(searchQueries('https://www.google.com/?q=cats'), ['cats']);
assert.equal(matchesWords(re, 'bigtitsgirls'), false);
assert.equal(matchesWords(buildMatcher([...DEFAULT_WORDS, 'nude']), 'nude lipstick'), true);
assert.equal(matchesWords(buildMatcher(['/needle.*/', '/(/', '# comment']), 'needlework'), true);
for (const entry of DEFAULT_WORDS) assert.ok(buildMatcher([entry]), `built-in pattern must compile: ${entry}`);

// The query fix must leave the separate comment-bot folding behavior intact.
for (const [author, text, expected] of [
  ['p.o.r.n', 'hello', true], ['only f4ns', 'hello', true],
  ['someone', 'look at my profile', true], ['someone', 'beautiful piano playing', false],
]) assert.equal(looksLikeBot(author, text), expected);
console.log(`PASS search regressions (${clean.length} additional clean queries, contexts, IDs, user extras and bot behavior)`);
