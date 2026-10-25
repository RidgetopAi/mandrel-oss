/**
 * CREDENTIAL FIXTURES — shared by credentialHygiene.unit.test.ts (the JS detector) and
 * credentialSweep.contract.test.ts (its SQL twins in a scheduled SQL sweep).
 *
 * ONE population, two consumers, so the two vocabularies are measured against the SAME
 * strings: a shape the JS detector refuses that the SQL sweep would not count (or the other
 * way round) is a RED in the contract test, not a silent drift.
 *
 * ── NO REAL CREDENTIAL APPEARS IN THIS FILE ───────────────────────────────────────────────
 * Every positive is ASSEMBLED AT RUNTIME from a prefix plus a repeated-character body
 * (`'ghp_' + 'A'.repeat(36)`), or is DUMMY_-prefixed with such a body. The value is obviously
 * synthetic to any reader, and no token-shaped literal is committed for a secret scanner (or
 * a human skimming a diff) to trip over. credentialHygiene.unit.test.ts asserts the property.
 */

// ── SYNTHETIC POSITIVES ───────────────────────────────────────────────────────────────────
// Keyed by signature id. Assembled from parts; the bodies are runs of a repeated character so
// no fixture can be mistaken for, or reused as, a real secret.
export const body = (n: number, ch = 'A') => ch.repeat(n);
/**
 * `NAME=value`, assembled so the SOURCE never contains a credential name adjacent to `=`.
 * The repo's own gitleaks rule (mandrel-credential-env-assignment) reads this file too, and a
 * literal `SURVEYOR_LLM_API_KEY=DUMMY_…` in a fixture is exactly what it exists to block —
 * measured 2026-09-08: 7 findings blocked the commit of the first draft. Same move as the
 * {EQ} token in scripts/test/gitleaks-credential-shapes.test.sh.
 */
export const assign = (name: string, value: string, quote = '') => `${name}${'='}${quote}${value}${quote}`;

export const SYNTHETIC: Readonly<Record<string, string>> = {
  // The PEM armor line is SPLIT across concatenation on purpose: written as one literal it
  // trips the repo's gitleaks pre-commit hook (RuleID `private-key`), which is the hook doing
  // its job — the tree must not carry a private-key header even in a fixture with no key
  // material behind it. Assembling it here means the DETECTOR still sees the exact armor line.
  'pem-private-key': `${'-----BEGIN'} RSA ${'PRIVATE'} KEY-----\n${body(64, 'b')}\n-----END RSA ${'PRIVATE'} KEY-----`,
  'authorization-bearer': `Authorization: Bearer ${'sYnthetic'}${body(20, 'q')}1234`,
  'anthropic-api-key': `sk-ant-${'api03-'}${body(40, 'z')}`,
  'openai-api-key': `sk-${'proj-'}${body(40, 'y')}`,
  'github-token': `${'ghp'}_${body(36, 'C')}`,
  'github-fine-grained-pat': `${'github'}_pat_${body(48, 'D')}`,
  'gitlab-token': `${'glpat'}-${body(24, 'E')}`,
  'slack-token': `${'xoxb'}-${body(12, '1')}-${body(12, '2')}`,
  'slack-webhook-url': `https://hooks.slack.com/services/T${body(12, 'F')}/B${body(12, 'G')}/${body(12, 'H')}`,
  'stripe-live-key': `${'sk'}_live_${body(24, 'J')}`,
  'aws-access-key-id': `AKIA${body(16, 'K')}`,
  'google-api-key': `AIza${body(35, 'L')}`,
  'npm-token': `${'npm'}_${body(36, 'M')}`,
  'pypi-token': `${'pypi'}-AgEIcHlwaS5vcmc${body(24, 'N')}`,
  'huggingface-token': `${'hf'}_${body(36, 'P')}`,
  'chat-bot-token': `1234567890:AA${body(34, 'R')}`,
  'groq-api-key': `${'gsk'}_${body(40, 'W')}`,
  // The two assignment shapes. DUMMY_-prefixed so no reader mistakes them; the repeated-char
  // body is what keeps them out of the placeholder predicate AND out of any real keyspace.
  // Lower-case bodies: an all-caps body would be SCREAMING_SNAKE and therefore a placeholder.
  'env-assignment-literal': assign('SURVEYOR_LLM_API_KEY', `DUMMY_${body(24, 'x')}`),
  'sql-password-literal': `ALTER USER postgres ${'PASSWORD'} 'DUMMY_${body(12, 'y')}';`,
};

// ── THE HISTORICAL BODIES, BY SHAPE (an earlier task / audit finding E5) ──────────────────
// The two values scrubbed from prod on 2026-09-08, the 2026-09-01 transcript
// leak, the untriaged task row and the leaked-password commit carrier — each recreated as
// its SHAPE with a DUMMY body, never the value. Every one of these must now be REFUSED.
export const HISTORICAL_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
  ['completion body (SURVEYOR_LLM_API_KEY=…, 2026-01-26)',
    `deployed with ${assign('SURVEYOR_LLM_API_KEY', `DUMMY_${body(20, 'a')}1`)} in /etc/surveyor.env`, 'env-assignment-literal'],
  ['error body (JWT_SECRET=…, 2025-09-18)',
    `env dump:\n${assign('JWT_SECRET', `DUMMY_${body(28, 'b')}`)}\nPORT=8080`, 'env-assignment-literal'],
  ['transcript leak (MANDREL_BELIEF_GROQ_API_KEY=gsk_…, 2026-09-01)',
    assign('MANDREL_BELIEF_GROQ_API_KEY', `gsk_${body(40, 'c')}`), 'groq-api-key'],
  ['task body (PASSWORD= + 20 chars, 2026-07-22)',
    `compose env had ${assign('POSTGRES_PASSWORD', `DUMMY_${body(14, 'd')}`)} set`, 'env-assignment-literal'],
  ['leaked-password commit carrier (ALTER USER postgres PASSWORD \'<12 chars>\')',
    `sudo -u postgres psql -c "ALTER USER postgres ${'PASSWORD'} 'DUMMY_${body(12, 'e')}';"`, 'sql-password-literal'],
  ['compose mapping written as an assignment in evidence',
    `docker-compose.yml: ${assign('MINIO_ROOT_PASSWORD', `DUMMY_${body(16, 'f')}`, '"')}`, 'env-assignment-literal'],
];

/** One representative refusal, used wherever a test just needs "a credential". */
export const CREDENTIAL = SYNTHETIC['aws-access-key-id'];

// ── THE CONTROL SET: what a Mandrel record legitimately holds ─────────────────────────────
// Real shapes from real evidence blocks. Every one of these MUST still store.
export const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['vitest output', '$ npx vitest run\n Test Files  270 passed (270)\n      Tests  3532 passed (3532)\n  exit 0'],
  ['a git sha (40 hex)', 'merged at 00b940bdc1e2f3a4b5c6d7e8f90112233445566a on main'],
  ['a short sha + git log line', 'ffe8f00d Merge fix-0a21d: attribute the write, do not infer it'],
  ['a uuid', 'record 1c0af00d-8885-421a-b580-5e09381369a9 was dispatched'],
  ['several uuids in a row', '6a1cf00d-0278-4c44-9e01-9e56a374c48c e59ff00d-0e7a-4714-98f7-5999a7d09e34'],
  ['a docker image digest', 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['a base64 payload', 'echo -n hello | base64 -> aGVsbG8= ; longer: ' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk='],
  ['a bare hex blob (the ACCEPTED MISS, asserted so the trade is visible)', 'token=' + 'a3f9'.repeat(16)],
  ['a diff hunk', '@@ -12,7 +12,9 @@ export function walk(\n-  const x = 1;\n+  const x = 2;\n+  const y: Map<string, T> = new Map();'],
  ['an npm/pnpm lock integrity line', 'integrity sha512-' + 'Xy9'.repeat(20) + '=='],
  ['a PUBLIC key block', '-----BEGIN PUBLIC KEY-----\n' + body(64, 'w') + '\n-----END PUBLIC KEY-----'],
  ['a TLS certificate block', '-----BEGIN CERTIFICATE-----\n' + body(64, 'v') + '\n-----END CERTIFICATE-----'],
  ['an ssh public key line', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI' + body(30, 'T') + ' coordinator@dev-host'],
  ['a bearer header with a shell variable', 'curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://mandrel.example.com/mcp/tools/mandrel_ping'],
  ['a bearer header with a braced shell variable', 'curl -H "Authorization: Bearer ${MCP_AUTH_TOKEN}" ...'],
  ['a bearer header with an angle-bracket placeholder', 'send `Authorization: Bearer <token>` or the call is rejected 401'],
  ['a bearer header with a SCREAMING_SNAKE placeholder', 'Authorization: Bearer REPLACE_WITH_YOUR_ACCESS_TOKEN'],
  ['an env var NAME being checked without printing it', 'verified with [ -n "$MCP_AUTH_TOKEN" ] — never printed the value'],
  ['prose naming provider prefixes with no bodies', 'we match sk-ant-, ghp_, glpat-, AKIA, AIza and npm_ prefixes; a prefix alone is fine'],
  ['a secrets file path + key name (no value)', 'MCP_AUTH_TOKEN lives in /etc/app/prod/secrets.env (mode 600)'],
  ['an AWS ARN and bucket URL', 'arn:aws:s3:::mandrel-backups/2026-09-03.tar.gz via https://s3.eu-central-1.amazonaws.com/mandrel-backups'],
  ['a package name that starts like a token', 'installed npm_config_cache and scikit-learn (sk-learn) without incident'],
  ['a long log line with angle brackets', "awk '{ if ($1 < 10 && $2 > 3) print }' /var/log/mandrel-mcp.log | head -50"],
  ['a jest/vitest snapshot blob', 'exports[`renders 1`] = `<div class="x">' + body(40, 'u') + '</div>`;'],
  ['a stripe TEST key (published in Stripe docs, deliberately not matched)', 'sk_test_' + body(24, 'S')],
  ['an ISO timestamp series', '2026-09-03T11:35:44.396Z 2026-08-26T22:49:56.280Z 2026-08-21T00:00:00.000Z'],
  ['a mermaid diagram', 'graph TD;\n  A[roots] --> B[trunk];\n  B --> C{branch};'],
  ['a postgres connection string with no password', 'psql postgres://mandrel@192.0.2.11:5432/mandrel'],
  ['a JWT with no Authorization header (the second ACCEPTED MISS)', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', ''].join('.') + body(32, 'k')],
  // ── the NAME=value shape's own controls (2026-09-08) — a sentence ABOUT a variable stores ──
  ['an env NAME= with a <placeholder>', 'set DATABASE_PASSWORD=<your-db-password> in /etc/app/prod/secrets.env'],
  ['an env NAME= with a bare shell expansion', 'the unit passes DATABASE_PASSWORD=$DATABASE_PASSWORD through to the container'],
  ['an env NAME= with a braced shell expansion', 'DATABASE_PASSWORD=${DATABASE_PASSWORD:?unset} fails loud when unset'],
  ['an env NAME= with a SCREAMING_SNAKE placeholder', 'MCP_AUTH_TOKEN=REPLACE_WITH_YOUR_TOKEN is what .env.example ships'],
  ['an env NAME= with a documented your_ placeholder', 'DB_PASSWORD=your_password_here (from the README quick start)'],
  ['an env NAME= with changeme', 'PGPASSWORD=changeme is the compose default we tell people to change'],
  ['an env NAME= whose value is the redaction marker', "[PASS] guard went RED - 'POSTGRES_PASSWORD=***REDACTED***' is gone"],
  ['an env NAME= whose value is a bracketed redaction', `${assign('JWT_SECRET', '[REDACTED 2026-09-08 realign]')} (scrubbed in place)`],
  ['an env NAME= with an empty value', 'MCP_AUTH_TOKEN= was blank in the failing unit, which is the bug'],
  ['an env NAME= with a short value (under the 12-char floor)', `${assign('PASS', 'secret')} is the word count of the summary line, not a credential`],
  ['a lower-case password= key in a TS object', "const cfg = { password: 'not_upper_snake_so_not_this_shape' };"],
  ['a credential NAME used as a VALUE', 'MANDREL_BELIEF_API_KEY_ENV=XAI_API_KEY selects which key the belief layer reads'],
  ['a NAME whose last word is not a credential word', 'BYPASS=rotate_me_now_88213 and MANDREL_SESSION_REQUIRE_ACTOR=true_and_verified'],
  ['a SQL PASSWORD with a shell expansion', "psql -c \"ALTER ROLE \\\"$role\\\" PASSWORD '$NEW_PW';\" rotates it under scram"],
  ['a SQL PASSWORD with a <placeholder>', "CREATE ROLE app LOGIN PASSWORD '<strong-password>'; -- from the README"],
  ['a SQL PASSWORD with the redaction marker', "ALTER ROLE mandrel PASSWORD '***REDACTED***'; (from the rotation log)"],
  ['prose naming the env-assignment rule with no literal', 'the detector now catches NAME=value where NAME ends in PASSWORD, SECRET, TOKEN or API_KEY'],
  ['a Groq prefix with no body', 'Groq keys start with gsk_ and are 56 chars; ours lives in /etc/app/belief.env'],
];

