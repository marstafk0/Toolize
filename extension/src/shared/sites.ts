import DOMAINS from './adult-domains.json';

/**
 * Site-level blocking. Cheaper and more reliable than classifying thousands of images:
 * a known adult site never loads at all. This is a seed list, not a comprehensive
 * filter — the classifier remains the backstop for everything it misses, and the
 * companion app's DNS filter (phase 4+) is what covers non-browser traffic.
 */
export const ADULT_DOMAINS: string[] = DOMAINS;

/**
 * Hostname keyword heuristic for the long tail, in two tiers.
 *
 * STRONG words are unambiguous, so they match anywhere in the hostname
 * ("freeporn-tube.net", "myxxxsite.com").
 */
export const STRONG_WORDS = [
  'porn',
  'xxx',
  'hentai',
  'nsfw',
  'milf',
  'bdsm',
  'camgirl',
  'blowjob',
  'creampie',
  'rule34',
  'camwhore',
  'escort',
];

/**
 * WEAK words appear inside ordinary English, so they only match a whole hostname label:
 * "analytics.google.com" and "sussex.ac.uk" must not trip "anal" or "sex".
 */
export const WEAK_WORDS = ['sex', 'sexo', 'nude', 'nudes', 'boobs', 'fetish', 'anal', 'incest', 'tits'];

/** Labels that are a weak word plus context, and are legitimate. */
const ALLOW_LABELS = ['sexuality', 'sexualhealth', 'sexeducation', 'middlesex', 'sussex', 'essex', 'wessex', 'sexton'];

export function isAdultHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (ADULT_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  const labels = host.split(/[.\-_]/);
  if (labels.some((l) => ALLOW_LABELS.includes(l))) return false;
  if (STRONG_WORDS.some((w) => host.includes(w))) return true;
  return labels.some((l) => WEAK_WORDS.includes(l));
}

/** Regex source for the declarativeNetRequest keyword rule (matches the tiers above). */
export function adultHostRegex(): string {
  const host = '[^/]*';
  const strong = `^https?://${host}(${STRONG_WORDS.join('|')})${host}(/|$)`;
  const weak = `^https?://([^/]*[.\\-_])?(${WEAK_WORDS.join('|')})([.\\-_][^/]*)?\\.[a-z]{2,}(/|$)`;
  return `(${strong})|(${weak})`;
}
