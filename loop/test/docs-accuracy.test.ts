import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => readFileSync(join(HERE, '..', '..', ...p), 'utf8');

/** Every check name doctor.ts reports, read from its `check <name> failed` messages. */
const checkNames = [...new Set([...read('loop', 'src', 'doctor.ts').matchAll(/check ([a-z][a-z-]*) failed/g)].map((m) => m[1]!))];

describe('doctor check names are documented', () => {
  it('finds the registered checks in the source', () => {
    expect(checkNames).toContain('task-claims');
    expect(checkNames.length).toBeGreaterThanOrEqual(7);
  });
  it.each(checkNames)('loop/README.md lists %s', (name) => {
    expect(read('loop', 'README.md')).toContain(`\`${name}\``);
  });
  it.each(checkNames)('runtime-setup.md doctor table has a %s row', (name) => {
    expect(read('docs', 'loop', 'runtime-setup.md')).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });
});

describe('key guidance in .env.example and the supersession manual', () => {
  it('.env.example does not tell the user never to put a real key there', () => {
    expect(read('.env.example')).not.toContain('NEVER put a real key here');
  });
  it('.env.example tells the user to put real keys in their own .env', () => {
    expect(read('.env.example')).toMatch(/real keys in your own \.env/);
  });
  it('supersession.md has no caveat about compose not forwarding the keys', () => {
    expect(read('docs', 'manual', 'supersession.md')).not.toMatch(/does not forward the keys/i);
  });
});
