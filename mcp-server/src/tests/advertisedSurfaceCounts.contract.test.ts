/**
 * advertisedSurfaceCounts.contract.test.ts — the surface-aware header guard.
 *
 * THE BUG CLASS THIS LOCKS SHUT
 * ─────────────────────────────
 * `mandrel_help` announced the FLAT catalog size on EVERY surface: "54 Tools Available Across 10
 * Categories". Under MANDREL_TOOL_SURFACE=gateway the client's `tools/list` holds ~11 tools (the
 * gateway envelopes + the flat headline tools), so an agent orienting itself was told it had ~54
 * tools while holding 11 — a candidate contributor to the measured 67% gateway first-call success.
 * `discover.catalog`, the gateway front door, stated no size at all.
 *
 * The failure MODE is what matters: a COUNT that is stated rather than measured drifts the moment
 * the thing it counts changes. Our own CLAUDE.md carried a hand-copied "52", then "54", while live
 * was 57. A fix that swaps one stale literal for two fresh literals is the same bug with a longer
 * fuse.
 *
 * WHY THESE TESTS CANNOT PASS AGAINST A HARDCODED COUNT
 * ─────────────────────────────────────────────────────
 * They never assert today's numbers. Each teeth-test REPLACES the live source with a FIXTURE
 * surface of a known, deliberately-unusual size, then asserts the rendered header carries THAT
 * fixture's numbers — and it does this with TWO fixtures of DIFFERENT sizes, so the header's
 * numbers must MOVE. A literal (any literal — 54, 11, 62, or a fresh pair) is a constant; a
 * constant cannot equal both fixtures. This is the a past incident rule-8 discipline: the expected
 * values are written LITERALLY here, computed by hand from the fixture, never read back out of the
 * product — a guard that reads the product's own count could not detect a change to it.
 *
 * Fixture sizes are also chosen so no two numbers in an assertion coincide, so a header that SWAPS
 * the two numbers ("3 operations across 7 tools") fails just as loudly as one that invents them.
 *
 * COVERAGE
 *   T1  gateway  — header numbers follow fixture A, then fixture B (mandrel_help AND discover.catalog)
 *   T2  legacy   — the historical one-number header, numbers follow two different fixture registries
 *   T3  legacy   — the header string shape is byte-for-byte what it always was (no accidental reword)
 *   T4  gateway  — the two INDEPENDENT derivations of the operation count agree (counter vs catalog)
 *   T5  both     — the machine channel carries the same measured numbers as the human channel
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

/** Flatten a tool response's text channel. */
function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/**
 * A FIXTURE advertised surface: a set of gateway names with a known action count each, plus a set
 * of flat tools (one operation apiece). `expected` is written out BY HAND below, never derived from
 * the product — that is what gives these tests teeth.
 */
interface SurfaceFixture {
  gateways: Record<string, string[]>;
  flats: string[];
}

/** Install `fixture` as the live gateway surface, then import the handlers fresh against it. */
async function withGatewayFixture(fixture: SurfaceFixture) {
  const toolNames = [...Object.keys(fixture.gateways), ...fixture.flats];

  vi.stubEnv('MANDREL_TOOL_SURFACE', 'gateway');
  vi.resetModules();

  // The array `tools/list` serves. Shape only matters through `.name` for counting.
  vi.doMock('../config/gatewaySurface.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
      ...actual,
      buildGatewaySurface: () =>
        toolNames.map((name) => ({
          name,
          description: `fixture ${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
    };
  });

  // What each advertised tool fans out to. Unknown names return [] so the catalog body — which
  // walks the REAL gateway order — renders empty rather than resolving phantom ops.
  vi.doMock('../config/gatewayResolver.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
      ...actual,
      isGatewayName: (name: string) => name in fixture.gateways,
      actionsForGateway: (name: string) => fixture.gateways[name] ?? [],
    };
  });

  const { navigationHandler } = await import('../handlers/navigation.js');
  // Reach the catalog through the REAL routed entry point a gateway `tools/call` takes
  // (executeMcpTool → dispatchGateway → dispatchDiscover), not just the leaf handler — the
  // header has to be right on the path an agent actually hits.
  const { dispatchGateway } = await import('../routes/gateway.js');
  return {
    help: await navigationHandler.getHelp(),
    catalog: await dispatchGateway('discover', { action: 'catalog' }),
  };
}

/** Install a fixture FLAT registry (the legacy surface) and import mandrel_help fresh against it. */
async function withLegacyFixture(categories: Record<string, string[]>) {
  const order = Object.keys(categories);
  const names = order.flatMap((c) => categories[c]);

  vi.stubEnv('MANDREL_TOOL_SURFACE', 'legacy');
  vi.resetModules();

  vi.doMock('../config/toolDefinitions.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
      ...actual,
      AIDIS_TOOL_DEFINITIONS: names.map((name) => ({
        name,
        description: `fixture ${name}`,
        inputSchema: { type: 'object', properties: {} },
      })),
      CATEGORY_ORDER: order,
      TOOL_CATEGORIES: categories,
      categoryForTool: (name: string) => order.find((c) => categories[c].includes(name)),
    };
  });

  const { navigationHandler } = await import('../handlers/navigation.js');
  return await navigationHandler.getHelp();
}

afterEach(() => {
  vi.doUnmock('../config/gatewaySurface.js');
  vi.doUnmock('../config/gatewayResolver.js');
  vi.doUnmock('../config/toolDefinitions.js');
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('advertised-surface counts are MEASURED, never stated', () => {
  // ── T1: gateway header numbers follow the fixture, and MOVE when it changes ──────────────
  //
  // Fixture A: 2 gateways (4 + 2 actions) + 1 flat  → 7 operations across 3 tools
  // Fixture B: 3 gateways (5 + 3 + 2 actions) + 2 flats → 12 operations across 5 tools
  // No number repeats within a fixture, so a swapped pair is as visible as an invented one.
  const FIXTURE_A: SurfaceFixture = {
    gateways: { fixgw_alpha: ['a1', 'a2', 'a3', 'a4'], fixgw_beta: ['b1', 'b2'] },
    flats: ['fixflat_one'],
  };
  const FIXTURE_B: SurfaceFixture = {
    gateways: {
      fixgw_alpha: ['a1', 'a2', 'a3', 'a4', 'a5'],
      fixgw_beta: ['b1', 'b2', 'b3'],
      fixgw_gamma: ['g1', 'g2'],
    },
    flats: ['fixflat_one', 'fixflat_two'],
  };

  test('T1a: gateway mandrel_help + discover.catalog report FIXTURE A (7 ops / 3 tools)', async () => {
    const { help, catalog } = await withGatewayFixture(FIXTURE_A);

    expect(textOf(help)).toContain('**7 operations across 3 tools:**');
    expect(textOf(catalog)).toContain('— 7 operations across 3 tools');

    // The legacy phrasing must NOT appear on the gateway surface — that IS the reported bug.
    expect(textOf(help)).not.toMatch(/Tools Available Across \d+ Categories/);
  });

  test('T1b: the SAME headers report FIXTURE B (12 ops / 5 tools) — the numbers move', async () => {
    const { help, catalog } = await withGatewayFixture(FIXTURE_B);

    expect(textOf(help)).toContain('**12 operations across 5 tools:**');
    expect(textOf(catalog)).toContain('— 12 operations across 5 tools');

    // Belt and braces: fixture A's numbers must be GONE. A header that cached, hardcoded, or
    // otherwise froze a count would still be showing them.
    expect(textOf(help)).not.toContain('7 operations across 3 tools');
    expect(textOf(catalog)).not.toContain('7 operations across 3 tools');
  });

  // ── T2: legacy header numbers follow a fixture registry too ──────────────────────────────
  test('T2: legacy mandrel_help counts follow the fixture registry, and move', async () => {
    // 2 categories, 3 + 2 tools → "5 Tools Available Across 2 Categories"
    const first = await withLegacyFixture({
      'Fixture Alpha': ['fix_a1', 'fix_a2', 'fix_a3'],
      'Fixture Beta': ['fix_b1', 'fix_b2'],
    });
    expect(textOf(first)).toContain('**5 Tools Available Across 2 Categories:**');

    vi.doUnmock('../config/toolDefinitions.js');

    // 3 categories, 4 + 2 + 1 tools → "7 Tools Available Across 3 Categories"
    const second = await withLegacyFixture({
      'Fixture Alpha': ['fix_a1', 'fix_a2', 'fix_a3', 'fix_a4'],
      'Fixture Beta': ['fix_b1', 'fix_b2'],
      'Fixture Gamma': ['fix_c1'],
    });
    expect(textOf(second)).toContain('**7 Tools Available Across 3 Categories:**');
    expect(textOf(second)).not.toContain('5 Tools Available Across 2 Categories');
  });

  // ── T3: the legacy header wording is UNCHANGED by this task ──────────────────────────────
  test('T3: legacy mandrel_help keeps its historical header, on the real registry', async () => {
    vi.stubEnv('MANDREL_TOOL_SURFACE', 'legacy');
    vi.resetModules();
    const { navigationHandler } = await import('../handlers/navigation.js');
    const { AIDIS_TOOL_DEFINITIONS, CATEGORY_ORDER } = await import('../config/toolDefinitions.js');
    const text = textOf(await navigationHandler.getHelp());

    // Exact historical shape — a reword of the legacy surface is a REGRESSION, not a refactor.
    const header = text.match(/\*\*(\d+) Tools Available Across (\d+) Categories:\*\*/);
    expect(header, 'legacy header must be byte-for-byte what it always was').toBeTruthy();
    expect(Number(header![1])).toBe(AIDIS_TOOL_DEFINITIONS.length);
    expect(Number(header![2])).toBe(CATEGORY_ORDER.length);
    // …and the gateway framing must not leak onto legacy.
    expect(text).not.toContain('operations across');
    // Per-category lines keep the legacy noun.
    expect(text).toMatch(/^## .+ \(\d+ tools\)$/m);
  });

  // ── T4: two INDEPENDENT derivations of the operation count agree ──────────────────────────
  //
  // countAdvertisedSurface walks the advertised tools/list array; discover.catalog walks
  // GATEWAY_ORDER + FLAT_OP_IDS. Different traversals of the same registry — if they ever
  // disagree, one of them has stopped describing the real surface.
  test('T4: the counter and the catalog agree on the gateway operation count', async () => {
    vi.stubEnv('MANDREL_TOOL_SURFACE', 'gateway');
    vi.resetModules();
    const { countAdvertisedSurface } = await import('../config/advertisedSurface.js');
    const { dispatchGateway } = await import('../routes/gateway.js');

    const { describeAdvertisedSurface } = await import('../config/advertisedSurface.js');
    const counts = countAdvertisedSurface();
    const catalog: any = await dispatchGateway('discover', { action: 'catalog' });

    expect(counts.surface).toBe('gateway');
    expect(counts.operations).toBe(catalog.structuredContent.totalActions);
    // The RENDERED sentence on the REAL surface, not just the numbers behind it (Reviewer nit 2).
    // T1a/T1b prove the numbers are derived; this proves the derived sentence actually reaches the
    // text an agent reads, on the real registry.
    expect(textOf(catalog)).toContain(describeAdvertisedSurface(counts));
    // Sanity that the fixture-free run is meaningful at all: a gateway surface fans out, so it
    // must expose strictly more operations than it advertises tools.
    expect(counts.operations).toBeGreaterThan(counts.tools);
    expect(counts.tools).toBeGreaterThan(0);
  });

  // ── T6: the BODY mandrel_help renders must add up to the number its HEADER claims ────────
  //
  // The Reviewer finding on 22c79e9. The header counted the ADVERTISED surface (62 operations)
  // while the body enumerated the FLAT catalog (60 entries) — two honest-looking derivations of
  // the same fact that disagreed by exactly the `session_pin` fan-out (one flat entry, three
  // gateway actions). A header contradicting its own body misleads the very agent this task
  // exists to stop misleading. Both surfaces are checked, on the REAL registry, from the RENDERED
  // text only — this test never asks the product what it thinks the answer is, it counts what the
  // agent can see. Two independent readings of the body (the per-category labels, and the bullet
  // lines) must BOTH equal the header, so a category header lying about its own list is caught too.
  test.each(['legacy', 'gateway'] as const)(
    'T6: on %s, the rendered body sums to the header count (one derivation, not two)',
    async (surface) => {
      vi.stubEnv('MANDREL_TOOL_SURFACE', surface);
      vi.resetModules();
      const { navigationHandler } = await import('../handlers/navigation.js');
      const { countAdvertisedSurface } = await import('../config/advertisedSurface.js');

      const counts = countAdvertisedSurface();
      const text = textOf(await navigationHandler.getHelp());

      // The number the HEADER claims, read out of the rendered text — gateway states it as
      // "N operations across M tools", legacy as "N Tools Available Across M Categories".
      const claimed =
        surface === 'gateway'
          ? Number(text.match(/\*\*(\d+) operations across (\d+) tools:\*\*/)?.[1])
          : Number(text.match(/\*\*(\d+) Tools Available Across (\d+) Categories:\*\*/)?.[1]);
      expect(Number.isInteger(claimed), `${surface} header must state a count`).toBe(true);
      expect(claimed, 'the header must state the measured surface').toBe(counts.operations);

      // Reading 1 — the per-category counts the body prints in its own section headers.
      const perCategory = [...text.matchAll(/^## .+ \((\d+) (?:tools|operations)\)$/gm)].map((m) =>
        Number(m[1]),
      );
      expect(perCategory.length, 'the body must render at least one category').toBeGreaterThan(0);
      expect(
        perCategory.reduce((a, b) => a + b, 0),
        'per-category counts must sum to the header count',
      ).toBe(claimed);

      // Reading 2 — the bullet lines actually listed, so a category header cannot overstate its
      // own list. Only the catalog bullets (`• **name** - desc`) count; the Quick Start /
      // Workflows footers use a different, description-less bullet shape.
      // The optional `` `op_id` `` between the label and the dash is the FLAT NAME each
      // gateway entry now also prints — it is part of the bullet, not a
      // second bullet, so the shape is widened to admit it rather than the count loosened.
      const bullets = [...text.matchAll(/^• \*\*.+?\*\*(?: `[a-z_]+`)? - /gm)].length;
      expect(bullets, 'listed operations must equal the header count').toBe(claimed);
    },
  );

  // ── T5: the machine channel carries the same measured numbers ────────────────────────────
  test('T5: structuredContent reports the same measured surface as the header', async () => {
    const { help, catalog } = await withGatewayFixture(FIXTURE_A);

    for (const [label, resp] of [['mandrel_help', help], ['discover.catalog', catalog]] as const) {
      const sc: any = (resp as any).structuredContent;
      expect(sc.surface, `${label} surface`).toBe('gateway');
      expect(sc.advertisedTools, `${label} advertisedTools`).toBe(3);
      expect(sc.advertisedOperations, `${label} advertisedOperations`).toBe(7);
    }
  });
});
