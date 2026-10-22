/**
 * domToPng — a small, dependency-free DOM→PNG rasterizer for the shareable
 * day-summary card (the operator posts the PNG on X). No html-to-image / html2canvas dep:
 * the card is self-contained (system fonts, inline SVG, no external images), so the
 * standard SVG-`<foreignObject>` technique captures it faithfully.
 *
 * HOW: deep-clone the node, INLINE every element's computed style onto the clone
 * (external stylesheet + CSS-module rules don't travel with a serialized node, so
 * we bake them in), wrap the clone as XHTML inside an `<svg><foreignObject>`, load
 * that as an <img>, and paint it onto a 2×-DPR canvas → a crisp PNG blob.
 *
 * EXCLUSIONS: a `filter` predicate drops nodes from the clone (the on-screen Export/
 * Copy buttons carry `data-export-exclude` so they never appear in the artifact).
 * The card intentionally uses NO ::before/::after pseudo-elements (they can't be
 * cloned) — every divider/quote glyph is a real element so the export is faithful.
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

export interface DomToPngOptions {
  /** devicePixelRatio multiplier for a crisp raster (default 2). */
  scale?: number;
  /** Solid colour painted behind the (possibly rounded/transparent) card. */
  background?: string;
  /** Return false to omit an element (and its subtree) from the export. */
  filter?: (el: Element) => boolean;
}

/** Copy every computed style property of `src` onto `dst` as one inline `style`. */
function inlineComputedStyle(src: Element, dst: Element): void {
  const cs = window.getComputedStyle(src);
  // getComputedStyle enumerates the full longhand set; join into one cssText so the
  // clone renders identically without its stylesheet.
  let css = '';
  for (let i = 0; i < cs.length; i += 1) {
    const prop = cs.item(i);
    css += `${prop}:${cs.getPropertyValue(prop)};`;
  }
  if (css) dst.setAttribute('style', css);
}

/**
 * Deep-clone `src`, inlining computed styles and honouring the `filter`. Exported
 * for unit testing the exclusion contract (the Export/Copy buttons must not survive
 * into the clone that gets rasterized).
 */
export function cloneForExport(src: Element, filter?: (el: Element) => boolean): Element | null {
  if (SKIP_TAGS.has(src.tagName)) return null;
  if (filter && !filter(src)) return null;

  const clone = src.cloneNode(false) as Element;
  inlineComputedStyle(src, clone);

  src.childNodes.forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const c = cloneForExport(child as Element, filter);
      if (c) clone.appendChild(c);
    } else if (child.nodeType === Node.TEXT_NODE) {
      clone.appendChild(child.cloneNode(true));
    }
  });

  return clone;
}

/** Serialize `node` (with styles inlined) into an SVG data URL of the given size. */
function toSvgDataUrl(node: Element, width: number, height: number, filter?: (el: Element) => boolean): string {
  const clone = cloneForExport(node, filter);
  if (!clone) throw new Error('domToPng: nothing to export (node filtered out)');
  // The foreignObject body must be XHTML-namespaced so the SVG parser accepts it.
  clone.setAttribute('xmlns', XHTML_NS);

  const wrapper = document.createElementNS(SVG_NS, 'svg');
  wrapper.setAttribute('xmlns', SVG_NS);
  wrapper.setAttribute('width', String(width));
  wrapper.setAttribute('height', String(height));
  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', '0');
  fo.setAttribute('y', '0');
  fo.setAttribute('width', '100%');
  fo.setAttribute('height', '100%');
  fo.appendChild(clone);
  wrapper.appendChild(fo);

  const xml = new XMLSerializer().serializeToString(wrapper);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('domToPng: failed to rasterize the card'));
    img.src = src;
  });
}

/** Render `node` to a PNG Blob at `scale`× device pixels. */
export async function nodeToPngBlob(node: HTMLElement, options: DomToPngOptions = {}): Promise<Blob> {
  const scale = options.scale ?? 2;
  const rect = node.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);

  const dataUrl = toSvgDataUrl(node, width, height, options.filter);
  const img = await loadImage(dataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width * scale);
  canvas.height = Math.max(1, height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('domToPng: 2D canvas context unavailable');

  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('domToPng: canvas.toBlob returned null'));
    }, 'image/png');
  });
}

/** Render `node` to a PNG and trigger a browser download named `filename`. */
export async function downloadNodeAsPng(
  node: HTMLElement,
  filename: string,
  options: DomToPngOptions = {},
): Promise<void> {
  const blob = await nodeToPngBlob(node, options);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
