/**
 * CREDENTIAL DETECTION — the vocabulary of structurally-identifiable credentials that must
 * never enter a stored record.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES. The
 * patterns a validator matches against are a tunable vocabulary — they live HERE as named
 * values with a stated justification, never as literals buried in a zod refinement. Mirrors
 * config/inputHygieneConfig.ts, config/fieldLimits.ts, config/edgeTypes.ts.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────────────────
 * Until this task, NOTHING in this repo had ever detected a credential in any stored field —
 * not `content`, not `metadata`, not `metadata.capture.evidence`, not `tags`. The scanner
 * that already existed (TOOL_CALL_ARTIFACT_SIGNATURES in config/inputHygieneConfig.ts)
 * detects LEAKED TOOL-CALL XML — seven structural wrapper tags from the 2026-07-17
 * degraded-client incident. That is a different problem and it is not secret-scanning.
 *
 * ── THE TRADE THIS FILE ENCODES (the operator, 2026-09-03) ────────────────────
 * HIGH-PRECISION ONLY. We detect a credential only where its STRUCTURE identifies it: a
 * recognizable provider token prefix, a PEM private-key header, or an `Authorization: Bearer`
 * header carrying a token-shaped value. We deliberately do NOT do entropy detection.
 *
 * WHY, stated so nobody re-litigates it: the highest-value field to scan
 * (`metadata.capture.evidence`) exists to hold PASTED COMMAND OUTPUT. Entropy detection fires
 * on git shas, uuids, base64 payloads and diff hunks — i.e. on normal evidence. A scanner
 * that cries wolf gets disabled or routed around, and then we have a guard that READS as
 * protection while providing none, which is worse than the honest zero we had. High precision
 * buys a detector that stays turned on.
 *
 * THE ACCEPTED MISS, named out loud: a bare hex/base64 blob with no structural marker is NOT
 * detected. A bare JWT with no `Authorization:` header in front of it is NOT detected. Those
 * are bought, on purpose, in exchange for the sentence above.
 *
 * ── 2026-09-08: the `NAME=<literal>` shape (audit finding E5) ──────
 * Both historical secret values found in the prod DB (SURVEYOR_LLM_API_KEY=…,
 * JWT_SECRET=…), the 2026-09-01 transcript leak (…_GROQ_API_KEY=gsk_…) and the one untriaged
 * task body were ALL `CREDENTIAL_NAME=value` lines out of env files — the one shape this
 * vocabulary did not have. It is added below as `env-assignment-literal`, plus `gsk_` (Groq)
 * and the SQL `PASSWORD '<literal>'` carrier that let an earlier commit's leaked password through.
 *
 * WHY THIS DOES NOT REOPEN THE EARLIER NO-ENTROPY RULING. Option (c) was rejected because ENTROPY fires
 * on legitimate evidence — shas, uuids, base64, diff hunks — regardless of what surrounds them.
 * The env-assignment rule reads NONE of the value's statistics. It is anchored on STRUCTURE the
 * writer supplied: an UPPER_SNAKE name whose last word is PASSWORD/SECRET/TOKEN/API_KEY/… and
 * an `=` immediately followed by a literal. A sha in `merged at 2b3c4d5e…` has no such name; a
 * uuid in `job 4d5e6f7a-… was dispatched` has no `=`; `token=3c4d5e6f…` (the accepted-miss
 * control) is lower-case and stays an accepted miss. What the rule fires on is a line whose
 * AUTHOR labelled the value a credential. `$VAR`, `${VAR}`, `<placeholder>`, `{{tpl}}`,
 * `***REDACTED***` and SCREAMING_SNAKE / your-*-here placeholders are not literals and are
 * exempt by charset or by the placeholder predicate. High precision is preserved; the
 * control set in credentialHygiene.unit.test.ts is where that claim is measured.
 *
 * ── WHY THIS SCAN IS NOT CODE-SPAN AWARE (it differs from the tool-XML scan on purpose) ───
 * `findArtifactSignatures` strips backticks/fences first, because a bug report legitimately
 * QUOTES a wrapper tag as documentation. A live credential has no such legitimate use: a
 * fence does not make a leaked token safe, and "paste it in a code block" would be an escape
 * hatch straight through the guard. So the credential scan reads the RAW string.
 *
 * The escape hatch that replaces it is structural, and it is why every pattern below requires
 * a plausible SECRET BODY and not just a prefix: you can write about `sk-ant-`, `ghp_`,
 * `AKIA` or `Authorization: Bearer <token>` all day, because a prefix with no body does not
 * match. We detect the VALUE, never the NAME of the thing. Documentation is unaffected;
 * pasting the actual secret is not.
 *
 * ── NEVER ECHO THE MATCH ──────────────────────────────────────────────────────────────────
 * the token never enters the transcript. A rejection message names the credential
 * KIND and the FIELD PATH — never the matched text, never a prefix of it. `label` below is
 * the entire vocabulary a caller ever sees.
 */

/** One structurally-identifiable credential shape. */
export interface CredentialSignature {
  /** Stable id, reported in rejection messages. Kebab-case, provider-scoped. */
  readonly id: string;
  /** One-line human phrase for the rejection message. Never contains a value. */
  readonly label: string;
  /**
   * The structural pattern. Every one REQUIRES a secret-body length, so a bare prefix
   * written as documentation does not match (see the escape-hatch note above).
   */
  readonly pattern: RegExp;
  /**
   * Optional capture-group index holding the secret BODY. When set, a body that matches
   * CREDENTIAL_PLACEHOLDER_PATTERN is not a finding — this is how `Bearer YOUR_TOKEN_HERE`
   * and `Bearer MCP_AUTH_TOKEN` stay storable while `Bearer <a real token>` does not.
   */
  readonly placeholderGroup?: number;
  /**
   * Optional ADDITIONAL placeholder vocabulary for this signature's body, tested alongside
   * CREDENTIAL_PLACEHOLDER_PATTERN (never instead of it). Only the assignment-shaped rules
   * use it: an env file's documented placeholder vocabulary (`your_password_here`,
   * `changeme`) is wider than a Bearer header's.
   */
  readonly extraPlaceholderPattern?: RegExp;
}

/**
 * A secret body that is SCREAMING_SNAKE_CASE is a placeholder or an env-var NAME, never a
 * live secret — no issuer emits an all-caps-and-underscores token. This is the predicate
 * that keeps our own documented recipes storable: `Authorization: Bearer $MCP_AUTH_TOKEN`
 * does not even reach it (`$` is outside the token charset), and a bare
 * `Authorization: Bearer REPLACE_WITH_YOUR_TOKEN` is exempted here.
 *
 * env: MANDREL_CREDENTIAL_PLACEHOLDER_PATTERN (a JS regex source, no delimiters/flags).
 */
export const CREDENTIAL_PLACEHOLDER_PATTERN: RegExp = parsePatternEnv(
  'MANDREL_CREDENTIAL_PLACEHOLDER_PATTERN',
  /^[A-Z0-9_]+$/,
);

/**
 * The ADDITIONAL placeholder vocabulary of the ASSIGNMENT-shaped signatures (`NAME=<body>`,
 * `PASSWORD '<body>'`), applied on top of CREDENTIAL_PLACEHOLDER_PATTERN (SCREAMING_SNAKE):
 * a body that BEGINS `your_` / `my-` / `replace_` / `change-` / `example.` / `sample_` /
 * `placeholder-` (any of `-_.` as the joiner), or is exactly `changeme`. Case-insensitive —
 * `Your-Password-Here` is still a placeholder. This is a SEPARATE pattern rather than an
 * `/i` on the shared one because an `/i` flag would turn `[A-Z0-9_]+` into "any word", which
 * exempts every lower-case secret (measured while writing this: it exempted the fixtures).
 * Mirrors the allowlist of the `mandrel-credential-env-assignment` gitleaks rule in
 * .gitleaks.toml so a line the pre-commit hook lets through is not then refused by Mandrel,
 * and vice versa. NOT exempt, on purpose: `DUMMY_*` and `throwaway_*` — those are literals;
 * a fixture that must be storable is assembled so it does not match.
 *
 * env: MANDREL_ENV_ASSIGNMENT_PLACEHOLDER_PATTERN (a JS regex source, no delimiters/flags).
 */
export const ENV_ASSIGNMENT_PLACEHOLDER_PATTERN: RegExp = parsePatternEnv(
  'MANDREL_ENV_ASSIGNMENT_PLACEHOLDER_PATTERN',
  /^(?:(?:your|my|replace|change|example|sample|placeholder)[-_.][^\s]*|changeme)$/i,
);

/**
 * THE VOCABULARY. Each entry is a shape whose STRUCTURE identifies it as a credential with
 * near-zero ambiguity. Extend HERE — never with a literal in a schema, and never with an
 * entropy heuristic (that is the rejected option (c) of an earlier decision).
 *
 * The bar for adding a row: could this pattern match a string a person would legitimately
 * paste as evidence? If yes, it does not belong here.
 */
export const CREDENTIAL_SIGNATURES: readonly CredentialSignature[] = [
  // ── PEM private keys ───────────────────────────────────────────────────────────────────
  // The armor header of a private key, in every variant OpenSSL/OpenSSH emits (RSA, DSA, EC,
  // OPENSSH, ENCRYPTED, PGP, or bare PKCS#8). Deliberately does NOT match `BEGIN CERTIFICATE`
  // or `BEGIN PUBLIC KEY` — a public half is not a secret and is pasted legitimately.
  {
    id: 'pem-private-key',
    label: 'a PEM private-key block',
    pattern: /-----BEGIN(?:[ \t]+[A-Z0-9]+)*[ \t]+PRIVATE KEY-----/,
  },

  // ── Authorization: Bearer <token-shaped value> ─────────────────────────────────────────
  // The header form, with a body long enough to be a real token. `<token>`, `$TOKEN` and
  // `${TOKEN}` cannot match (their characters are outside the charset); a SCREAMING_SNAKE
  // placeholder is exempted by placeholderGroup. Covers a pasted JWT, which is the common
  // real case, without claiming to detect a bare JWT out of context.
  {
    id: 'authorization-bearer',
    label: 'an Authorization: Bearer header carrying a token value',
    pattern: /\bauthorization\s*:\s*bearer\s+([A-Za-z0-9._~+/-]{20,}={0,2})/i,
    placeholderGroup: 1,
  },

  // ── Provider token prefixes ────────────────────────────────────────────────────────────
  // Anthropic. `sk-ant-` + a long body. The prefix alone (as written in this comment) does
  // not match.
  {
    id: 'anthropic-api-key',
    label: 'an Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}/,
  },
  // OpenAI, including the project/service-account forms. Negative lookahead on `ant-` so an
  // Anthropic key is reported under its own id rather than twice.
  {
    id: 'openai-api-key',
    label: 'an OpenAI API key',
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/,
  },
  // GitHub personal/OAuth/app/refresh tokens, and the fine-grained PAT form.
  {
    id: 'github-token',
    label: 'a GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/,
  },
  {
    id: 'github-fine-grained-pat',
    label: 'a GitHub fine-grained personal access token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  },
  {
    id: 'gitlab-token',
    label: 'a GitLab personal access token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}/,
  },
  // Slack bot/user/app/refresh tokens.
  {
    id: 'slack-token',
    label: 'a Slack token',
    pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}/,
  },
  // A Slack incoming-webhook URL is a bearer credential in URL form.
  {
    id: 'slack-webhook-url',
    label: 'a Slack incoming-webhook URL',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_/-]{20,}/,
  },
  // Stripe LIVE secret/restricted keys only. `sk_test_` is deliberately absent: test keys are
  // published in Stripe's own documentation and pasting one is not an incident.
  {
    id: 'stripe-live-key',
    label: 'a Stripe live secret key',
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/,
  },
  // AWS access key id — fixed 20-char shape, one of the least ambiguous strings there is.
  {
    id: 'aws-access-key-id',
    label: 'an AWS access key id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  },
  // Google/Firebase API key — fixed 39-char shape.
  {
    id: 'google-api-key',
    label: 'a Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'npm-token',
    label: 'an npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'pypi-token',
    label: 'a PyPI API token',
    pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{16,}/,
  },
  {
    id: 'huggingface-token',
    label: 'a Hugging Face access token',
    pattern: /\bhf_[A-Za-z0-9]{34,}/,
  },
  // Chat-bot token — `<numeric bot id>:AA<body>`. We run a chat alert path, so this
  // is a live exposure for us specifically, not a generic entry.
  {
    id: 'chat-bot-token',
    label: 'a chat-bot token',
    pattern: /\b[0-9]{8,12}:AA[A-Za-z0-9_-]{32,}/,
  },
  // Groq API key — `gsk_` + a long alphanumeric body. The 2026-09-01 transcript leak was a
  // MANDREL_BELIEF_GROQ_API_KEY=gsk_… line; this catches the value with or
  // without its NAME= in front.
  {
    id: 'groq-api-key',
    label: 'a Groq API key',
    pattern: /\bgsk_[A-Za-z0-9]{32,}/,
  },

  // ── Assignment-shaped literals (2026-09-08; see the header section of the same date) ───
  // `CREDENTIAL_NAME=<literal>`: an UPPER_SNAKE name ENDING in a credential word (so
  // `MANDREL_..._API_KEY_ENV=XAI_API_KEY`, a name used as a value, does not qualify), `=`,
  // an optional quote, then >= 12 chars of a password-shaped alphabet. The alphabet excludes
  // `$ < { * [ ( ` and whitespace, so `$VAR`, `${VAR}`, `<placeholder>`, `{{tpl}}`,
  // `***REDACTED***` and `[REDACTED …]` cannot match at all; SCREAMING_SNAKE and the
  // your_*-style placeholders are exempted through placeholderGroup. Case-SENSITIVE on the
  // name: `password=` in prose or a TS object key is not this shape (a case-insensitive
  // variant measured 375 findings on mandrel's own tree — noise, not shipped).
  // The regex is the same one .gitleaks.toml's `mandrel-credential-env-assignment` uses,
  // with the body floor raised from 6 to 12: a stored record is prose, and a 6-char body
  // (`PASS=secret`) is far likelier to be a sentence about a variable than a value.
  {
    id: 'env-assignment-literal',
    label: 'a credential-named env assignment with a literal value (NAME=value)',
    pattern:
      /(?:^|[\s'"({;&|=])(?:[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|AUTH)|(?:[A-Z][A-Z0-9_]*_)?(?:PASS|PWD|PW))=["']?([^\s"'`$<>{}[\]()*,;\\]{12,200})/,
    placeholderGroup: 1,
    extraPlaceholderPattern: ENV_ASSIGNMENT_PLACEHOLDER_PATTERN,
  },
  // SQL role password: `CREATE/ALTER ROLE|USER … PASSWORD '<literal>'` — the carrier of the
  // live postgres superuser password in an earlier commit (audit finding E4).
  // Keyword, whitespace, quote, then a body that does not begin with `$ < { *`. SQL is
  // case-insensitive, so this one is too — the keyword PASSWORD followed by a QUOTED value
  // is not a shape prose produces.
  {
    id: 'sql-password-literal',
    label: "a SQL role password literal (… PASSWORD '<value>')",
    pattern: /\b(?:PASSWORD|PASSWD)\s+['"]([^'"$<{*][^'"\s]{11,199})['"]/i,
    placeholderGroup: 1,
    extraPlaceholderPattern: ENV_ASSIGNMENT_PLACEHOLDER_PATTERN,
  },
];

/**
 * Maximum number of offending PATHS named in one rejection message, mirroring
 * METADATA_SCAN_MAX_REPORTED. The message is model-facing prose that has to stay readable.
 * env: MANDREL_CREDENTIAL_SCAN_MAX_REPORTED
 */
export const CREDENTIAL_SCAN_MAX_REPORTED: number = parseCountEnv(
  'MANDREL_CREDENTIAL_SCAN_MAX_REPORTED',
  5,
);

/** Parse a positive-integer env override; fall back on missing/blank/non-positive/NaN. */
function parseCountEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a regex-source env override. An UNPARSEABLE override falls back to the default rather
 * than throwing at import time — but note which way that fails: the placeholder pattern is an
 * EXEMPTION, so falling back to the stricter shipped default can only ever make the detector
 * fire MORE, never less. A bad override cannot silently open a hole.
 */
function parsePatternEnv(name: string, fallback: RegExp): RegExp {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  try {
    return new RegExp(raw.trim());
  } catch {
    return fallback;
  }
}
