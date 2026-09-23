/**
 * Fallback pixel extraction from an already-loaded <img>, used when the offscreen doc
 * can't fetch the URL itself (blob: URLs are page-scoped; some CDNs reject requests
 * without the page's Referer). Throws SecurityError on a tainted (cross-origin, no
 * CORS) image — caller treats that as a classification failure (stays blurred).
 *
 * CSS filters don't affect drawImage, so the blurred element yields clean pixels.
 */
const MAX_SIDE = 1024;

export function extractPixels(img: HTMLImageElement): string {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('image not decoded');
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}
