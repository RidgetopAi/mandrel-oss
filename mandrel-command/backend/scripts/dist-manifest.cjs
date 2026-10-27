/**
 * dist-manifest.cjs — the single definition of "is dist/ built from this src/?"
 *
 * WHY THIS EXISTS
 * -------------------------------
 * package.json declares `"start": "node dist/server.js"`. dist/ is gitignored, so it
 * is untracked BOX STATE that no deploy path refreshes: an image-based deploy never runs
 * `npm run build` on a host, so a host's dist/ can be months older than its src/, and a
 * `npm start` there boots old code that looks like it works. Nothing warned.
 *
 * A mtime comparison was the obvious instrument and is the wrong one: `git checkout`
 * rewrites src mtimes without changing content, so mtime produces false alarms, and a
 * stray `touch dist/**` produces false silence. This hashes CONTENT instead.
 *
 * `npm run build` writes dist/.build-manifest.json; `npm start` refuses to launch
 * unless it verifies. Both directions read this file, so they cannot disagree.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_BASENAME = '.build-manifest.json';
const MANIFEST_VERSION = 1;

/** Every input whose content changes the compiler's output. */
const HASHED_ROOT_FILES = ['tsconfig.json'];
const HASHED_DIRS = ['src'];

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Enumerate the hashed source inputs relative to backendDir, sorted, POSIX-separated.
 * Returns null when the source tree is ABSENT — a distinct third state from "empty",
 * because a sourceless runtime (the runner image, which copies dist/ and no src/) is
 * legitimate while an empty src/ is not.
 */
function collectSourceFiles(backendDir) {
  const present = HASHED_DIRS.filter((d) => fs.existsSync(path.join(backendDir, d)));
  if (present.length === 0) return null;

  const files = [];
  for (const d of present) walk(path.join(backendDir, d), backendDir, files);
  for (const f of HASHED_ROOT_FILES) {
    if (fs.existsSync(path.join(backendDir, f))) files.push(f);
  }
  return files.sort();
}

/** sha256 over (relative path, byte length, bytes) of every source input. */
function hashSources(backendDir) {
  const files = collectSourceFiles(backendDir);
  if (files === null) return null;

  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(backendDir, rel));
    h.update(rel, 'utf8');
    h.update('\0');
    h.update(String(bytes.length), 'utf8');
    h.update('\0');
    h.update(bytes);
    h.update('\0');
  }
  return { srcHash: h.digest('hex'), fileCount: files.length };
}

function manifestPath(backendDir) {
  return path.join(backendDir, 'dist', MANIFEST_BASENAME);
}

/**
 * Read the manifest. Throws on absent/unparseable/wrong-shape — a manifest we cannot
 * READ is never a manifest we may IGNORE (C1: could-not-measure is not a pass).
 */
function readManifest(backendDir) {
  const p = manifestPath(backendDir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`no build manifest at ${p} (${err.code || err.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`build manifest at ${p} is not valid JSON: ${err.message}`);
  }
  if (
    !parsed ||
    parsed.manifestVersion !== MANIFEST_VERSION ||
    typeof parsed.srcHash !== 'string' ||
    parsed.srcHash.length === 0
  ) {
    throw new Error(`build manifest at ${p} has an unrecognised shape`);
  }
  return parsed;
}

function writeManifest(backendDir) {
  const hashed = hashSources(backendDir);
  if (hashed === null) {
    throw new Error(
      `cannot build a manifest: no source tree (${HASHED_DIRS.join(', ')}) under ${backendDir}`
    );
  }
  const distDir = path.join(backendDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    srcHash: hashed.srcHash,
    fileCount: hashed.fileCount,
    builtAt: new Date().toISOString(),
    generator: 'mandrel-command/backend/scripts/dist-manifest.cjs',
  };
  fs.writeFileSync(manifestPath(backendDir), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = {
  MANIFEST_BASENAME,
  MANIFEST_VERSION,
  HASHED_DIRS,
  HASHED_ROOT_FILES,
  collectSourceFiles,
  hashSources,
  manifestPath,
  readManifest,
  writeManifest,
};

if (require.main === module) {
  const backendDir = path.resolve(__dirname, '..');
  const m = writeManifest(backendDir);
  process.stdout.write(
    `build manifest: ${m.fileCount} source file(s), srcHash ${m.srcHash.slice(0, 16)}…\n`
  );
}
