/**
 * regen-tool-surface-golden.ts — regenerate the tool-surface golden fixture and EMIT the four
 * numbers its own change log requires, in the SAME RUN that rewrites it.
 *
 * WHY IT EXISTS. The change log inside src/tests/toolSurfaceGolden.contract.test.ts carries a
 * ⚠️ dated 2026-07-29 saying its running byte totals do not reconcile, that several entries
 * are wrong, and — verbatim — "THE REAL FIX IS TO STOP HAND-WRITING THESE: the regeneration
 * path should EMIT the four numbers, so the log cannot drift from the fixture it describes."
 * This is that. A hand-maintained number beside a derived artifact is the same
 * two-representations-of-one-truth disease as a hand-kept population list.
 *
 * Each number NAMES ITS INSTRUMENT, because two reasonable instruments disagree and an
 * unnamed one is the wrong one: a tool object measured STANDALONE carries its own enclosing
 * braces, one measured in situ inside the pretty fixture does not. Neither is wrong.
 *
 * USAGE — from mcp-server/, with the DB env any src/ import needs:
 *
 *   env NODE_ENV=test DATABASE_NAME=<a ci_ db> DATABASE_USER=... DATABASE_PASSWORD=... \
 *       DATABASE_HOST=localhost DATABASE_PORT=5432 \
 *       GOLDEN_PATH=src/tests/fixtures/toolSurface.golden.json \
 *       npx tsx scripts/regen-tool-surface-golden.ts
 *
 * It MEASURES ONLY by default. Add WRITE=1 to actually rewrite the fixture — regenerating a
 * golden is a deliberate act that belongs in its own reviewed commit with the wire delta
 * called out, never a reflex to make a red test pass.
 */
import { readFileSync, writeFileSync } from 'fs';
import {
  AIDIS_TOOL_DEFINITIONS,
  TOOL_CATEGORIES,
  CATEGORY_ORDER,
} from '../src/config/toolDefinitions.js';

const GOLDEN = process.env.GOLDEN_PATH!;
const after =
  JSON.stringify(
    { definitions: AIDIS_TOOL_DEFINITIONS, categoryOrder: CATEGORY_ORDER, toolCategories: TOOL_CATEGORIES },
    null,
    2,
  ) + '\n';

const before = readFileSync(GOLDEN, 'utf8');
const oldDefs: any[] = JSON.parse(before).definitions;
const newDefs: any[] = AIDIS_TOOL_DEFINITIONS as any[];

const byName = (defs: any[]) => Object.fromEntries(defs.map((d) => [d.name, d]));
const o = byName(oldDefs);
const n = byName(newDefs);
const moved: Array<[string, string, number, number]> = [];
for (const name of Object.keys(n)) {
  const a = o[name] ? JSON.stringify(o[name], null, 2) : null;
  const b = JSON.stringify(n[name], null, 2);
  if (a === null) moved.push([name, 'ADDED', 0, Buffer.byteLength(b)]);
  else if (a !== b) moved.push([name, 'CHANGED', Buffer.byteLength(a), Buffer.byteLength(b)]);
}
const removed = Object.keys(o).filter((k) => !(k in n));
const compact = (defs: any[]) => Buffer.byteLength(JSON.stringify(defs), 'utf8');
const d = (a: number, b: number) => `${b - a >= 0 ? '+' : ''}${b - a}`;

const fb = Buffer.byteLength(before, 'utf8');
const fa = Buffer.byteLength(after, 'utf8');
console.log('fixture      — wc -c on the pretty fixture:');
console.log(`                ${fb} -> ${fa}  (${d(fb, fa)}, ${((fa - fb) / fb * 100).toFixed(2)}%)`);
console.log(`tool count   — AIDIS_TOOL_DEFINITIONS.length: ${oldDefs.length} -> ${newDefs.length}`);
console.log("tools/list   — Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS),'utf8') (COMPACT wire):");
console.log(`                ${compact(oldDefs)} -> ${compact(newDefs)}  (${d(compact(oldDefs), compact(newDefs))}, ${((compact(newDefs) - compact(oldDefs)) / compact(oldDefs) * 100).toFixed(2)}%)`);
console.log('per tool     — Buffer.byteLength(JSON.stringify(def, null, 2)) STANDALONE:');
for (const [name, kind, a, b] of moved) console.log(`                ${name} [${kind}] ${a} -> ${b} (${d(a, b)})`);
console.log(`TOOLS WHOSE BYTES MOVED = ${moved.length} · ADDED ${moved.filter((m) => m[1] === 'ADDED').length} · REMOVED ${removed.length}`);

if (process.env.WRITE === '1') {
  writeFileSync(GOLDEN, after);
  console.log(`\nfixture REWRITTEN: ${GOLDEN}`);
}
