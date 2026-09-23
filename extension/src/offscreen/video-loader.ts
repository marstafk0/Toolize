import { fetchImageBlob, type Decoded } from './image-loader';

/**
 * Samples frames from a video file the page can't hand us pixels for (cross-origin
 * without CORS taints the page canvas). We refetch it here, where host permissions
 * bypass CORS, and turn it into a same-origin blob we can legally draw.
 *
 * Only worth it for short clips — the kind that autoplay in feeds. Anything longer or
 * larger is left to the page-canvas path, and stays blurred if that fails too.
 */

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_SECONDS = 600;
/** Fractions of the duration to sample. Cheap, and enough for a loop or short clip. */
const SAMPLE_POINTS = [0.1, 0.4, 0.75];

export async function loadVideoFrames(url: string): Promise<Decoded[]> {
  const blob = await fetchImageBlob(url);
  if (blob.size > MAX_BYTES) throw new Error(`video too large (${blob.size} bytes)`);

  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    video.src = objectUrl;
    await once(video, 'loadeddata');
    const { videoWidth: width, videoHeight: height, duration } = video;
    if (!width || !height) throw new Error('video has no frames');
    if (duration > MAX_SECONDS) throw new Error(`video too long (${Math.round(duration)}s)`);

    const frames: Decoded[] = [];
    const times = Number.isFinite(duration) ? SAMPLE_POINTS.map((p) => duration * p) : [0];
    for (const t of times) {
      video.currentTime = t;
      await once(video, 'seeked');
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      frames.push({ source: canvas, width, height, close: () => {} });
    }
    return frames;
  } finally {
    video.src = '';
    URL.revokeObjectURL(objectUrl);
  }
}

function once(el: HTMLMediaElement, event: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      el.removeEventListener(event, ok);
      el.removeEventListener('error', fail);
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const ok = () => done();
    const fail = () => done(new Error(el.error?.message ?? `video ${event} failed`));
    // setTimeout is throttled in this hidden document; this is a backstop, not a deadline.
    const timer = setTimeout(() => done(new Error(`video ${event} timed out`)), timeoutMs);
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', fail, { once: true });
  });
}
