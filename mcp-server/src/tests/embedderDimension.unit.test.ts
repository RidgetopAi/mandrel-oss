/**
 * A FRESH DATABASE STORES VECTORS OF THE SIZE THE DEFAULT EMBEDDER PRODUCES.
 *
 * Replays every migration in filename order (statically — no database needed), tracking
 * the declared `vector(N)` of each (table, column), and asserts that the column the
 * DEFAULT embedder (MANDREL_EMBEDDER unset => minilm) reads and writes has exactly the
 * dimension its spec declares, on every table that stores embeddings. The gemma column is
 * asserted against the gemma spec too, so existing gemma installs are provably untouched.
 *
 * A column that cannot be found is a FAILURE (could not measure), never a pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeEmbedder, embedders } from '@/config/embeddingConfig';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '..', '..', 'database', 'migrations');

/** Tables that carry the active embedder's vector column. */
const EMBEDDING_TABLES = ['contexts', 'technical_decisions', 'tasks'];

/** `table.column` -> declared vector dimension after replaying all migrations. */
function replayVectorDims(): Map<string, number> {
  const dims = new Map<string, number>();
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  expect(files.length, `COULD NOT MEASURE: no migrations in ${MIGRATIONS}`).toBeGreaterThan(0);

  const tableRe = /^\s*(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?(?: IF EXISTS)?)\s+(?:public\.)?"?(\w+)"?/i;
  const declRe = /^\s*(?:ALTER COLUMN\s+|ADD COLUMN(?: IF NOT EXISTS)?\s+)?"?(\w+)"?\s+(?:TYPE\s+)?(?:public\.)?vector\((\d+)\)/i;

  for (const f of files) {
    let table: string | null = null;
    for (const line of fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').split('\n')) {
      if (/^\s*--/.test(line)) continue;
      const t = tableRe.exec(line);
      if (t) table = t[1];
      const d = declRe.exec(line);
      if (d && table) dims.set(`${table}.${d[1]}`, Number(d[2]));
    }
  }
  return dims;
}

describe('fresh-install vector dimension matches the default embedder', () => {
  const PRIOR = process.env.MANDREL_EMBEDDER;
  beforeEach(() => {
    delete process.env.MANDREL_EMBEDDER;
  });
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = PRIOR;
  });

  it('the default embedder is MiniLM (the dimension below is MiniLM\'s)', () => {
    expect(activeEmbedder().key).toBe('minilm');
  });

  it.each(EMBEDDING_TABLES)('%s: the default embedder column is created at the default embedder dimension', (table) => {
    const spec = activeEmbedder();
    const got = replayVectorDims().get(`${table}.${spec.column}`);
    expect(got, `COULD NOT MEASURE ${table}.${spec.column}: no vector(N) declaration found`).toBeDefined();
    expect(got, `fresh migrations create ${table}.${spec.column} as vector(${got}) but the default embedder produces ${spec.dimensions}`).toBe(
      spec.dimensions,
    );
  });

  it.each(EMBEDDING_TABLES)('%s: the gemma column is unchanged (existing gemma installs keep working)', (table) => {
    const g = embedders().gemma;
    expect(replayVectorDims().get(`${table}.${g.column}`)).toBe(g.dimensions);
  });
});
