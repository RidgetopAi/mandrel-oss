/**
 * attributionNotice.unit.test.ts — the RENDERED STRING and the SUPPRESSION MAP, pinned.
 *
 * WHY THE EXACT WORDING IS ASSERTED AND NOT JUST "contains a warning": the wording is the
 * mechanism. The caller-identity echo we shipped in v0.57.0 was CORRECT and still failed the
 * customer, because his MCP client summarised the result — it kept the "Status: Operational"
 * headline and threw the identity line away. What survives a summariser is a line that reads
 * as an INSTRUCTION ADDRESSED TO THE AGENT ("RELAY THIS… DO NOT SUMMARIZE IT AWAY"), not one
 * that reads as status. So the imperative opener, the do-not-summarise clause, the concrete
 * header to set and the verification step are each load-bearing, and a test that only checked
 * for the word "anonymous" would go green on a message that gets dropped again.
 *
 * The suppression half is asserted at its boundaries — inside the window, exactly at the TTL,
 * and AT the key bound — because those are where an off-by-one shows up as either a silent
 * feature (never fires again) or an unbounded map in a long-lived server process.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renderAttributionNotice,
  renderConfiguredAttributionNotice,
  shouldNotice,
  markNoticed,
  attributionNoticeKey,
  __resetAttributionNoticeState,
  __attributionNoticeStateSize,
  ATTRIBUTION_ACTOR_PLACEHOLDER,
} from '../services/attributionNotice.js';
import {
  ATTRIBUTION_NOTICE_CONFIG,
  DEFAULT_ATTRIBUTION_SETUP_URL,
  DEFAULT_ATTRIBUTION_NOTICE_TTL_MS,
  DEFAULT_ATTRIBUTION_NOTICE_MAX_KEYS,
} from '../config/attributionNoticeConfig.js';

const SETUP = 'https://example.invalid/setup/actor/';

describe('renderAttributionNotice — the string is the mechanism', () => {
  test('GENERIC path: with no suggested actor it renders the <your-name> placeholder', () => {
    const msg = renderAttributionNotice({
      suggestedActor: null,
      setupUrl: SETUP,
      deadline: null,
    });

    // It must LEAD with an instruction to the agent, not with status prose.
    expect(msg.split('\n')[0]).toBe(
      '⚠️ ACTION REQUIRED — RELAY THIS TO YOUR USER, DO NOT SUMMARIZE IT AWAY:'
    );
    expect(msg).toContain('This write was attributed to "anonymous" because no X-Actor-ID header reached Mandrel.');
    expect(msg).toContain("this user's history cannot be told apart from anyone else's");
    expect(msg).toContain(`Fix: set the header  X-Actor-ID: ${ATTRIBUTION_ACTOR_PLACEHOLDER}`);
    expect(msg).toContain(`Setup instructions for your client: ${SETUP}`);
    // The verification step is what stops "I configured it" and "it works" being the same
    // sentence to the user — the original defect.
    expect(msg).toContain(
      `Verify with discover({action:'ping'}) — it must print  caller actor: ${ATTRIBUTION_ACTOR_PLACEHOLDER}`
    );
  });

  test('CONFIGURED path: a suggested actor replaces the placeholder EVERYWHERE it appears', () => {
    const msg = renderAttributionNotice({
      suggestedActor: 'contoso',
      setupUrl: SETUP,
      deadline: null,
    });
    expect(msg).toContain('X-Actor-ID: contoso');
    expect(msg).toContain('caller actor: contoso');
    // ANTI-VACUOUS: the placeholder must be GONE, not merely joined by the real name — a
    // half-substituted message tells the user to set a literal `<your-name>` header.
    expect(msg).not.toContain(ATTRIBUTION_ACTOR_PLACEHOLDER);
  });

  test('DEADLINE ABSENT: no deadline sentence is rendered at all (not an empty one)', () => {
    const msg = renderAttributionNotice({ suggestedActor: null, setupUrl: SETUP, deadline: null });
    expect(msg).not.toContain('will be REJECTED');
    expect(msg).not.toContain('From ');
  });

  test('DEADLINE PRESENT: one sentence, immediately after the unattributed line', () => {
    const msg = renderAttributionNotice({
      suggestedActor: null,
      setupUrl: SETUP,
      deadline: '2026-10-01',
    });
    expect(msg).toContain('From 2026-10-01, unattributed writes will be REJECTED.');
    const lines = msg.split('\n');
    const unattributed = lines.findIndex((l) => l.startsWith('Every record written from this client'));
    expect(unattributed).toBeGreaterThan(-1);
    expect(lines[unattributed + 1]).toBe('From 2026-10-01, unattributed writes will be REJECTED.');
    // …and it is ONE sentence, not a paragraph that pushes the fix out of view.
    expect(msg.match(/will be REJECTED/g)?.length).toBe(1);
  });

  test('renderConfiguredAttributionNotice reads the CONFIG, not its own literals', () => {
    const savedActor = ATTRIBUTION_NOTICE_CONFIG.suggestedActor;
    const savedUrl = ATTRIBUTION_NOTICE_CONFIG.setupUrl;
    try {
      ATTRIBUTION_NOTICE_CONFIG.suggestedActor = 'cfg-actor';
      ATTRIBUTION_NOTICE_CONFIG.setupUrl = 'https://cfg.invalid/x/';
      const msg = renderConfiguredAttributionNotice();
      expect(msg).toContain('X-Actor-ID: cfg-actor');
      expect(msg).toContain('https://cfg.invalid/x/');
    } finally {
      ATTRIBUTION_NOTICE_CONFIG.suggestedActor = savedActor;
      ATTRIBUTION_NOTICE_CONFIG.setupUrl = savedUrl;
    }
  });
});

describe('attributionNoticeConfig — the shipped defaults', () => {
  test('the default setup URL is empty — no host is baked into the product', () => {
    expect(DEFAULT_ATTRIBUTION_SETUP_URL).toBe('');
  });

  test('an empty setup URL omits the setup line; a set one renders it', () => {
    const none = renderAttributionNotice({ suggestedActor: null, setupUrl: '', deadline: null });
    expect(none).not.toContain('Setup instructions');
    expect(none).toContain('Fix: set the header');
    const some = renderAttributionNotice({ suggestedActor: null, setupUrl: SETUP, deadline: null });
    expect(some).toContain(`Setup instructions for your client: ${SETUP}`);
  });

  test('the shipped defaults are on, 6h, and bounded', () => {
    expect(DEFAULT_ATTRIBUTION_NOTICE_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_ATTRIBUTION_NOTICE_MAX_KEYS).toBe(5000); // reserved-port-ok: a suppression-map key CEILING, not a port — this file binds nothing
  });
});

/**
 * THE "" == UNSET CONTRACT — this is what docker-compose.prod file's declaration RIDES ON.
 *
 * Prod declares all six knobs inline with EMPTY values (an inline `environment:` entry is
 * what makes the key reach prod at all — a key declared only in the tenant compose never
 * does, which is the 2026-08-26 outage shape and is guarded by
 * prod-compose-render-equivalence.test script). Those empty strings are only safe
 * if the reader treats "" exactly as ABSENT. If it ever interpolated "" instead, prod would
 * ship a notice telling customers to set `X-Actor-ID: ` with no name, or a zero-ms TTL that
 * fires on every single write.
 *
 * So the compose comment's claim is asserted here rather than trusted: a fresh module load
 * with every knob set to "" must produce the SAME config as a fresh load with none set.
 */
describe('env reading — "" is UNSET, which is what the prod compose declaration depends on', () => {
  const KEYS = [
    'MANDREL_ATTRIBUTION_NOTICE_ENABLED',
    'MANDREL_ATTRIBUTION_SUGGESTED_ACTOR',
    'MANDREL_ATTRIBUTION_NOTICE_SETUP_URL',
    'MANDREL_ATTRIBUTION_NOTICE_DEADLINE',
    'MANDREL_ATTRIBUTION_NOTICE_TTL_MS',
    'MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS',
  ];

  /** Load the config module fresh under a given env, restoring env afterwards (leak guard). */
  async function loadUnder(env: Record<string, string | undefined>) {
    const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of KEYS) {
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      // The repo's fresh-load idiom (sessionResolverMode.unit.test.ts): resetModules, then a
      // PLAIN dynamic import. A `?cachebust` query is NOT the way — vite hands the query to
      // esbuild as a loader value and the import dies with "Invalid loader value".
      vi.resetModules();
      const mod = await import('../config/attributionNoticeConfig.js');
      return { ...mod.ATTRIBUTION_NOTICE_CONFIG };
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  }

  test('all six set to "" resolves identically to all six absent', async () => {
    const absent = await loadUnder({});
    const empty = await loadUnder(Object.fromEntries(KEYS.map((k) => [k, ''])));
    expect(empty).toEqual(absent);
    // …and that shared answer is the shipped default, not some third thing.
    expect(empty.enabled).toBe(true);
    expect(empty.suggestedActor).toBeNull();
    expect(empty.deadline).toBeNull();
    expect(empty.setupUrl).toBe(DEFAULT_ATTRIBUTION_SETUP_URL);
    expect(empty.ttlMs).toBe(DEFAULT_ATTRIBUTION_NOTICE_TTL_MS);
    expect(empty.maxKeys).toBe(DEFAULT_ATTRIBUTION_NOTICE_MAX_KEYS);
  });

  test('ANTI-VACUOUS: a real value IS read, so the test above is not passing on a dead reader', async () => {
    const set = await loadUnder({
      MANDREL_ATTRIBUTION_NOTICE_ENABLED: 'false',
      MANDREL_ATTRIBUTION_SUGGESTED_ACTOR: 'contoso',
      MANDREL_ATTRIBUTION_NOTICE_DEADLINE: '2026-10-01',
      MANDREL_ATTRIBUTION_NOTICE_TTL_MS: '1234',
      MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS: '7',
    });
    expect(set.enabled).toBe(false);
    expect(set.suggestedActor).toBe('contoso');
    expect(set.deadline).toBe('2026-10-01');
    expect(set.ttlMs).toBe(1234);
    expect(set.maxKeys).toBe(7);
  });

  test('garbage in a numeric knob falls back to the default rather than to 0', async () => {
    // A 0 TTL would fire the notice on EVERY write — the noise that teaches a client to
    // strip it, which is the failure this whole feature exists to avoid.
    const bad = await loadUnder({
      MANDREL_ATTRIBUTION_NOTICE_TTL_MS: 'soon',
      MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS: '0',
    });
    expect(bad.ttlMs).toBe(DEFAULT_ATTRIBUTION_NOTICE_TTL_MS);
    expect(bad.maxKeys).toBe(DEFAULT_ATTRIBUTION_NOTICE_MAX_KEYS);
  });
});

describe('suppression map — once per key per window, and BOUNDED', () => {
  const savedTtl = ATTRIBUTION_NOTICE_CONFIG.ttlMs;
  const savedMax = ATTRIBUTION_NOTICE_CONFIG.maxKeys;
  const savedEnabled = ATTRIBUTION_NOTICE_CONFIG.enabled;

  beforeEach(() => __resetAttributionNoticeState());
  afterEach(() => {
    ATTRIBUTION_NOTICE_CONFIG.ttlMs = savedTtl;
    ATTRIBUTION_NOTICE_CONFIG.maxKeys = savedMax;
    ATTRIBUTION_NOTICE_CONFIG.enabled = savedEnabled;
    __resetAttributionNoticeState();
  });

  test('a never-seen key fires; the same key inside the window does not', () => {
    ATTRIBUTION_NOTICE_CONFIG.ttlMs = 1000;
    const t0 = 1_000_000;
    expect(shouldNotice('conn-a', t0)).toBe(true);
    markNoticed('conn-a', t0);
    expect(shouldNotice('conn-a', t0)).toBe(false);
    expect(shouldNotice('conn-a', t0 + 999)).toBe(false);
  });

  test('a DIFFERENT key is unaffected by another key being suppressed', () => {
    ATTRIBUTION_NOTICE_CONFIG.ttlMs = 1000;
    markNoticed('conn-a', 0);
    expect(shouldNotice('conn-b', 0)).toBe(true);
  });

  test('it re-fires once the TTL has elapsed (boundary is inclusive)', () => {
    ATTRIBUTION_NOTICE_CONFIG.ttlMs = 1000;
    markNoticed('conn-a', 0);
    expect(shouldNotice('conn-a', 999)).toBe(false);
    expect(shouldNotice('conn-a', 1000)).toBe(true);
    expect(shouldNotice('conn-a', 5000)).toBe(true); // reserved-port-ok: an epoch-millisecond timestamp fed to a pure TTL predicate, not a port
  });

  test('the map is BOUNDED at maxKeys and evicts oldest-first', () => {
    ATTRIBUTION_NOTICE_CONFIG.maxKeys = 3;
    ATTRIBUTION_NOTICE_CONFIG.ttlMs = 1_000_000;
    markNoticed('k1', 1);
    markNoticed('k2', 2);
    markNoticed('k3', 3);
    expect(__attributionNoticeStateSize()).toBe(3);

    markNoticed('k4', 4);
    // The bound HOLDS — this is the assertion that stops an attacker-supplied connection id
    // from growing an unbounded map in a process that runs for weeks.
    expect(__attributionNoticeStateSize()).toBe(3);
    // …and it is the OLDEST that went, so the recently-warned stay suppressed.
    expect(shouldNotice('k1', 5)).toBe(true);   // evicted → would be told again
    expect(shouldNotice('k2', 5)).toBe(false);
    expect(shouldNotice('k4', 5)).toBe(false);
  });

  test('re-marking a key REFRESHES its position, so a busy caller is not evicted first', () => {
    ATTRIBUTION_NOTICE_CONFIG.maxKeys = 2;
    ATTRIBUTION_NOTICE_CONFIG.ttlMs = 10;
    markNoticed('old', 0);
    markNoticed('other', 1);
    markNoticed('old', 20);       // refresh — 'old' moves to the back
    markNoticed('new', 21);       // evicts the front, which is now 'other'
    expect(__attributionNoticeStateSize()).toBe(2);
    expect(shouldNotice('other', 22)).toBe(true);  // evicted
    expect(shouldNotice('old', 22)).toBe(false);   // survived
  });

  test('DISABLED means never — the kill switch beats an empty map', () => {
    ATTRIBUTION_NOTICE_CONFIG.enabled = false;
    expect(shouldNotice('brand-new-key', Date.now())).toBe(false);
  });

  test('the key falls back to the stdio slot when there is no connection id', () => {
    expect(attributionNoticeKey('conn-9')).toBe('conn-9');
    expect(attributionNoticeKey(undefined)).toBe('stdio');
    expect(attributionNoticeKey(null)).toBe('stdio');
  });
});
