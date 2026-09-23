// Signing keys. They live OUTSIDE the repo and are never committed.
//
//   crx.pem              RSA key that packs the .crx — it determines the extension ID.
//                        Lose it and installed machines stop receiving extension
//                        updates; you reinstall by hand on every machine.
//   release.pem           RSA key that signs update.json. The app carries only the public
//                        half, so anyone who cannot sign cannot push an update to your
//                        machines. RSA, not Ed25519: .NET has it built in, which keeps the
//                        service a single self-contained file with no native dependency.
//
// Back up the whole directory somewhere safe before the first release.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const keysDir =
  process.env.TOOLIZE_KEYS_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'Toolize', 'keys');

const CRX_KEY = () => join(keysDir, 'crx.pem');
const RELEASE_KEY = () => join(keysDir, 'release.pem');

/** Creates any missing key. Existing keys are never touched. */
export function ensureKeys({ quiet = false } = {}) {
  mkdirSync(keysDir, { recursive: true });
  const made = [];
  if (!existsSync(CRX_KEY())) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(CRX_KEY(), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    made.push('crx.pem');
  }
  if (!existsSync(RELEASE_KEY())) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
    writeFileSync(RELEASE_KEY(), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    made.push('release.pem');
  }
  if (made.length && !quiet) {
    console.log(`generated ${made.join(', ')} in ${keysDir}`);
    console.log('BACK THIS DIRECTORY UP. Losing crx.pem breaks updates on installed machines.');
  }
  return { keysDir, made };
}

export const crxPrivateKey = () => createPrivateKey(readFileSync(CRX_KEY()));
export const crxPublicKeyDer = () => createPublicKey(crxPrivateKey()).export({ type: 'spki', format: 'der' });
/** The value manifest.json needs so an unpacked dev build gets the packed build's ID. */
export const crxPublicKeyBase64 = () => crxPublicKeyDer().toString('base64');

/** Chrome derives the ID from the first 16 bytes of SHA-256(SPKI), mapped to a–p. */
export function extensionId() {
  const digest = createHash('sha256').update(crxPublicKeyDer()).digest().subarray(0, 16);
  return [...digest].flatMap((b) => [b >> 4, b & 15]).map((n) => String.fromCharCode(97 + n)).join('');
}

export const releasePublicKeyBase64 = () =>
  createPublicKey(createPrivateKey(readFileSync(RELEASE_KEY()))).export({ type: 'spki', format: 'der' }).toString('base64');

/** Detached RSA-SHA256 signature over the manifest bytes, base64. */
export function signRelease(bytes) {
  return sign('sha256', bytes, createPrivateKey(readFileSync(RELEASE_KEY()))).toString('base64');
}

// `node tools/keys.mjs` prints what the installed app and the manifest need.
if (process.argv[1]?.endsWith('keys.mjs')) {
  ensureKeys();
  console.log(`keys dir:      ${keysDir}`);
  console.log(`extension id:  ${extensionId()}`);
  console.log(`release pubkey ${releasePublicKeyBase64()}`);
}
