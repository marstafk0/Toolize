/**
 * Turns an image URL / data URL into a decoded bitmap inside the extension's own
 * context. Nothing here touches the page: no CSP, no tainted canvases.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 40 * 1024 * 1024;
/** Decoded images larger than this get downscaled before tiling (memory bound). */
const MAX_DECODE_SIDE = 4096;

export class FetchError extends Error {}

export interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

export async function fetchImageBlob(url: string): Promise<Blob> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // credentials: extension requests with host permission carry the user's cookies,
    // so images behind a login (private subreddits, DMs) still load.
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: ctrl.signal });
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new FetchError(`too large (${len} bytes)`);
    return await res.blob();
  } catch (e) {
    throw e instanceof FetchError ? e : new FetchError(String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timer);
  }
}

export async function decodeBlob(blob: Blob): Promise<Decoded> {
  try {
    const bmp = await createImageBitmap(blob);
    return capSize({ source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() });
  } catch {
    // createImageBitmap rejects SVG (and a few odd formats); <img> decodes them.
    return capSize(await decodeViaElement(blob));
  }
}

async function decodeViaElement(blob: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // SVGs without intrinsic size report 0; give them a sane raster size.
    const width = img.naturalWidth || 512;
    const height = img.naturalHeight || 512;
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
    return { source: canvas, width, height, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function capSize(d: Decoded): Decoded {
  const side = Math.max(d.width, d.height);
  if (side <= MAX_DECODE_SIDE) return d;
  const scale = MAX_DECODE_SIDE / side;
  const width = Math.max(1, Math.round(d.width * scale));
  const height = Math.max(1, Math.round(d.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(d.source, 0, 0, width, height);
  d.close();
  return { source: canvas, width, height, close: () => {} };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draws `rect` of the decoded image into a size x size RGBA buffer. */
export function cropToImageData(d: Decoded, rect: Rect, size: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(d.source, rect.x, rect.y, rect.w, rect.h, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Overlapping square tiles over the full-resolution image, plus a centre tile.
 * Tiles are ~60% of the short side so the model sees real detail that the whole-image
 * downscale throws away. Capped so a very tall/wide image stays bounded.
 */
export function tileRects(width: number, height: number): Rect[] {
  const side = Math.round(Math.min(width, height) * 0.6);
  const axis = (len: number): number[] => {
    if (len <= side) return [0];
    const n = Math.min(3, Math.ceil((len - side) / (side * 0.7)) + 1);
    return Array.from({ length: n }, (_, i) => Math.round(((len - side) * i) / (n - 1)));
  };
  const rects: Rect[] = [];
  for (const y of axis(height)) for (const x of axis(width)) rects.push({ x, y, w: side, h: side });
  rects.push({ x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), w: side, h: side });
  return rects;
}
