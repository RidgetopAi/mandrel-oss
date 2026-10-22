/**
 * domToPng.cloneForExport — the EXCLUSION CONTRACT for the shareable PNG.
 *
 * The day-summary card's Export/Copy actions (and the close button) carry
 * `data-export-exclude`; the exporter clones the card with a `filter` that drops
 * those nodes so they never appear in the artifact — while the watermark + all the
 * content DO survive. This test pins that contract (a regression would leak the
 * buttons into the exported image). Actual SVG→canvas rasterization needs a real
 * browser (verified via playwright in the build report), not jsdom.
 */
import { describe, it, expect } from 'vitest';
import { cloneForExport } from './domToPng';

function build(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="content">
      <p>What got done</p>
      <span class="wm">Mandrel · tenant.example.test</span>
      <div class="actions" data-export-exclude="true">
        <button>Copy link</button>
        <button>Export PNG</button>
      </div>
      <button class="close" data-export-exclude="true">x</button>
    </div>`;
  document.body.appendChild(card);
  return card;
}

const notExcluded = (el: Element) => el.getAttribute('data-export-exclude') !== 'true';

describe('cloneForExport — export exclusion contract', () => {
  it('drops [data-export-exclude] subtrees but keeps the watermark + content', () => {
    const card = build();
    const clone = cloneForExport(card, notExcluded) as HTMLElement;

    expect(clone).not.toBeNull();
    const text = clone.textContent ?? '';
    expect(text).toContain('What got done');
    // The watermark must survive the export clone VERBATIM — that is the assertion.
    // The host in this fixture is a placeholder ON PURPOSE: the component now derives
    // it from window.location (daySummaryConfig.watermarkHost), so pinning OUR
    // hostname here would re-assert the very defect that was removed. The contract
    // being proved is unchanged and just as strong: the watermark node is NOT dropped
    // by the exclusion filter, character for character.
    expect(text).toContain('Mandrel · tenant.example.test');
    // the excluded actions + their buttons are gone
    expect(clone.querySelector('[data-export-exclude]')).toBeNull();
    expect(text).not.toContain('Export PNG');
    expect(text).not.toContain('Copy link');

    document.body.removeChild(card);
  });

  it('returns null when the root node itself is excluded', () => {
    const el = document.createElement('div');
    el.setAttribute('data-export-exclude', 'true');
    expect(cloneForExport(el, notExcluded)).toBeNull();
  });

  it('inlines computed styles onto the clone (so it renders without a stylesheet)', () => {
    const card = build();
    const clone = cloneForExport(card) as HTMLElement;
    // jsdom returns a (possibly sparse) computed style; the clone must carry an
    // inline style attribute so the serialized SVG is self-contained.
    expect(clone.getAttribute('style')).not.toBeNull();
    document.body.removeChild(card);
  });
});
