#!/usr/bin/env node
/**
 * openapi-drift-compare.cjs — the JSON-aware half of the OpenAPI artifact-drift
 * gate. Driven by scripts/test/openapi-artifact-drift.test.sh.
 *
 * Two subcommands, both fail-closed. Anything this cannot read or parse is a
 * FINDING (exit 1), never a silent pass — an unparseable spec is exactly the state
 * a broken export leaves behind, and the whole class this gate exists for is a
 * check that announces it measured and did not.
 *
 *   floor <spec.json> <minPaths>
 *     Asserts the spec is real: it parses, it has a `paths` object, and that object
 *     has at least <minPaths> members. Guards the collapsed-glob case, where
 *     swagger-jsdoc happily emits a well-formed spec with zero paths.
 *
 *   spec <before.json> <after.json>
 *     Byte comparison first (that is the actual contract — the artifact is checked
 *     in verbatim). When the bytes differ it re-reads both as JSON and NAMES what
 *     moved: added / removed / changed path keys and changed component schemas, so
 *     the RED tells you which route drifted instead of "a file changed".
 *
 * Exit: 0 clean · 1 finding.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function die(msg) {
  process.stdout.write(msg + '\n');
  process.exit(1);
}

function readText(p, label) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    die(`${label}: cannot read ${p} (${err.code || err.message})`);
  }
  return '';
}

function readJson(p, label) {
  const text = readText(p, label);
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`${label}: ${p} is not parseable JSON (${err.message})`);
  }
  return null;
}

function cmdFloor(specPath, minPathsRaw) {
  const minPaths = Number.parseInt(minPathsRaw, 10);
  if (!Number.isFinite(minPaths) || minPaths < 1) {
    die(`floor: minPaths must be a positive integer, got "${minPathsRaw}"`);
  }
  const spec = readJson(specPath, 'floor');
  const paths = spec && spec.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    die(`floor: ${specPath} has no \`paths\` object — the export produced a spec that documents nothing`);
  }
  const n = Object.keys(paths).length;
  if (n < minPaths) {
    die(
      `floor: ${specPath} documents ${n} path(s), below the floor of ${minPaths}.\n` +
      '  A spec this small is the collapsed-glob signature: swagger-jsdoc resolves its\n' +
      "  `apis` glob against the process CWD and emits a valid, EMPTY spec when the route\n" +
      '  sources are not visible. Treated as a failed export, not as a clean diff.'
    );
  }
  process.stdout.write(`floor: OK — ${n} path(s) documented (floor ${minPaths})\n`);
  process.exit(0);
}

function keysOf(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [];
}

function reportSection(label, before, after, out) {
  const b = keysOf(before);
  const a = keysOf(after);
  for (const k of a) if (!b.includes(k)) out.push(`  + ${label} ADDED BY REGENERATION (missing from the checked-in artifact): ${k}`);
  for (const k of b) if (!a.includes(k)) out.push(`  - ${label} REMOVED BY REGENERATION (stale in the checked-in artifact): ${k}`);
  for (const k of a) {
    if (!b.includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      out.push(`  ~ ${label} DIFFERS between the checked-in artifact and the route source: ${k}`);
    }
  }
}

function cmdSpec(beforePath, afterPath) {
  const beforeText = readText(beforePath, 'spec');
  const afterText = readText(afterPath, 'spec');
  if (beforeText === afterText) {
    process.stdout.write('spec: OK — the checked-in specification is byte-identical to a fresh export\n');
    process.exit(0);
  }
  const before = readJson(beforePath, 'spec');
  const after = readJson(afterPath, 'spec');
  const out = [];
  reportSection('path', before.paths, after.paths, out);
  reportSection(
    'schema',
    before.components && before.components.schemas,
    after.components && after.components.schemas,
    out
  );
  if (out.length === 0) {
    // Bytes differ but no path or schema moved: still a finding. The checked-in
    // artifact is not what the exporter produces, and we refuse to decide that the
    // part we did not enumerate does not matter.
    out.push('  ~ the bytes differ outside paths/components.schemas (info, servers, security, tags)');
  }
  die(
    `spec: DRIFT — ${beforePath} is not what the route annotations produce.\n` +
    out.join('\n')
  );
}

// ---------------------------------------------------------------------------
// identity <fileA> <fileB> <needle>
//   The LIVE-spec half of the coverage argument, made executable.
//
//   /api/openapi/openapi.json is served by backend/src/routes/openapi.ts from the
//   swagger-jsdoc module it imports; backend/scripts/export-openapi.ts writes the
//   checked-in artifact from the module IT imports. Those are the same module today,
//   which is the entire reason a diff of the exported artifact says anything at all
//   about what the running server serves. That is a load-bearing structural fact, so
//   it is asserted rather than written in a comment: resolve both import specifiers
//   and compare the real paths.
//
//   Fail-closed in every direction — a file with no matching import, more than one,
//   or a specifier that resolves to nothing, is a FINDING. If this guard can no
//   longer tell whether the two agree, it does not get to say they do.
// ---------------------------------------------------------------------------
function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, base + '.ts', path.join(base, 'index.ts')]) {
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch { /* try the next candidate */ }
  }
  return null;
}

function soleImport(file, needle) {
  const text = readText(file, 'identity');
  const hits = [];
  const re = /\bfrom\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1].includes(needle)) hits.push(m[1]);
  }
  const unique = [...new Set(hits)];
  if (unique.length !== 1) {
    die(`identity: ${file} has ${unique.length} distinct import(s) matching "${needle}" (expected exactly 1): ${JSON.stringify(unique)}`);
  }
  const resolved = resolveSpecifier(file, unique[0]);
  if (!resolved) die(`identity: ${file} imports "${unique[0]}" but that specifier resolves to no file on disk`);
  return { specifier: unique[0], resolved };
}

function cmdIdentity(fileA, fileB, needle) {
  const a = soleImport(fileA, needle);
  const b = soleImport(fileB, needle);
  if (a.resolved !== b.resolved) {
    die(
      'identity: FORKED — the exporter and the live route no longer read the same specification module.\n' +
      `  ${fileA}\n    imports "${a.specifier}" -> ${a.resolved}\n` +
      `  ${fileB}\n    imports "${b.specifier}" -> ${b.resolved}\n` +
      '  While these agreed, diffing the exported artifact also constrained what the\n' +
      '  running server serves. They no longer agree, so it does not.'
    );
  }
  process.stdout.write(`identity: OK — both read ${a.resolved}\n`);
  process.exit(0);
}

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case 'floor':
    if (args.length !== 2) die('usage: openapi-drift-compare.cjs floor <spec.json> <minPaths>');
    cmdFloor(args[0], args[1]);
    break;
  case 'spec':
    if (args.length !== 2) die('usage: openapi-drift-compare.cjs spec <before.json> <after.json>');
    cmdSpec(args[0], args[1]);
    break;
  case 'identity':
    if (args.length !== 3) die('usage: openapi-drift-compare.cjs identity <exporter.ts> <route.ts> <needle>');
    cmdIdentity(args[0], args[1], args[2]);
    break;
  default:
    die(`unknown subcommand "${cmd || '<none>'}" — expected: floor | spec | identity`);
}
