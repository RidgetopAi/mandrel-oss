/**
 * INSTALL DEFAULT TOOL SURFACE. A fresh `./install.sh` must hand clients the
 * gateway tool list the README describes, not the ~72 flat legacy tools. The deployed value is
 * what docker-compose.yml / .env.example say, so this test READS those two files, runs the server's
 * own surface selection with that value, and checks what tools/list would advertise.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildAdvertisedTools } from '../server/registerMcpHandlers.js';
import { getToolSurface } from '../config/toolSurfaceConfig.js';
import { GATEWAY_ORDER } from '../config/gatewayConfig.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const compose = readFileSync(resolve(repoRoot, 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');

const composeDefault = /MANDREL_TOOL_SURFACE:\s*"\$\{MANDREL_TOOL_SURFACE:-([a-z]+)\}"/.exec(compose)?.[1];
const envExampleValue = /^MANDREL_TOOL_SURFACE=([a-z]*)\s*$/m.exec(envExample)?.[1];

afterEach(() => {
  delete process.env.MANDREL_TOOL_SURFACE;
});

describe('installed default tool surface', () => {
  test('compose and .env.example both default MANDREL_TOOL_SURFACE to gateway', () => {
    expect(composeDefault).toBe('gateway');
    expect(envExampleValue).toBe('gateway');
  });

  test('tools/list under that default has discover + the gateways and no flat context_store', () => {
    process.env.MANDREL_TOOL_SURFACE = composeDefault;
    const names = buildAdvertisedTools(true, getToolSurface()).map((t) => t.name);
    expect(names).toContain('discover');
    for (const gw of GATEWAY_ORDER) expect(names).toContain(gw);
    expect(names).not.toContain('context_store');
    expect(names.length).toBeLessThan(20);
  });
});
