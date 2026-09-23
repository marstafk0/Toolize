// Packs extension/dist into a signed CRX3, the format Chrome needs for a self-hosted
// (policy-installed) extension.
//
// CRX3 layout:
//   "Cr24" | version=3 | header length | CrxFileHeader protobuf | zip
// The signature covers  "CRX3 SignedData\0" | len(signed_header) | signed_header | zip.
import { createHash, createSign } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crxPrivateKey, crxPublicKeyDer, extensionId } from './keys.mjs';

// ---------------------------------------------------------------- zip

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** Minimal deflate ZIP writer — enough for an extension package. */
export function zipDirectory(dir) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const name of walk(dir)) {
    const raw = readFileSync(join(dir, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const nameBuf = Buffer.from(name, 'utf8');

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += head.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

// ---------------------------------------------------------------- protobuf bits

const varint = (n) => {
  const bytes = [];
  do {
    const b = n & 0x7f;
    n >>>= 7;
    bytes.push(n ? b | 0x80 : b);
  } while (n);
  return Buffer.from(bytes);
};
/** field, wire type 2 (length-delimited) */
const field = (num, payload) => Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload]);

// ---------------------------------------------------------------- crx

export function packCrx(distDir, outFile) {
  const zip = zipDirectory(distDir);
  const publicKey = crxPublicKeyDer();
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId); // SignedData { bytes crx_id = 1 }

  const signer = createSign('sha256');
  signer.update(Buffer.from('CRX3 SignedData\0', 'binary'));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeaderData.length);
  signer.update(len);
  signer.update(signedHeaderData);
  signer.update(zip);
  const signature = signer.sign(crxPrivateKey());

  const proof = Buffer.concat([field(1, publicKey), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'ascii');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);

  const crx = Buffer.concat([prefix, header, zip]);
  writeFileSync(outFile, crx);
  return { file: outFile, id: extensionId(), bytes: crx.length };
}

if (process.argv[1]?.endsWith('crx.mjs')) {
  const [dist = 'extension/dist', out = 'toolize.crx'] = process.argv.slice(2);
  const r = packCrx(dist, out);
  console.log(`packed ${r.file} (${(r.bytes / 1e6).toFixed(2)} MB), extension id ${r.id}`);
}
