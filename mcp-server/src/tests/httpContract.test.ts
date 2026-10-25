import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

// Provide required database env vars before importing the server module to prevent
// config/database from throwing during module evaluation. Stubbed in beforeAll (NOT at
// module scope) and restored in afterAll. process.env is shared by every
// file in the run (vitest.config pins the suite to ONE fork), so a module-scope write leaks
// into every later file. Every server module here is imported DYNAMICALLY in beforeAll, so
// stubbing there still lands before any module-eval read.
const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_contract_test',
  DATABASE_USER: process.env.DATABASE_USER || 'contract_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'contract_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_LOCK_FILE: process.env.AIDIS_LOCK_FILE || path.join(os.tmpdir(), 'aidis-contract.lock'),
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
  AIDIS_AIDIS_MCP_PORT: process.env.AIDIS_AIDIS_MCP_PORT || '0',
  AIDIS_DISABLE_PROCESS_EXIT_HANDLERS: process.env.AIDIS_DISABLE_PROCESS_EXIT_HANDLERS || 'true',
};

let ServerCtor: typeof import('@/server/MandrelMcpServer').default;
let processLock: typeof import('@/utils/processLock').processLock;

const ajv = new Ajv({ allErrors: true, strict: false });

const successSchema = {
  type: 'object',
  required: ['success', 'result'],
  properties: {
    success: { const: true },
    result: {},
  },
  additionalProperties: true,
};

const errorSchema = {
  type: 'object',
  required: ['success', 'error'],
  properties: {
    success: { const: false },
    error: { type: 'string', minLength: 1 },
  },
  additionalProperties: true,
};

// IN-BAND TOOL ERROR. The THIRD legitimate envelope shape, and the one
// this file could not express before: the tool ran, the executor caught its error and returned
// it as an MCP error result, so the HTTP status stays 200 (the correct MCP shape) and there is
// no top-level `error` string — the failure lives in `result.isError`. Before the fix the
// envelope claimed `success: true` on exactly these responses, which is why the loop below only
// ever saw two shapes.
const inbandErrorSchema = {
  type: 'object',
  required: ['success', 'result'],
  properties: {
    success: { const: false },
    result: {
      type: 'object',
      required: ['isError'],
      properties: { isError: { const: true } },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const responseSchema = {
  anyOf: [successSchema, errorSchema, inbandErrorSchema],
};

const validateResponse = ajv.compile(responseSchema);
async function postTool(baseUrl: string, toolName: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/mcp/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arguments: args }),
  });
  const body = await res.json();
  return { res, body } as const;
}

function expectSuccessEnvelope(body: unknown) {
  expect(validateResponse(body)).toBe(true);
  const typed = body as { success: boolean; result: unknown };
  expect(typed.success).toBe(true);
  return typed;
}

function expectInbandErrorEnvelope(body: unknown) {
  expect(validateResponse(body)).toBe(true);
  const typed = body as { success: boolean; result: { isError?: boolean } };
  // THE INVARIANT: the envelope and the result it wraps must AGREE.
  expect(typed.success).toBe(false);
  expect(typed.result?.isError).toBe(true);
  return typed;
}

function expectErrorEnvelope(body: unknown) {
  expect(validateResponse(body)).toBe(true);
  const typed = body as { success: boolean; error: string };
  expect(typed.success).toBe(false);
  expect(typed.error).toBeTypeOf('string');
  return typed;
}

async function getRegisteredToolNamesFromSource() {
  const sourcePath = fileURLToPath(new URL('../routes/index.ts', import.meta.url));
  const source = await fs.readFile(sourcePath, 'utf8');
  const caseRegex = /case '([^']+)'/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(source)) !== null) {
    names.add(match[1]);
  }
  return Array.from(names);
}

const SUCCESS_TOOLS = new Set(['aidis_ping', 'aidis_status', 'aidis_help', 'aidis_examples']);
const TOOL_ARGUMENTS: Record<string, Record<string, unknown>> = {
  aidis_ping: { message: 'contract regression' },
  aidis_help: {},
  aidis_status: {},
  aidis_examples: { toolName: 'aidis_ping' },
};

describe('HTTP ↔ MCP contract', () => {
  let server: InstanceType<typeof ServerCtor>;
  let baseUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    // MUST precede the dynamic imports below (config/database module-eval reads these).
    for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);

    if (!ServerCtor) {
      const serverModule = await import('@/server/MandrelMcpServer');
      ServerCtor = serverModule.default;
    }
    if (!processLock) {
      ({ processLock } = await import('@/utils/processLock'));
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidis-contract-'));
    // stubEnv (not raw assignment) so the afterAll unstubAllEnvs restores these too — these
    // point at this file's TEMP dir, which is deleted in afterAll, so leaking one left later
    // files pointed at a path that no longer exists.
    vi.stubEnv('AIDIS_LOCK_FILE', path.join(tempDir, 'aidis-server.lock'));
    vi.stubEnv('AIDIS_SKIP_DATABASE', 'true');
    vi.stubEnv('AIDIS_SKIP_BACKGROUND', 'true');
    vi.stubEnv('AIDIS_SKIP_STDIO', 'true');
    vi.stubEnv('AIDIS_AIDIS_MCP_PORT', '0');

    server = new ServerCtor();
    await server.start();

    const healthServer = (server as any).healthServer as import('http').Server;
    const address = healthServer.address();
    const port = typeof address === 'object' && address ? address.port : Number(process.env.AIDIS_HEALTH_PORT || 8080); // reserved-port-ok: read-fallback for the ephemeral-bound server's port; the suite binds port 0
    baseUrl = `http://localhost:${port}`;
  }, 60000);

  afterAll(async () => {
    try {
      await server.gracefulShutdown('TEST_SUITE');
    } catch (error) {
      // Swallow shutdown errors in test mode
      console.warn('Graceful shutdown warning:', error);
    } finally {
      processLock.release();
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      // ALWAYS restore — leave process.env exactly as this file found it.
      vi.unstubAllEnvs();
    }
  });

  it('returns contract-compliant response for aidis_ping', async () => {
    const message = 'contract test';
    const { res, body } = await postTool(baseUrl, 'aidis_ping', { message });
    expect(res.status).toBe(200);
    const success = expectSuccessEnvelope(body) as { result: { content?: Array<{ text: string }> } };
    expect(success.result.content?.[0]?.text).toMatch(/(?:AIDIS|Mandrel) Pong/);
    expect(success.result.content?.[0]?.text).toContain(message);

    const directResult = await (server as any).executeMcpTool('aidis_ping', { message });
    expect(directResult.content[0].text).toMatch(/(?:AIDIS|Mandrel) Pong/);
    expect(directResult.content[0].text).toContain(message);
  });

  it('returns structured error for unknown tool', async () => {
    const { res, body } = await postTool(baseUrl, 'not_a_tool');
    // WAS `toBe(500)` — this assertion PINNED the defect fixed in a client
    // asking for a tool that does not exist is a CLIENT error, and a 5xx tells a retrying
    // agent SDK to retry a request that can never succeed (and inflates the 5xx rate we
    // alert on). Asserting the CLASS (4xx) rather than a new magic number, plus an explicit
    // not-5xx, so this cannot silently drift back into the bug it used to encode.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const error = expectErrorEnvelope(body);
    expect(error.error).toMatch(/not_a_tool/i);
  }, 15000);

  it('exposes status data including feature flag summary', async () => {
    const { res, body } = await postTool(baseUrl, 'aidis_status');
    expect(res.status).toBe(200);
    const success = expectSuccessEnvelope(body) as { result: { content?: Array<{ text: string }> } };
    const text = success.result.content?.[0]?.text ?? '';
    expect(text).toMatch(/Status:/);
    expect(text).toMatch(/Operational|Environment:/);
  });

  it('serves human-readable tool help via aidis_help', async () => {
    const { res, body } = await postTool(baseUrl, 'aidis_help');
    expect(res.status).toBe(200);
    const success = expectSuccessEnvelope(body) as { result: { content?: Array<{ text: string }> } };
    const text = success.result.content?.[0]?.text ?? '';
    // Brand-agnostic: the product was renamed AIDIS → Mandrel (the help title now reads
    // "Mandrel"); accept either so the contract guards the help SURFACE, not the old name.
    expect(text).toMatch(/(?:AIDIS|Mandrel)/);
    expect(text).toMatch(/tool/i);
  });

  it('propagates validation errors for malformed context_store payloads', async () => {
    const { res, body } = await postTool(baseUrl, 'context_store', {});
    // WAS `toBe(500)` — the same defect, on the very path
    // contextStoreLongContent.contract.test.ts already documented ("catches the thrown
    // validation error → res.status(500)"). A malformed payload is the caller's mistake:
    // terminal 4xx, not retryable 5xx. The error BODY assertions below are unchanged and
    // still load-bearing — the fix moved the status only, and must not have weakened the
    // validation or its message.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const error = expectErrorEnvelope(body);
    expect(error.error).toMatch(/Validation failed/i);
    expect(error.error).toMatch(/content/i);
  }, 15000);

  it('retains contract envelope across all registered tools', async () => {
    const toolNames = await getRegisteredToolNamesFromSource();
    expect(toolNames.length).toBeGreaterThanOrEqual(27);

    for (const toolName of toolNames) {
      const args = TOOL_ARGUMENTS[toolName] ?? {};
      const { res, body } = await postTool(baseUrl, toolName, args);

      if ((body as any)?.success === true || SUCCESS_TOOLS.has(toolName)) {
        expect(res.status, toolName).toBe(200);
        expectSuccessEnvelope(body);
      } else if (res.status === 200) {
        // the envelope-agreement defect: `success: false` at 200 is NOT a contradiction — it is an in-band
        // MCP tool error, and the envelope now says so instead of claiming success. This
        // branch did not exist because the shape could not occur: the envelope hardcoded
        // `success: true`, so every one of these responses took the success branch above.
        expectInbandErrorEnvelope(body);
      } else {
        // A NON-200 NOW HAS TWO LEGAL BODIES, and this branch used to know only one.
        //
        // Before an earlier task (commit 32df00d) a 4xx could only come from the express
        // catch, whose body is `{success:false, error:<string>}`. A POLICY REFUSAL — the
        // identity guards, the actor requirement, a binding mismatch — never reaches that
        // catch: routeExecutorInner returns formatMcpError IN BAND, and that branch used to
        // hardcode 200. It now carries the refusal's real status, so the in-band body
        // `{success:false, result:{isError:true, transportStatus:<4xx>}}` appears with a 4xx
        // status. `status >= 400` therefore no longer implies the catch shape, and demanding
        // a top-level `error` string of both was a false RED on correct behaviour.
        //
        // DISPATCH ON THE BODY, AND ASSERT EACH SHAPE FULLY — this is strictly more than the
        // one line it replaces, not less. The in-band case now has to satisfy the whole
        // in-band invariant (success:false AND result.isError:true) PLUS agreement between
        // the stamp and the wire: `httpStatusForToolOutcome` derives a non-200 in-band status
        // from `result.transportStatus` and from nothing else (utils/mcpErrorStatus.ts), so a
        // 4xx whose stamp disagrees with its status means the two answers have drifted apart
        // again — which is the exact defect that commit exists to end, and which nothing else
        // in this file was checking.
        expect(res.status, toolName).toBeGreaterThanOrEqual(400);
        const shaped = body as {
          result?: { isError?: boolean; transportStatus?: number };
          error?: unknown;
        };
        if (shaped.result !== undefined) {
          expectInbandErrorEnvelope(body);
          expect(shaped.result?.transportStatus, `${toolName}: stamp must match the wire`).toBe(
            res.status
          );
        } else {
          const error = expectErrorEnvelope(body);
          expect(error.error.length).toBeGreaterThan(0);
        }
      }
    }
  }, 60000);
});
