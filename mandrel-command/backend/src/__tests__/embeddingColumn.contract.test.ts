/**
 * Contract test for activeEmbeddingColumn() (search consolidation).
 *
 * PINS the backend's key→column map to the SAME MANDREL_EMBEDDER contract the
 * mcp-server core registry (embeddingConfig.ts) reads, so the two can't drift
 * silently (a past incident — one helper, not N hardcoded `embedding` refs). If the
 * core renames a column or key, this test forces this mirror to be updated too.
 */

describe('activeEmbeddingColumn()', () => { // db-gate-exempt: contract-NAMED but not DB-backed — asserts config/embeddingColumn resolution only; opens no connection (0 occurrences of Pool/Client/.query)
  const ORIGINAL = process.env.MANDREL_EMBEDDER;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.MANDREL_EMBEDDER;
    } else {
      process.env.MANDREL_EMBEDDER = ORIGINAL;
    }
    jest.resetModules();
  });

  const loadFresh = () => {
    jest.resetModules();
    // Re-require so module-scope env reads (MANDREL_*_COLUMN defaults) re-evaluate.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../config/embeddingColumn') as typeof import('../config/embeddingColumn');
  };

  it('returns the GEMMA column when MANDREL_EMBEDDER=gemma', () => {
    process.env.MANDREL_EMBEDDER = 'gemma';
    const { activeEmbeddingColumn, activeEmbedderKey } = loadFresh();
    expect(activeEmbedderKey()).toBe('gemma');
    expect(activeEmbeddingColumn()).toBe('embedding_gemma');
  });

  it('returns the LEGACY (minilm) column when MANDREL_EMBEDDER=minilm', () => {
    process.env.MANDREL_EMBEDDER = 'minilm';
    const { activeEmbeddingColumn, activeEmbedderKey } = loadFresh();
    expect(activeEmbedderKey()).toBe('minilm');
    expect(activeEmbeddingColumn()).toBe('embedding');
  });

  it('defaults to MINILM when MANDREL_EMBEDDER is unset — the same default the core takes', () => {
    delete process.env.MANDREL_EMBEDDER;
    const { activeEmbeddingColumn, activeEmbedderKey } = loadFresh();
    expect(activeEmbedderKey()).toBe('minilm');
    expect(activeEmbeddingColumn()).toBe('embedding');
  });

  it('THROWS on an unknown value instead of falling back to a column nothing writes', () => {
    process.env.MANDREL_EMBEDDER = 'does-not-exist';
    const { activeEmbeddingColumn, activeEmbedderKey } = loadFresh();
    expect(() => activeEmbedderKey()).toThrow(/does-not-exist/);
    expect(() => activeEmbeddingColumn()).toThrow(/gemma/);
  });

  // --- DIMENSIONS: the second half of the mirror (2026-08-19) ----------------------
  // The column mirror alone let three sites in this package keep a dimension in longhand,
  // which is only correct while minilm is active. These pin the dimension to the core
  // registry's values so the two packages cannot drift on geometry any more than they can
  // on the column name.
  //
  // THIS IS THE ONE FILE WHERE THE NUMBERS BELONG. Everywhere else under
  // src/__tests__/ an embedder dimension written as a numeric literal is an eslint error;
  // here the literal IS the assertion, so each site carries a co-located disable with its
  // reason rather than a central allow-list. Deriving these from the module
  // under test would make the pin tautological — it would pass whatever the module said.

  it('returns the GEMMA dimension (768) when MANDREL_EMBEDDER=gemma', () => {
    process.env.MANDREL_EMBEDDER = 'gemma';
    // eslint-disable-next-line no-restricted-syntax -- the pinned value IS the assertion
    expect(loadFresh().activeEmbeddingDimensions()).toBe(768);
  });

  it('returns the MINILM dimension (1536) when MANDREL_EMBEDDER=minilm', () => {
    process.env.MANDREL_EMBEDDER = 'minilm';
    // eslint-disable-next-line no-restricted-syntax -- the pinned value IS the assertion
    expect(loadFresh().activeEmbeddingDimensions()).toBe(1536);
  });

  it('defaults to the MINILM dimension when MANDREL_EMBEDDER is unset', () => {
    delete process.env.MANDREL_EMBEDDER;
    // eslint-disable-next-line no-restricted-syntax -- the pinned value IS the assertion
    expect(loadFresh().activeEmbeddingDimensions()).toBe(1536);
  });

  it('THROWS on an unknown value rather than returning an undefined dimension', () => {
    process.env.MANDREL_EMBEDDER = 'does-not-exist';
    expect(() => loadFresh().activeEmbeddingDimensions()).toThrow(/does-not-exist/);
  });

  it('EVERY key in the registry resolves BOTH a column and a dimension', () => {
    // Population DERIVED from the union of the two maps, never hand-typed: a key added
    // to one map only is in the population and resolves an undefined half, so it is RED.
    const keys = loadFresh().knownEmbedderKeys();
    expect(keys).toEqual(expect.arrayContaining(['minilm', 'gemma']));
    for (const key of keys) {
      process.env.MANDREL_EMBEDDER = key;
      const mod = loadFresh();
      expect(typeof mod.activeEmbeddingColumn()).toBe('string');
      expect(mod.activeEmbeddingColumn().length).toBeGreaterThan(0);
      expect(Number.isInteger(mod.activeEmbeddingDimensions())).toBe(true);
      expect(mod.activeEmbeddingDimensions()).toBeGreaterThan(0);
    }
  });
});
