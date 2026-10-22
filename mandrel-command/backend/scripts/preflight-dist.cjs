#!/usr/bin/env node
/**
 * preflight-dist.cjs — refuse to launch dist/ that was not built from this src/.
 *
 * WIRED AT: package.json "start" — `node scripts/preflight-dist.cjs && node dist/server.js`.
 * It is inline in the script (not a `prestart` hook) so `npm start --ignore-scripts`
 * cannot skip it, and it runs on EVERY container boot of every fleet instance.
 *
 * THE FAILURE IT DISARMS: dist/ is gitignored untracked box state that
 * no deploy path refreshes. `npm start` in a checkout whose dist/ is months old boots
 * old code that looks healthy. This turns that silent success into a loud exit 1.
 *
 * Exit codes: 0 = dist verified (or a legitimate sourceless image runtime).
 *             1 = refused. There is no third outcome — anything this cannot verify,
 *                 including its own unreadable manifest, is a refusal.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  MANIFEST_BASENAME,
  HASHED_DIRS,
  HASHED_ROOT_FILES,
  hashSources,
  manifestPath,
  readManifest,
} = require('./dist-manifest.cjs');

const BACKEND_DIR = path.resolve(__dirname, '..');
const ENTRY = path.join(BACKEND_DIR, 'dist', 'server.js');

function refuse(headline, detailLines) {
  const bar = '='.repeat(78);
  const out = [
    '',
    bar,
    'REFUSING TO START: ' + headline,
    bar,
    ...detailLines,
    '',
    'This check exists because dist/ is gitignored and no deploy path rebuilds it on a',
    'host, so a stale dist/ boots old code that looks healthy.',
    '',
    'To fix, from ' + BACKEND_DIR + ':',
    '    npm run build      # recompiles dist/ and rewrites dist/' + MANIFEST_BASENAME,
    '',
    'To run the current sources directly instead (this is what the systemd unit does):',
    '    npx tsx src/server.ts',
    bar,
    '',
  ].join('\n');
  process.stderr.write(out);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(ENTRY)) {
    refuse('dist/server.js does not exist.', [
      '  expected: ' + ENTRY,
      '  dist/ has never been built in this tree, or `npm run clean` removed it.',
    ]);
  }

  let manifest;
  try {
    manifest = readManifest(BACKEND_DIR);
  } catch (err) {
    refuse('dist/ carries no usable build manifest.', [
      '  ' + err.message,
      '',
      '  dist/server.js exists but was NOT produced by this repo\'s `npm run build`,',
      '  or predates the manifest entirely. Its provenance cannot be established, so',
      '  it is refused rather than trusted.',
    ]);
    return;
  }

  const hashed = hashSources(BACKEND_DIR);

  if (hashed === null) {
    // SOURCELESS RUNTIME. The runner image copies dist/ out of the builder stage and
    // ships no src/ and no tsconfig.json — there is nothing to compare against and the
    // manifest is the only provenance available. Legitimate, but only when the WHOLE
    // source tree is gone: a tree missing src/ while still carrying tsconfig.json is a
    // mangled checkout, not an image, and is refused.
    const strays = HASHED_ROOT_FILES.filter((f) => fs.existsSync(path.join(BACKEND_DIR, f)));
    if (strays.length > 0) {
      refuse('source tree is partially missing.', [
        '  absent:  ' + HASHED_DIRS.join(', ') + '/',
        '  present: ' + strays.join(', '),
        '',
        '  A sourceless runtime (the runner image) has NO source inputs at all. This',
        '  tree has some, so dist/ cannot be verified and is not assumed current.',
      ]);
    }
    process.stdout.write(
      'preflight-dist: sourceless runtime — dist/ built ' +
        manifest.builtAt +
        ' (srcHash ' +
        manifest.srcHash.slice(0, 16) +
        '…), no source tree to compare. OK\n'
    );
    return;
  }

  if (hashed.srcHash !== manifest.srcHash) {
    refuse('dist/ is STALE — it was not built from the sources in this tree.', [
      '  dist built at:   ' + manifest.builtAt,
      '  manifest srcHash: ' + manifest.srcHash,
      '  actual   srcHash: ' + hashed.srcHash,
      '  source files now: ' +
        hashed.fileCount +
        ' (manifest recorded ' +
        (manifest.fileCount ?? 'unknown') +
        ')',
      '',
      '  Starting anyway would serve compiled output of DIFFERENT source than what is',
      '  on disk here. That failure is silent by nature: the server boots and answers.',
    ]);
  }

  process.stdout.write(
    'preflight-dist: dist/ verified against ' +
      hashed.fileCount +
      ' source file(s) (srcHash ' +
      hashed.srcHash.slice(0, 16) +
      '…, built ' +
      manifest.builtAt +
      '). OK\n'
  );
}

main();
