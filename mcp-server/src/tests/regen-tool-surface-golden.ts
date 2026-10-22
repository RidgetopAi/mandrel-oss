/**
 * REGENERATE the tool-surface golden fixture — the DELIBERATE path
 * src/tests/toolSurfaceGolden.contract.test.ts's header describes.
 *
 * That header says, correctly: "do NOT loosen the assertion or regenerate the fixture to
 * make it pass … Either the change is intended (a real, reviewed surface change —
 * regenerate the golden deliberately, in its own commit, with the wire delta called out) or
 * it is an accidental regression to fix."
 *
 * Until P5.5 the regeneration recipe lived only as a SENTENCE in that header ("the fixture
 * shape is exactly `JSON.stringify({definitions, categoryOrder, toolCategories}, null, 2) +
 * '\n'`"), which means every deliberate regeneration re-implemented it by hand from prose.
 * A hand-reimplemented serializer that differs by one byte produces a fixture that fails for
 * a reason unrelated to the surface change, and the natural next move is to "fix" the
 * assertion. This file removes the retyping: it imports the SAME serializer shape the test
 * asserts with, and prints the measured deltas the header requires you to document.
 *
 * RUN:  npx tsx src/tests/regen-tool-surface-golden.ts
 * It PRINTS the before/after byte counts. Paste them into the test header's
 * "DELIBERATE REGENERATIONS" log with the wire delta called out, or do not regenerate.
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AIDIS_TOOL_DEFINITIONS,
  TOOL_CATEGORIES,
  CATEGORY_ORDER,
} from '../config/toolDefinitions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'fixtures', 'toolSurface.golden.json');

const serialized =
  JSON.stringify(
    {
      definitions: AIDIS_TOOL_DEFINITIONS,
      categoryOrder: CATEGORY_ORDER,
      toolCategories: TOOL_CATEGORIES,
    },
    null,
    2,
  ) + '\n';

const before = readFileSync(GOLDEN, 'utf8');
writeFileSync(GOLDEN, serialized);

console.log(`fixture bytes      : ${Buffer.byteLength(before, 'utf8')} -> ${Buffer.byteLength(serialized, 'utf8')}`);
console.log(`tools/list compact : ${Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS), 'utf8')}`);
console.log(`tool count         : ${AIDIS_TOOL_DEFINITIONS.length}`);
