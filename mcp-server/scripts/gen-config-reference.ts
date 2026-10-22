/**
 * Settings-reference generator: reads every MANDREL_* setting that the env helpers
 * (envBool / envInt / envStr / envStrList / ...) read in src/config/*.ts and writes
 * docs/reference/configuration.md.
 *
 *   npm run docs:config           # (re)write the reference
 *   npm run docs:config -- --check  # exit 1 when the committed file differs from a fresh run
 *
 * WHAT COUNTS AS A SETTING: a call `env<Something>(<name>, ...)` whose first argument is a string
 * literal (or a top-level `const X = '...'` in the same file) starting with MANDREL_, plus every
 * name passed to `envIsSet(...)`. The description comes from the JSDoc (or, failing that, the
 * `//` comments) on the field the call initialises; internal ticket jargon is stripped.
 *
 * The reference is checked by src/tests/configReferenceDrift.unit.test.ts, which oss-gate.sh runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_ROOT = path.resolve(HERE, '..');
export const CONFIG_DIR = path.join(MCP_ROOT, 'src', 'config');
export const REFERENCE_PATH = path.resolve(MCP_ROOT, '..', 'docs', 'reference', 'configuration.md');

/** Longest description we print, in characters (whole sentences are kept until this is hit). */
export const DESCRIPTION_MAX_CHARS = 330;
/** Most sentences kept from a field's doc comment. */
export const DESCRIPTION_MAX_SENTENCES = 1;

/** Hand-written descriptions for settings whose source comment is written for developers. */
export const OVERRIDES_PATH = path.join(HERE, 'config-reference-descriptions.json');

function loadOverrides(): Record<string, string> {
  return fs.existsSync(OVERRIDES_PATH) ? (JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')) as Record<string, string>) : {};
}

export type SettingType = 'boolean' | 'integer' | 'number' | 'string' | 'list' | 'enum';

export interface Setting {
  name: string;
  module: string; // file name inside src/config
  helper: string;
  type: SettingType;
  allowed: string[]; // enum values, when known
  defaultText: string;
  description: string;
  rawDoc: string; // source comment before cleaning (internal)
}

/**
 * Module -> section heading. A config module that declares a setting but is missing here makes the
 * generator throw, so a new module cannot ship undocumented by accident.
 */
export const MODULE_SECTIONS: Record<string, string> = {
  'beliefConfig.ts': 'Supersession (belief)',
  'beliefCostConfig.ts': 'Supersession (belief)',
  'supersessionGuardConfig.ts': 'Supersession (belief)',
  'hybridSearchConfig.ts': 'Recall & search',
  'lexicalSearchConfig.ts': 'Recall & search',
  'rankingConfig.ts': 'Recall & search',
  'recallConfig.ts': 'Recall & search',
  'altitudeConfig.ts': 'Recall & search',
  'recordHeadlineConfig.ts': 'Recall & search',
  'trustConfig.ts': 'Trust & project health',
  'currentStateConfig.ts': 'Trust & project health',
  'coverageConfig.ts': 'Trust & project health',
  'provenanceConfig.ts': 'Trust & project health',
  'briefingConfig.ts': 'Briefing & handoff',
  'briefingAltitudeConfig.ts': 'Briefing & handoff',
  'blockedOnConfig.ts': 'Briefing & handoff',
  'handoffLaneConfig.ts': 'Briefing & handoff',
  'handoffHeadConfig.ts': 'Briefing & handoff',
  'handoffCarriedFieldsConfig.ts': 'Briefing & handoff',
  'sessionConfig.ts': 'Sessions & identity',
  'sessionIdentityConfig.ts': 'Sessions & identity',
  'attributionNoticeConfig.ts': 'Sessions & identity',
  'projectEchoConfig.ts': 'Sessions & identity',
  'betterAuthConfig.ts': 'Server & auth',
  'oauthClientConfig.ts': 'Server & auth',
  'toolSurfaceConfig.ts': 'Server & auth',
  'fieldLimits.ts': 'Server & auth',
  'embeddingConfig.ts': 'Embeddings',
  'resilienceConfig.ts': 'Embeddings',
  'reliableThreadingConfig.ts': 'Threads, links & graph',
  'autoThreadConfig.ts': 'Threads, links & graph',
  'threadConfig.ts': 'Threads, links & graph',
  'threadTerminalityConfig.ts': 'Threads, links & graph',
  'declaredLimbsConfig.ts': 'Threads, links & graph',
  'membershipMoveConfig.ts': 'Threads, links & graph',
  'branchHistoryConfig.ts': 'Threads, links & graph',
  'graphBackfillConfig.ts': 'Threads, links & graph',
  'tagEdgeConfig.ts': 'Threads, links & graph',
  'artifactRefConfig.ts': 'Threads, links & graph',
  'claimConfig.ts': 'Tasks',
  'taskLifecycleConfig.ts': 'Tasks',
};

/** Section order in the document; sections not listed sort alphabetically after these. */
export const SECTION_ORDER: string[] = [
  'Supersession (belief)',
  'Recall & search',
  'Trust & project health',
  'Briefing & handoff',
  'Sessions & identity',
  'Server & auth',
  'Embeddings',
  'Threads, links & graph',
  'Tasks',
];

/**
 * Settings that are free text to the code but take a fixed set of values in practice (the value is
 * matched in a switch elsewhere). Listed here so the reference can show the choices.
 */
export const ALLOWED_VALUES: Record<string, string[]> = {
  MANDREL_BELIEF_ADJUDICATOR_PROVIDER: ['anthropic', 'openai-compat', 'ollama', 'subq', 'tiered'],
  MANDREL_BELIEF_TIER1_PROVIDER: ['openai-compat', 'anthropic', 'ollama', 'subq'],
  MANDREL_BELIEF_TIER2_PROVIDER: ['anthropic', 'openai-compat', 'ollama', 'subq'],
  MANDREL_EMBEDDER: ['minilm', 'gemma'],
  MANDREL_BACKWARD_SOFT_UNDECIDED_POLICY: ['honor', 'suppress'],
  MANDREL_CURRENT_STATE_NODE_ALTITUDE: ['headline', 'summary', 'full'],
  MANDREL_SMART_SEARCH_DEFAULT_ALTITUDE: ['headline', 'summary', 'full'],
  MANDREL_RECALL_DEFAULT_FORMAT: ['concise', 'detailed'],
};

/** Type column text for settings whose helper name does not say what they accept. */
export const TYPE_LABELS: Record<string, string> = {
  MANDREL_CURRENT_STATE_TRUST_FLOOR: 'trust band name or number 0-1',
  MANDREL_INSIGHTS_TRUST_FLOOR: 'trust band name or number 0-1',
};

/** Curated 'Most people only need these' table: name -> one-line "why you would touch it". */
export const ESSENTIALS: Array<{ name: string; why: string }> = [
  { name: 'MANDREL_BELIEF_ENABLED', why: 'Turns supersession detection on or off. When on, newly stored records are compared with their nearest neighbours and outdated ones are linked as superseded.' },
  { name: 'MANDREL_BELIEF_ADJUDICATOR_PROVIDER', why: 'Which model service judges supersession. Unset (the default), the mode follows the keys you set: `SUBQ_API_KEY` and `ANTHROPIC_API_KEY` together give `tiered`, `SUBQ_API_KEY` alone gives `subq`, `ANTHROPIC_API_KEY` alone gives `anthropic`, neither leaves supersession off. Setting this always wins over the keys. Use `tiered` for a cheap first pass (tier 1) confirmed by a stronger model (tier 2), or a single provider: `anthropic`, `openai-compat` (Groq, llama.cpp), `ollama` (local) or `subq`.' },
  { name: 'MANDREL_BELIEF_ADJUDICATOR_MODEL', why: 'Model name for a single (non-tiered) provider (default `claude-sonnet-5`, or `subq-snap-preview` when the provider is `subq`).' },
  { name: 'MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV', why: 'Name of the environment variable that holds the API key for a single provider (default `ANTHROPIC_API_KEY`, or `SUBQ_API_KEY` when the provider is `subq`). Set that variable to your key.' },
  { name: 'MANDREL_BELIEF_TIER1_PROVIDER', why: 'Tiered mode: the cheap first-pass provider (default `subq`, SubQ Snap; set `openai-compat` for Groq).' },
  { name: 'MANDREL_BELIEF_TIER1_MODEL', why: 'Tiered mode: the first-pass model (default `subq-snap-preview`; `openai/gpt-oss-120b` with the `openai-compat` provider).' },
  { name: 'MANDREL_BELIEF_TIER1_API_KEY_ENV', why: 'Tiered mode: name of the variable holding the first-pass key (default `SUBQ_API_KEY`; `GROQ_API_KEY` with the `openai-compat` provider).' },
  { name: 'MANDREL_BELIEF_TIER2_PROVIDER', why: 'Tiered mode: the stronger confirming provider.' },
  { name: 'MANDREL_BELIEF_TIER2_MODEL', why: 'Tiered mode: the confirming model.' },
  { name: 'MANDREL_BELIEF_TIER2_API_KEY_ENV', why: 'Tiered mode: name of the variable holding the confirming key (default `ANTHROPIC_API_KEY`).' },
  { name: 'MANDREL_BELIEF_COST_ALERT_USD_PER_DAY', why: 'Daily spend (USD) above which the cost report raises a loud alert.' },
  { name: 'MANDREL_BELIEF_DAILY_SPEND_CAP_USD', why: 'Hard daily spend cap (USD, UTC day) on paid supersession calls; default `2`, `0` = no cap. Writes never fail; capped pairs are skipped.' },
  { name: 'MANDREL_EMBEDDER', why: 'Which embedding model builds the search index.' },
  { name: 'MANDREL_OLLAMA_ENDPOINT', why: 'Where your Ollama server listens, if you use Ollama for embeddings or supersession.' },
  { name: 'MANDREL_SESSION_RESOLVER_MODE', why: 'How sessions are matched to callers. Move from `legacy` to `shadow` to `actor` once clients send an actor id.' },
  { name: 'MANDREL_SESSION_REQUIRE_ACTOR', why: 'Reject writes that do not say who is writing, instead of recording them as anonymous.' },
  { name: 'MANDREL_OAUTH_ENABLED', why: 'Turns on the built-in OAuth server so web clients can connect without the static bearer token.' },
  { name: 'MANDREL_TASK_CLAIM_ENABLED', why: 'Lets workers claim a task with a lease so two workers do not take the same one.' },
];

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

const NAME_RE = /^MANDREL_[A-Z0-9_]+$/;

function helperType(helper: string, defaultNode: ts.Expression | undefined): SettingType {
  const h = helper.slice(3).toLowerCase();
  if (h.startsWith('bool')) return 'boolean';
  if (h === 'strlist' || h === 'list' || h === 'csv') return 'list';
  if (h.startsWith('enum') || h === 'format' || h === 'undecidedpolicy' || h === 'altitude' || h === 'contentaltitude') return 'enum';
  if (/^(int|posint|nonneginteger|nonnegint|quota|rank)/.test(h)) return 'integer';
  if (/^(float|num|unit|trustfloor|positive)/.test(h)) return 'number';
  if (h.startsWith('str') || h.startsWith('nonempty') || h === 'pattern') return 'string';
  if (defaultNode) {
    if (defaultNode.kind === ts.SyntaxKind.TrueKeyword || defaultNode.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
    if (ts.isNumericLiteral(defaultNode)) return Number.isInteger(Number(defaultNode.text)) ? 'integer' : 'number';
  }
  return 'string';
}

function topLevelConsts(sf: ts.SourceFile): Map<string, ts.Expression> {
  const m = new Map<string, ts.Expression>();
  sf.forEachChild((c) => {
    if (!ts.isVariableStatement(c)) return;
    for (const d of c.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) m.set(d.name.text, d.initializer);
    }
  });
  return m;
}

function resolveExpr(e: ts.Expression, consts: Map<string, ts.Expression>, depth = 0): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isCallExpression(cur) && cur.expression.getText() === 'Object.freeze' && cur.arguments.length === 1) cur = cur.arguments[0];
    else break;
  }
  if (ts.isIdentifier(cur) && depth < 4) {
    const target = consts.get(cur.text);
    if (target) return resolveExpr(target, consts, depth + 1);
  }
  return cur;
}

function literalString(e: ts.Expression, consts: Map<string, ts.Expression>): string | undefined {
  const r = resolveExpr(e, consts);
  return ts.isStringLiteralLike(r) ? r.text : undefined;
}

function stringArray(e: ts.Expression | undefined, consts: Map<string, ts.Expression>): string[] | undefined {
  if (!e) return undefined;
  const r = resolveExpr(e, consts);
  if (!ts.isArrayLiteralExpression(r)) return undefined;
  const out: string[] = [];
  for (const el of r.elements) {
    const s = ts.isExpression(el) ? literalString(el, consts) : undefined;
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}

/** Defaults too long to read in a table cell are summarised; the source holds the full text. */
export const DEFAULT_MAX_CHARS = 60;
function shortenDefault(text: string): string {
  if (text.length <= DEFAULT_MAX_CHARS) return text;
  return text.includes(', ') ? `(built-in list of ${text.split(', ').length})` : '(built-in text)';
}

function renderDefault(name: string, e: ts.Expression | undefined, consts: Map<string, ts.Expression>, sf: ts.SourceFile): string {
  if (!e) return '(none)';
  const r = resolveExpr(e, consts);
  if (ts.isStringLiteralLike(r) && r.text.includes('\u0000')) {
    // A NUL-prefixed sentinel means "not set"; the real default is the file's NAME_DEFAULT list.
    const real = consts.get(`${name.replace(/^MANDREL_/, '')}_DEFAULT`);
    const items = real ? stringArray(real, consts) : undefined;
    return items ? items.join(', ') : '(built-in list)';
  }
  if (ts.isStringLiteralLike(r)) return r.text === '' ? '(empty)' : r.text;
  if (r.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (r.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (r.kind === ts.SyntaxKind.NullKeyword) return '(unset)';
  if (ts.isNumericLiteral(r)) return r.text;
  if (ts.isPrefixUnaryExpression(r) && ts.isNumericLiteral(r.operand)) return r.getText(sf);
  if (ts.isArrayLiteralExpression(r)) {
    const items = stringArray(r, consts);
    if (items) return items.length === 0 ? '(empty list)' : items.join(', ');
  }
  const text = r.getText(sf).replace(/\s+/g, ' ');
  // Pure arithmetic such as `24 * 60 * 60 * 1000`: show the number it comes to.
  if (/^[\d\s*+\-/().]+$/.test(text)) {
    const n = Function(`"use strict"; return (${text});`)() as unknown;
    if (typeof n === 'number' && Number.isFinite(n)) return String(n);
  }
  if (/NODE_ENV\s*===\s*'production'/.test(text)) return 'true when NODE_ENV=production, otherwise false';
  if (ts.isBinaryExpression(r) || ts.isCallExpression(r) && /\.join$/.test(r.expression.getText(sf))) return '(built-in text)';
  if (ts.isNoSubstitutionTemplateLiteral(r) || ts.isTemplateExpression(r)) return '(built-in text)';
  // Anything else is computed from other values (another setting, a shared constant).
  return '(derived from other settings)';
}

/** Every JSDoc block in the file, with the MANDREL_* names it mentions. */
function jsDocIndex(sf: ts.SourceFile): Array<{ text: string; names: string[]; envNames: string[] }> {
  const text = sf.getFullText();
  const out: Array<{ text: string; names: string[]; envNames: string[] }> = [];
  for (const m of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const body = m[0].replace(/^\/\*\*/, '').replace(/\*\/$/, '').replace(/^\s*\* ?/gm, '');
    const names = [...new Set(body.match(/MANDREL_[A-Z0-9_]+/g) ?? [])];
    const envNames = [...body.matchAll(/\bEnv(?: for [^:]*)?:\s*(MANDREL_[A-Z0-9_]+)/g)].map((x) => x[1]);
    if (names.length > 0) out.push({ text: body, names, envNames });
  }
  return out;
}

/** The comment text attached to the nearest ancestor that has one (JSDoc first, then `//` lines). */
function docFor(node: ts.Node, sf: ts.SourceFile): string {
  const text = sf.getFullText();
  for (let p: ts.Node | undefined = node; p && p.kind !== ts.SyntaxKind.SourceFile; p = p.parent) {
    const docs = (p as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
    if (docs && docs.length > 0) {
      const d = docs[docs.length - 1];
      const comment = text.slice(d.getStart(sf), d.getEnd());
      return comment.replace(/^\/\*\*/, '').replace(/\*\/$/, '').replace(/^\s*\* ?/gm, '');
    }
    const ranges = ts.getLeadingCommentRanges(text, p.getFullStart()) ?? [];
    const lines = ranges.filter((r) => r.kind === ts.SyntaxKind.SingleLineCommentTrivia);
    if (lines.length > 0 && (ts.isPropertyAssignment(p) || ts.isVariableStatement(p) || ts.isShorthandPropertyAssignment(p))) {
      // contiguous run of `//` lines directly above the field
      return lines.map((r) => text.slice(r.pos, r.end).replace(/^\/\/ ?/, '')).join(' ');
    }
  }
  return '';
}

/** Fragments cut out of a sentence before it is judged (ticket ids, section marks, name boilerplate). */
const STRIP_FRAGMENTS: RegExp[] = [
  /\(?\b(?:task|decision|milestone|lesson|punch|bug|finding|survey|spec)s?\s+#?[0-9a-f]{8}\b[^.;)]*\)?/gi,
  /\(?§\s?[\d.]+[^)]*\)?/g,
  /\(\s*env:[^)]*\)\.?/gi,
  /\benv:\s*MANDREL_[A-Z0-9_]+\.?/gi,
  /\bEnv(?: prefix)?:\s*MANDREL_[A-Z0-9_*]+(?:\s*\([^)]*\))?\.?/g,
];

/**
 * Text that means a sentence is written for the people who build Mandrel, not for the person
 * configuring it: ticket-style ids, source file names, code identifiers, internal measurements.
 * A description is cut BEFORE the first such sentence; if the very first sentence has one, the
 * setting needs an entry in config-reference-descriptions.json.
 */
export const JARGON_RE = new RegExp(
  [
    '\\.(?:ts|sh|md)\\b', // source file names
    '\\(\\)', // function calls
    '\\b[A-Z]{1,3}-?\\d+(?:\\.\\d+)?[a-z]?\\b', // BL-9, SK5, P5.1, D2
    '\\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8}\\b', // hex ids
    '\\bLesson\\b|\\bspec\\b|\\bBUILD\\b|\\bWS\\d\\b|\\bBreak-\\d\\b',
    '^WHY\\b|\\bWHY\\b|^NOTE\\b|^MEASURED\\b|\\bmeasured\\b|\\bMeasured\\b',
    '^THE LIVE CONFIG|^MUTABLE ON PURPOSE|^Functions, not consts',
    '\\b[Ww]e\\b|\\b[Oo]ur\\b|\\bus\\b|^THE\\b|Stage-\\d|\\bInc(?:rement|-)|[≥≤→]|\\bCoT\\b|load-bearing|\\bsingle-sourced\\b',
    '\\bDARK\\b|\\bkill-switch\\b|\\bphase\\b|\\bPhase\\b',
  ].join('|'),
);

function looksBroken(sentence: string): boolean {
  const opens = (sentence.match(/\(/g) ?? []).length;
  const closes = (sentence.match(/\)/g) ?? []).length;
  return opens !== closes || /[,:;(]\.?$/.test(sentence.trim()) || sentence.trim().length < 12;
}

/** Why a finished description is not fit to print, or null when it is. */
export function descriptionProblem(d: string): string | null {
  if (d === '') return 'empty';
  if (d.length > DESCRIPTION_MAX_CHARS + 60) return `longer than ${DESCRIPTION_MAX_CHARS + 60} characters`;
  const m = JARGON_RE.exec(d);
  if (m) return `contains internal wording "${m[0]}"`;
  if (looksBroken(d)) return 'looks truncated';
  return null;
}

/** Boilerplate sentences that only repeat what the table columns already say. */
function isBoilerplate(sentence: string): boolean {
  const s = sentence.trim();
  return /^(?:Env|Default|Defaults|DEFAULT)\b/.test(s) || /^MANDREL_[A-Z0-9_]+\b/.test(s) || /^See\b/.test(s) || s === '';
}

/** All-caps words that really are acronyms; every other SHOUTED word is lowercased. */
const SHOUTED_ACRONYMS = new Set(['HTTP', 'HTTPS', 'JSON', 'UTC', 'SQL', 'CSV', 'NODE']);

/** Developer spellings -> words: CONSTANT_NAMES, snake_case and camelCase become plain text. */
function plainIdentifiers(t: string, known: ReadonlySet<string>): string {
  return t
    .replace(/\b(?!MANDREL_)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (m) =>
      known.has(`MANDREL_${m}`) ? `MANDREL_${m}` : m.toLowerCase().replace(/_/g, ' '),
    )
    .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (m) => m.replace(/_/g, ' '))
    .replace(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g, (m) => m.replace(/([A-Z])/g, ' $1').toLowerCase());
}

export function cleanDescription(raw: string, known: ReadonlySet<string> = new Set()): string {
  let t = raw
    .replace(/@\w+[^\n]*/g, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const re of STRIP_FRAGMENTS) t = t.replace(re, ' ');
  t = t.replace(/\bEnv(?: for [^:]*)?:\s*[^.]*\./g, ' ');
  // a leading "field_name — " / "fieldName - " label is for developers
  t = t.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s+[—–-]\s+/, '');
  t = t.replace(/\bDefaults?:?\s+[^.]*(?:\.\d+[^.]*)*\./gi, ' ');
  t = plainIdentifiers(t, known);
  t = t.replace(/\b[A-Z]{4,}\b/g, (w) => (SHOUTED_ACRONYMS.has(w) ? w : w.toLowerCase()));
  t = t.replace(/([.!?]),/g, '$1');
  t = t.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
  if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z'"(])/).filter((s) => !isBoilerplate(s));
  const out: string[] = [];
  let len = 0;
  for (const s of sentences) {
    if (out.length >= DESCRIPTION_MAX_SENTENCES) break;
    if (JARGON_RE.test(s) || looksBroken(s)) break;
    if (out.length > 0 && len + s.length > DESCRIPTION_MAX_CHARS) break;
    out.push(s.trim());
    len += s.length + 1;
  }
  let d = out.join(' ').replace(/^[\s\-–—:;,]+/, '').trim();
  if (d.length > 0 && !/[.!?]$/.test(d)) d += '.';
  return d;
}

export function collectSettings(configDir: string = CONFIG_DIR): Setting[] {
  const found = new Map<string, Setting>();
  const files = fs.readdirSync(configDir).filter((f) => f.endsWith('.ts')).sort();
  for (const file of files) {
    const src = fs.readFileSync(path.join(configDir, file), 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
    const consts = topLevelConsts(sf);
    const docIndex = jsDocIndex(sf);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^env[A-Z]/.test(node.expression.text)) {
        const helper = node.expression.text;
        const isSetOnly = helper === 'envIsSet';
        const nameArgs = isSetOnly ? [...node.arguments] : node.arguments.slice(0, 1);
        for (const a of nameArgs) {
          const name = literalString(a, consts);
          if (!name || !NAME_RE.test(name)) continue;
          const args = [...node.arguments];
          const defaultNode = isSetOnly ? undefined : args[args.length - 1];
          const enumNode = helper === 'envEnum' ? args[1] : undefined;
          let allowed = stringArray(enumNode, consts) ?? [];
          // A block that says "Env: <this name>" documents this very setting (often on the config
          // interface rather than at the call); next best is the comment on the field itself.
          const named = docIndex.find((d) => d.envNames.includes(name) && d.envNames.length === 1);
          const doc = named ? named.text : docFor(node, sf);
          const prev = found.get(name);
          // envIsSet only asks "was this set?" — it never defines a setting, so it must not win.
          if (prev && (isSetOnly || prev.helper !== 'envIsSet')) {
            if (prev.rawDoc === '' && doc !== '') prev.rawDoc = doc;
            continue;
          }
          if (isSetOnly) allowed = [];
          else if (ALLOWED_VALUES[name]) allowed = ALLOWED_VALUES[name];
          found.set(name, {
            name,
            module: file,
            helper,
            type: isSetOnly ? 'string' : helperType(helper, defaultNode),
            allowed,
            defaultText: isSetOnly ? '(none)' : shortenDefault(renderDefault(name, defaultNode, consts, sf)),
            description: '',
            rawDoc: doc,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const list = [...found.values()];
  const known = new Set(found.keys());
  for (const s of list) s.description = cleanDescription(s.rawDoc, known);
  // One comment documenting a whole group of settings says nothing about any single one of them.
  const uses = new Map<string, number>();
  for (const s of list) uses.set(s.description, (uses.get(s.description) ?? 0) + 1);
  for (const s of list) if ((uses.get(s.description) ?? 0) > 2) s.description = '';
  const overrides = loadOverrides();
  for (const name of Object.keys(overrides)) {
    if (!found.has(name)) throw new Error(`${OVERRIDES_PATH} describes ${name}, which is not a setting in src/config — remove it`);
  }
  for (const s of list) if (overrides[s.name] !== undefined) s.description = overrides[s.name];
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function codeCell(s: string): string {
  return s.includes('`') || s.startsWith('(') ? cell(s) : '`' + cell(s) + '`';
}

export function renderReference(settings: Setting[]): string {
  const bySection = new Map<string, Setting[]>();
  for (const s of settings) {
    const section = MODULE_SECTIONS[s.module];
    if (!section) throw new Error(`config module ${s.module} (setting ${s.name}) has no section in MODULE_SECTIONS`);
    const arr = bySection.get(section) ?? [];
    arr.push(s);
    bySection.set(section, arr);
  }
  const sections = [...bySection.keys()].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || a.localeCompare(b);
  });
  const byName = new Map(settings.map((s) => [s.name, s]));
  const typeCell = (s: Setting): string => TYPE_LABELS[s.name] ?? (s.allowed.length > 0 ? `one of ${s.allowed.join(' \\| ')}` : s.type);

  const out: string[] = [];
  out.push('# Configuration reference');
  out.push('');
  out.push('<!-- GENERATED FILE — do not edit. Regenerate with `npm run docs:config` (in mcp-server/). -->');
  out.push('');
  out.push(`This page lists all ${settings.length} \`MANDREL_*\` settings the Mandrel server reads.`);
  out.push('');
  out.push('## How to set a setting');
  out.push('');
  out.push('Every setting is an environment variable. Set it in either place:');
  out.push('');
  out.push('- **A `.env` file** (`mcp-server/.env`, or `config/environments/.env.<NODE_ENV>`; start from `.env.example` in the repository root) with lines such as `MANDREL_BELIEF_ENABLED=true`.');
  out.push('- **The process environment** — `export MANDREL_BELIEF_ENABLED=true` in your shell, an `environment:` entry in `docker-compose.yml`, or your service manager.');
  out.push('');
  out.push('Values already in the process environment win over the `.env` file. Restart the server after a change. A value that cannot be parsed (for example text where a number is expected) is ignored and the default is used.');
  out.push('Booleans take `true` or `false` (most also accept `1`/`0`, `yes`/`no`, `on`/`off`). List settings take comma-separated values.');
  out.push('');
  out.push('## Most people only need these');
  out.push('');
  out.push('| Setting | Type | Default | Why you would set it |');
  out.push('| --- | --- | --- | --- |');
  for (const e of ESSENTIALS) {
    const s = byName.get(e.name);
    if (!s) throw new Error(`ESSENTIALS names ${e.name}, which is not a setting in src/config`);
    out.push(`| \`${s.name}\` | ${typeCell(s)} | ${codeCell(s.defaultText)} | ${cell(e.why)} |`);
  }
  out.push('');
  out.push('## All settings');
  out.push('');
  out.push(sections.map((sec) => `[${sec}](#${slug(sec)})`).join(' · '));
  for (const sec of sections) {
    out.push('');
    out.push(`### ${sec}`);
    out.push('');
    out.push('| Setting | Type | Default | Description |');
    out.push('| --- | --- | --- | --- |');
    for (const s of bySection.get(sec) ?? []) {
      out.push(`| \`${s.name}\` | ${typeCell(s)} | ${codeCell(s.defaultText)} | ${cell(s.description)} |`);
    }
  }
  out.push('');
  return out.join('\n');
}

function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
}

/** Settings whose description is empty or not fit to print, with the reason. */
export function unfitDescriptions(settings: Setting[]): Array<{ name: string; reason: string }> {
  const out: Array<{ name: string; reason: string }> = [];
  for (const s of settings) {
    const reason = descriptionProblem(s.description);
    if (reason) out.push({ name: s.name, reason });
  }
  return out;
}

export function generateReference(): string {
  const settings = collectSettings();
  const unfit = unfitDescriptions(settings);
  if (unfit.length > 0) {
    throw new Error(
      `${unfit.length} setting(s) have no user-facing description. Write the comment above the field in plain words, ` +
        `or add an entry to scripts/config-reference-descriptions.json:\n` +
        unfit.map((u) => `  ${u.name}: ${u.reason}`).join('\n'),
    );
  }
  return renderReference(settings);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fresh = generateReference();
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(REFERENCE_PATH) ? fs.readFileSync(REFERENCE_PATH, 'utf8') : '';
    if (committed !== fresh) {
      console.error('docs/reference/configuration.md is out of date — run `npm run docs:config` in mcp-server/.');
      process.exit(1);
    }
    console.log('docs/reference/configuration.md is up to date.');
  } else {
    fs.mkdirSync(path.dirname(REFERENCE_PATH), { recursive: true });
    fs.writeFileSync(REFERENCE_PATH, fresh);
    console.log(`wrote ${path.relative(process.cwd(), REFERENCE_PATH)}`);
  }
}
