/**
 * Client-side downscale with the canvas MOCKED — jsdom has no 2D
 * context and no `toBlob`, so the assertions are on what the pipeline ASKS the canvas to
 * do (the target geometry) and on what it hands back, not on pixels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fitWithin, needsDownscale, downscaleImage } from './downscale';

describe('fitWithin — longest edge cap, aspect preserved', () => {
  it('leaves a small image alone', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(1600, 1200, 1600)).toEqual({ w: 1600, h: 1200 });
  });
  it('scales the longest edge to the cap, landscape and portrait', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ w: 1600, h: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ w: 1200, h: 1600 });
  });
  it('zero-sized input is not a division by zero', () => {
    expect(fitWithin(0, 0, 1600)).toEqual({ w: 0, h: 0 });
  });
});

describe('needsDownscale', () => {
  it('is strictly greater-than the threshold', () => {
    expect(needsDownscale(new Blob([new Uint8Array(10)]), 10)).toBe(false);
    expect(needsDownscale(new Blob([new Uint8Array(11)]), 10)).toBe(true);
  });
});

// ── the pipeline against a mocked Image + canvas ──────────────────────────────────────
const big = () => new File([new Uint8Array(64)], 'IMG_0001.HEIC', { type: 'image/heic' });

let drawImage: ReturnType<typeof vi.fn>;
let toBlob: ReturnType<typeof vi.fn>;
let imageDims = { w: 4000, h: 3000 };
let imageFails = false;

beforeEach(() => {
  drawImage = vi.fn();
  toBlob = vi.fn().mockImplementation((cb: (b: Blob | null) => void, type: string) =>
    cb(new Blob([new Uint8Array(8)], { type })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  );
  HTMLCanvasElement.prototype.toBlob = toBlob as unknown as HTMLCanvasElement['toBlob'];
  imageFails = false;
  imageDims = { w: 4000, h: 3000 };
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => 'blob:x');
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
  class FakeImage {
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    naturalWidth = imageDims.w;
    naturalHeight = imageDims.h;
    set src(_v: string) {
      setTimeout(() => (imageFails ? this.onerror?.() : this.onload?.()), 0);
    }
  }
  vi.stubGlobal('Image', FakeImage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('downscaleImage', () => {
  it('returns the SAME file untouched when under the threshold (no re-encode)', async () => {
    const f = big();
    const out = await downscaleImage(f, { aboveBytes: 1000 });
    expect(out).toBe(f);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('draws to the capped geometry and returns a JPEG named like the original', async () => {
    const out = await downscaleImage(big(), { aboveBytes: 10, maxEdgePx: 1600, quality: 0.85 });
    expect(drawImage).toHaveBeenCalledTimes(1);
    // (img, dx, dy, dw, dh) — the target size is the whole point.
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 1200]);
    expect(toBlob.mock.calls[0][1]).toBe('image/jpeg');
    expect(toBlob.mock.calls[0][2]).toBe(0.85);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_0001.jpg');
  });

  it('portrait keeps its orientation', async () => {
    imageDims = { w: 3000, h: 4000 };
    await downscaleImage(big(), { aboveBytes: 10, maxEdgePx: 1600 });
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1200, 1600]);
  });

  it('FAILS OPEN: an undecodable image returns the original file, never nothing', async () => {
    imageFails = true;
    const f = big();
    expect(await downscaleImage(f, { aboveBytes: 10 })).toBe(f);
  });

  it('FAILS OPEN: no 2D context returns the original', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const f = big();
    expect(await downscaleImage(f, { aboveBytes: 10 })).toBe(f);
  });
});
