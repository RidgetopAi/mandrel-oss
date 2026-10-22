import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// loop is a client of the public tool API only: nothing under loop/src may reach into mcp-server.
const SRC = new URL('../src', import.meta.url).pathname;
const FORBIDDEN = /mcp-server\/src/;

describe('loop/src isolation', () => {
  it('does not import from mcp-server/src', () => {
    const offenders = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => FORBIDDEN.test(readFileSync(join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
