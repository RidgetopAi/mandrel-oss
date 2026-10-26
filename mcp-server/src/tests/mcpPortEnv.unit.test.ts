/**
 * The MCP server's port: the documented MANDREL_MCP_PORT is the one the server reads;
 * MANDREL_AIDIS_MCP_PORT keeps working as a deprecated alias (one log line).
 *
 * Run alone:  npx vitest run src/tests/mcpPortEnv.unit.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../utils/logger.js', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { portManager } from '../utils/portManager.js';

const NAMES = ['MANDREL_MCP_PORT', 'MANDREL_AIDIS_MCP_PORT', 'AIDIS_AIDIS_MCP_PORT'];

describe('assignPort("aidis-mcp") env resolution', () => {
  beforeEach(() => {
    warn.mockClear();
    for (const n of NAMES) vi.stubEnv(n, '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses MANDREL_MCP_PORT when only it is set, with no deprecation line', async () => {
    vi.stubEnv('MANDREL_MCP_PORT', '18111'); // fixed-port-ok: fixture/expectation, binds nothing
    expect(await portManager.assignPort('aidis-mcp')).toBe(18111);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the MANDREL_AIDIS_MCP_PORT alias when only it is set, logging one deprecation line', async () => {
    vi.stubEnv('MANDREL_AIDIS_MCP_PORT', '18112'); // fixed-port-ok: fixture/expectation, binds nothing
    expect(await portManager.assignPort('aidis-mcp')).toBe(18112);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('MANDREL_AIDIS_MCP_PORT');
    expect(warn.mock.calls[0][0]).toContain('MANDREL_MCP_PORT');
  });

  it('uses MANDREL_MCP_PORT when both are set, and does not warn', async () => {
    vi.stubEnv('MANDREL_MCP_PORT', '18113'); // fixed-port-ok: fixture/expectation, binds nothing
    vi.stubEnv('MANDREL_AIDIS_MCP_PORT', '18114'); // fixed-port-ok: fixture/expectation, binds nothing
    expect(await portManager.assignPort('aidis-mcp')).toBe(18113);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the default (8080) when neither is set', async () => { // reserved-port-ok: asserts the configured default value; nothing binds it
    expect(await portManager.assignPort('aidis-mcp')).toBe(8080); // reserved-port-ok: asserts the configured default value; nothing binds it
    expect(warn).not.toHaveBeenCalled();
  });
});
