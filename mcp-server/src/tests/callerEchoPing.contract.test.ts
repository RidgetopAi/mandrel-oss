/**
 * callerEchoPing.contract.test.ts — "did my X-Actor-ID land?" must be answerable by the
 * first call a user makes, on BOTH surfaces.
 *
 * THE DEFECT THIS GUARDS (measured on a live customer tenant 2026-09-07).
 * A customer had 454 writes attributed to the flagged `anonymous` fallback — still arriving,
 * last one 2026-09-05 — and exactly 3 that ever carried his actor. He believed he was
 * configured, and was not wrong to: NOTHING HE COULD REACH TOLD HIM OTHERWISE. `mandrel_ping`
 * returned a pong and a timestamp; `session_status` did carry the echo, but it sits behind the
 * `session` gateway and is not where a confused user goes.
 *
 * THE SURFACE MATTERS, WHICH IS WHY THIS FILE EXISTS RATHER THAN A UNIT TEST ON handlePing.
 * That customer is on the GATEWAY surface: his tools/list is `discover` + 7 gateways + 3
 * specials, and `mandrel_ping` IS NOT IN IT. A guard that only proved the flat op echoes
 * would have passed while the person it was written for still had no way to ask. So the
 * gateway path — discover({action:'ping'}) — is asserted FIRST and is the load-bearing lane.
 *
 * The two directions are both asserted: an actor that WAS declared is echoed back by name,
 * and an actor that was NOT is called out loudly. A guard that only checks the happy path
 * cannot tell a working echo from one hard-coded to the caller's hopes.
 */
import { describe, test, expect } from 'vitest';
import { dispatchGateway } from '../routes/gateway.js';
import { systemRoutes } from '../routes/system.routes.js';

const textOf = (r: any): string =>
  (r?.content ?? []).map((c: any) => c?.text ?? '').join('\n');

describe('caller identity echo on ping', () => {
  test('GATEWAY surface: discover({action:"ping"}) names a declared actor', async () => {
    const res = await dispatchGateway('discover', { action: 'ping' }, {
      actor: 'contoso',
      connectionId: 'orb-42',
    } as any);
    const text = textOf(res);
    expect(text).toContain('caller actor: contoso');
    expect(text).toContain('orb-42');
    expect((res as any).structuredContent?.caller).toMatchObject({
      actor: 'contoso',
      actorDeclared: true,
    });
  });

  test('GATEWAY surface: an UNDECLARED actor is called out, not silently defaulted', async () => {
    const res = await dispatchGateway('discover', { action: 'ping' }, {
      connectionId: 'orb-42',
    } as any);
    const text = textOf(res);
    expect(text).toContain('NOT DECLARED');
    expect(text).toContain('X-Actor-ID');           // it must say what to send
    expect(text).toContain('anonymous');            // and what it is being attributed to
    expect((res as any).structuredContent?.caller).toMatchObject({
      actor: null,
      actorDeclared: false,
    });
  });

  test('the pong itself still works — the echo is ADDITIVE, not a replacement', async () => {
    const res = await dispatchGateway('discover', { action: 'ping', message: 'hi' }, {
      actor: 'contoso',
    } as any);
    const text = textOf(res);
    expect(text).toContain('Mandrel Pong!');
    expect(text).toContain('hi');
    expect((res as any).structuredContent?.ok).toBe(true);
  });

  test('FLAT surface: the same op echoes the same way (one derivation, not two)', async () => {
    const declared = await systemRoutes.handlePing({}, { actor: 'coordinator' } as any);
    expect(textOf(declared)).toContain('caller actor: coordinator');
    const undeclared = await systemRoutes.handlePing({}, {} as any);
    expect(textOf(undeclared)).toContain('NOT DECLARED');
  });

  test('an in-process caller with NO context at all does not throw', async () => {
    const res = await systemRoutes.handlePing({});
    expect(textOf(res)).toContain('NOT DECLARED');
    expect((res as any).structuredContent?.ok).toBe(true);
  });
});

/**
 * ORDER — added 2026-09-09 after the echo above was verified live on the customer's own
 * container, in both directions, AND STILL DID NOT REACH HIM.
 *
 * His MCP client SUMMARISED the tool result: it kept the "🏓 Mandrel Pong! … Status:
 * Operational" headline and discarded the identity line after the newline. He reported back
 * "Mandrel is operational. Pong received successfully." — a string that appears nowhere in
 * this codebase. A warning that trails a status headline is a warning a summariser deletes.
 *
 * So the WARNING LEADS when the caller is undeclared. The tests above assert the CONTENT is
 * present; these assert its POSITION, which is the half that was actually broken. Both are
 * needed: content without position is what we already shipped and it failed.
 */
describe('ping text ORDER — the warning leads, the pong does not bury it', () => {
  test('UNDECLARED: the warning is the FIRST line, ahead of the pong headline', async () => {
    const res = await systemRoutes.handlePing({}, { connectionId: 'orb-42' } as any);
    const text = textOf(res);
    const lines = text.split('\n');

    expect(lines[0]).toContain('caller actor: NOT DECLARED');
    expect(text.indexOf('NOT DECLARED')).toBeLessThan(text.indexOf('Mandrel Pong!'));
    // The pong is still THERE — this is a reorder, not a removal.
    expect(text).toContain('Status: Operational');
  });

  test('UNDECLARED on the GATEWAY surface too (the surface the customer is actually on)', async () => {
    const res = await dispatchGateway('discover', { action: 'ping' }, {
      connectionId: 'orb-42',
    } as any);
    const text = textOf(res);
    expect(text.split('\n')[0]).toContain('NOT DECLARED');
    expect(text.indexOf('NOT DECLARED')).toBeLessThan(text.indexOf('Mandrel Pong!'));
  });

  test('DECLARED: order is UNCHANGED — pong first, identity after', async () => {
    const res = await systemRoutes.handlePing({ message: 'hi' }, { actor: 'coordinator', connectionId: 'c1' } as any);
    const text = textOf(res);
    const lines = text.split('\n');
    expect(lines[0]).toContain('Mandrel Pong!');
    expect(lines[0]).toContain('Status: Operational');
    expect(lines[1]).toBe('👤 caller actor: coordinator');
    expect(lines[2]).toBe('🔌 caller connection: c1');
    expect(text.indexOf('Mandrel Pong!')).toBeLessThan(text.indexOf('caller actor'));
  });

  test('structuredContent is untouched by the reorder, in BOTH directions', async () => {
    const declared: any = await systemRoutes.handlePing({}, { actor: 'coordinator', connectionId: 'c1' } as any);
    expect(declared.structuredContent).toMatchObject({
      ok: true,
      status: 'operational',
      caller: { actor: 'coordinator', actorDeclared: true, connectionId: 'c1' },
    });
    const undeclared: any = await systemRoutes.handlePing({}, { connectionId: 'c1' } as any);
    expect(undeclared.structuredContent).toMatchObject({
      ok: true,
      status: 'operational',
      caller: { actor: null, actorDeclared: false, connectionId: 'c1' },
    });
  });
});
