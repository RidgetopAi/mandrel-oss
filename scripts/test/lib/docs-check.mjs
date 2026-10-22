// docs-check.mjs <repo-root> — the checks behind scripts/test/docs-manual.test.sh.
// Prints one "docs-check FAIL: ..." line per problem and exits 1; exits 0 when clean.
//   1. docs/manual/ has every chapter, and README.md links docs/manual/index.md
//   2. every relative Markdown link in a docs/**/*.md file (and README.md) resolves to an existing
//      file and, when it carries #anchor, to an existing heading in that file
//   3. every MANDREL_* name in a docs/**/*.md file appears in docs/reference/configuration.md (or in the
//      reasoned allow-list docs-non-server-settings.txt: installer and loop-CLI variables)
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const REFERENCE = 'docs/reference/configuration.md';
const CHAPTERS = ['index', 'install', 'connect-an-agent', 'concepts', 'everyday-use', 'supersession', 'operations'];
const fails = [];
const fail = (m) => fails.push(`docs-check FAIL: ${m}`);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') ? [p] : [];
  });
}
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

// Text with fenced code blocks removed (links and headings inside a fence are not real).
const stripFences = (text) => {
  let fenced = false;
  return text.split('\n').map((l) => (/^\s*(```|~~~)/.test(l) ? ((fenced = !fenced), '') : fenced ? '' : l)).join('\n');
};

// GitHub heading slug: lowercase, drop everything but letters/digits/space/hyphen/underscore, spaces -> hyphens.
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]*>/g, '').replace(/[`*_~]/g, (c) => (c === '_' ? '_' : ''))
  .replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const seen = new Map(); const out = new Set();
  for (const line of stripFences(fs.readFileSync(file, 'utf8')).split('\n')) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]); const n = seen.get(base) ?? 0;
    seen.set(base, n + 1); out.add(n === 0 ? base : `${base}-${n}`);
  }
  anchorCache.set(file, out);
  return out;
}

const docs = walk(path.join(root, 'docs'));
const readme = path.join(root, 'README.md');
const linkChecked = fs.existsSync(readme) ? [readme, ...docs] : docs;

// 1. chapters + README link
for (const c of CHAPTERS) if (!fs.existsSync(path.join(root, 'docs/manual', `${c}.md`))) fail(`docs/manual/${c}.md is missing`);
if (!fs.existsSync(readme) || !/\]\(docs\/manual\/index\.md\)/.test(fs.readFileSync(readme, 'utf8'))) fail('README.md does not link docs/manual/index.md');
if (!fs.existsSync(readme) || !/git clone https:\/\/github\.com\/[A-Za-z0-9-]+\/mandrel-oss\.git/.test(fs.readFileSync(readme, 'utf8'))) fail('README.md clone command does not name the mandrel-oss repository');

// 2. links
for (const file of linkChecked) {
  const text = stripFences(fs.readFileSync(file, 'utf8')).replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue; // http:, https:, mailto:, ...
    const [pathPart, rawAnchor] = [target.split('#')[0].split('?')[0], target.includes('#') ? target.slice(target.indexOf('#') + 1) : ''];
    const dest = pathPart === '' ? file : path.resolve(path.dirname(file), pathPart);
    if (!fs.existsSync(dest)) { fail(`${rel(file)} links missing file: ${target}`); continue; }
    if (rawAnchor && dest.endsWith('.md') && fs.statSync(dest).isFile() && !anchorsOf(dest).has(decodeURIComponent(rawAnchor).toLowerCase())) {
      fail(`${rel(file)} links missing heading anchor: ${target}`);
    }
  }
}

// 3. settings
const refFile = path.join(root, REFERENCE);
if (!fs.existsSync(refFile)) {
  fail(`${REFERENCE} is missing`);
} else {
  const known = new Set(fs.readFileSync(refFile, 'utf8').match(/MANDREL_[A-Z0-9_]*[A-Z0-9]/g) ?? []);
  const allowFile = path.join(path.dirname(new URL(import.meta.url).pathname), 'docs-non-server-settings.txt');
  for (const l of fs.readFileSync(allowFile, 'utf8').split('\n')) if (/^MANDREL_\w+\s*$/.test(l)) known.add(l.trim());
  for (const file of docs) {
    if (file === refFile) continue;
    const names = new Set(fs.readFileSync(file, 'utf8').match(/MANDREL_[A-Z0-9_]*[A-Z0-9]/g) ?? []);
    for (const n of [...names].sort()) if (!known.has(n)) fail(`${rel(file)} names ${n}, which is not in ${REFERENCE}`);
  }
}

if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
console.log(`docs-check: ok (${docs.length} docs under docs/, links and MANDREL_* settings verified)`);
