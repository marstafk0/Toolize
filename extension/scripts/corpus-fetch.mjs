// Fills test/corpus from Wikimedia Commons (freely licensed, no API key), so the
// regression corpus doesn't depend on hand-collected screenshots.
//   node scripts/corpus-fetch.mjs [perCategory=60]
//
// "safe" sets are hard negatives: ordinary pictures this kind of model is known to
// misjudge (raw meat, skin-coloured food and textures, medical skin close-ups, gym and
// sport, faces). "flag" sets are suggestive-but-not-explicit (swimwear, lingerie), so a
// change that loosens real protection still shows up. Nothing explicit is fetched.
// Images land in test/corpus/<kind>/<set>/ (gitignored). Re-running skips what's there.
// Review with scripts/corpus-sheet.mjs and list wrong ones in test/corpus/exclude.txt.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const perSet = Number(process.argv[2] ?? 60);
const root = join(import.meta.dirname, '../test/corpus');
const UA = 'ToolizeCorpus/1.0 (https://github.com/marstafk0/Toolize; local classifier regression set)';
const API = 'https://commons.wikimedia.org/w/api.php';
// Reviewed out by hand (wrong label): corpus-relative paths, one per line. Kept on disk so
// they're never fetched again; the corpus server skips them.
const excludeFile = join(root, 'exclude.txt');
const excluded = new Set(existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);

// set -> Commons categories (searched one level of subcategories deep), or "search:<words>"
// for a file search — tighter when a category is mostly wide shots of shops and markets.
const SETS = {
  safe: {
    'raw-meat': ['search:raw steak close up', 'search:raw beef cut', 'search:raw pork belly', 'search:raw chicken breast', 'search:brisket raw', 'search:ribeye raw', 'Raw meat', 'Beef cuts'],
    'food-skin-tone': ['Sausages', 'Bread dough', 'Peaches', 'Hot dogs', 'Ham', 'Croissants', 'Bagels', 'Potatoes'],
    'medical-skin': ['Dermatology', 'Eczema', 'Psoriasis', 'search:skin rash arm', 'search:sunburn back', 'search:knee surgery scar', 'search:physiotherapy shoulder'],
    'hands-feet': ['Human hands', 'Human feet', 'Elbows', 'Knees', 'Human arms'],
    'gym-sport': ['Bodybuilders', 'Weightlifting', 'Wrestlers', 'Boxers', 'Yoga', 'Rowing (sport)'],
    'faces': ['search:portrait woman smiling', 'search:portrait man headshot', 'search:selfie', 'search:makeup tutorial face', 'search:youtuber thumbnail face'],
    'pink-animals': ['search:pig pink close', 'search:sphynx cat', 'search:piglet', 'search:hairless dog', 'search:shar pei puppy'],
    'textures': ['Sand dunes', 'Pottery', 'Clay', 'Leather', 'Silk', 'Wood grain'],
    'home-listings': ['search:leather sofa', 'search:leather couch living room', 'search:mattress bed bedroom', 'search:bathtub bathroom', 'search:beige armchair', 'search:pillows bed'],
    'beach-crowd': ['search:crowded beach', 'search:beach family summer', 'search:public swimming pool people', 'search:water park'],
  },
  flag: {
    'swimwear': ['Bikinis', 'search:woman bikini beach', 'search:bikini model', 'search:swimsuit model photoshoot'],
    // Commons search isn't filtered: "woman in underwear" pulled in an explicit photo.
    // Keep these terms narrow, and review every new batch (corpus-sheet --new).
    'lingerie': ['Lingerie', 'search:lingerie model', 'search:lingerie photoshoot'],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    if (attempt >= 3) throw new Error(`HTTP ${res.status} for ${url}`);
    await sleep(2000 * (attempt + 1));
  }
}

function usable(pages) {
  const out = [];
  for (const p of pages ?? []) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || ii.width < 200 || ii.height < 200) continue;
    out.push({ title: p.title, thumb: ii.thumburl ?? ii.url });
  }
  return out;
}

/** Image files in a category and its direct subcategories, or matching a search: [{title, thumb}]. */
async function filesIn(category, want) {
  if (category.startsWith('search:')) {
    const r = await api({
      action: 'query', generator: 'search', gsrsearch: `${category.slice(7)} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '50',
      prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '640',
    });
    return usable(r.query?.pages);
  }
  const out = [];
  const cats = [category];
  const sub = await api({ action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmtype: 'subcat', cmlimit: '50' });
  for (const c of sub.query?.categorymembers ?? []) cats.push(c.title.replace(/^Category:/, ''));
  for (const cat of cats) {
    if (out.length >= want) break;
    const r = await api({
      action: 'query', generator: 'categorymembers', gcmtitle: `Category:${cat}`, gcmtype: 'file', gcmlimit: '50',
      prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '640',
    });
    out.push(...usable(r.query?.pages));
    await sleep(300);
  }
  return out;
}

for (const [kind, sets] of Object.entries(SETS)) {
  for (const [set, categories] of Object.entries(sets)) {
    const dir = join(root, kind, set);
    mkdirSync(dir, { recursive: true });
    // Files on disk are never fetched again; those reviewed out (exclude.txt) don't count.
    const have = new Set(readdirSync(dir));
    const kept = [...have].filter((f) => !excluded.has(`${kind}/${set}/${f}`)).length;
    if (kept >= perSet) {
      console.log(`${kind}/${set}: ${kept} already`);
      continue;
    }
    // Spread the set over its categories rather than filling it from the first one.
    const share = Math.ceil(perSet / categories.length);
    const picks = [];
    for (const c of categories) {
      const files = await filesIn(c, share * 2).catch((e) => (console.warn(`  ${c}: ${e.message}`), []));
      if (!files.length) console.warn(`  ${kind}/${set}: category "${c}" has no usable images`);
      picks.push(...files.sort(() => Math.random() - 0.5).slice(0, share));
    }
    let got = kept;
    for (const f of picks) {
      if (got >= perSet) break;
      const name = f.title.replace(/^File:/, '').replace(/[^\w.-]+/g, '_').slice(-80).replace(/\.(jpe?g|png|webp)$/i, '') + '.jpg';
      if (have.has(name) || existsSync(join(dir, name)) || excluded.has(`${kind}/${set}/${name}`)) continue;
      try {
        const res = await fetch(f.thumb, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(join(dir, name), Buffer.from(await res.arrayBuffer()));
        got++;
      } catch (e) {
        console.warn(`  skip ${f.title}: ${e.message}`);
      }
      await sleep(150);
    }
    console.log(`${kind}/${set}: ${got}`);
  }
}
