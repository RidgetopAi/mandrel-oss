/**
 * Generator: derive src/styles/tokens.css from the single source of truth
 * (src/styles/tokens.ts). Run via `npm run tokens:css`.
 *
 * Node 24 strips TS types natively, so this runs as `node scripts/...ts` with no
 * extra toolchain. The drift-guard test (tokens.test.ts) verifies the committed
 * CSS matches what renderTokensCss() produces, so a forgotten regenerate fails CI.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderTokensCss } from '../src/styles/tokens.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../src/styles/tokens.css');

writeFileSync(out, renderTokensCss(), 'utf8');
// eslint-disable-next-line no-console
console.log(`tokens.css written → ${out}`);
