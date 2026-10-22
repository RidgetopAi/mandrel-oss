/**
 * Client-side photo downscale. A phone photo is 3–8 MB; the upload
 * cap is smaller and the board thumbnail never needs more than a screen's worth of
 * pixels. Anything over `downscaleAboveBytes` is re-encoded through a canvas to at most
 * `downscaleMaxEdgePx` on its longest edge. Smaller files pass through UNTOUCHED — no
 * re-encode, no quality loss, byte-identical to what was picked.
 *
 * Fails OPEN on purpose: if the browser cannot decode the image (an HEIC on a desktop
 * browser, say) or the canvas is unavailable, the ORIGINAL file is returned and the
 * server's own 413/415 says what it will not take. Losing the photo is worse than
 * losing the resize.
 */
import { PUNCH_CONFIG } from './config';

export interface DownscaleOptions {
  aboveBytes?: number;
  maxEdgePx?: number;
  quality?: number;
}

/** The target size for a (w × h) image under a longest-edge cap — pure, testable. */
export function fitWithin(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const longest = Math.max(w, h);
  if (longest <= maxEdge || longest === 0) return { w, h };
  const k = maxEdge / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Does this file need a downscale at all? */
export function needsDownscale(file: Blob, aboveBytes = PUNCH_CONFIG.downscaleAboveBytes): boolean {
  return file.size > aboveBytes;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image could not be decoded'));
    };
    img.src = url;
  });
}

/**
 * Downscale `file` if it is over the size threshold; otherwise return it as-is. The
 * result is a `File` named like the original (extension swapped to .jpg on a re-encode).
 */
export async function downscaleImage(file: File, opts: DownscaleOptions = {}): Promise<File> {
  const aboveBytes = opts.aboveBytes ?? PUNCH_CONFIG.downscaleAboveBytes;
  const maxEdge = opts.maxEdgePx ?? PUNCH_CONFIG.downscaleMaxEdgePx;
  const quality = opts.quality ?? PUNCH_CONFIG.downscaleJpegQuality;
  if (!needsDownscale(file, aboveBytes)) return file;

  try {
    const img = await loadImage(file);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const target = fitWithin(w, h, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = target.w;
    canvas.height = target.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, target.w, target.h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}
