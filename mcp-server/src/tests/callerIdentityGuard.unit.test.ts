/**
 * The unidentified-caller guard DECISION, in isolation.
 *
 * The contract sibling (unidentifiedCallerScope.contract.test.ts) proves the guard is WIRED
 * to the real transport and the real DB. This file proves the DECISION itself is right
 * across the whole input space, with no DB and no config: `callerIdentityRejection` is pure,
 * so every combination of (identified × effect × hasExplicitProject) can be stated.
 *
 * That matters because the enforcement path can only ever observe the combinations that
 * happen to occur; a guard whose decision is only reachable through its own throw cannot be
 * examined for the SHADOW case, and the shadow case is the one that has to be right BEFORE
 * a flip.
 */

import { describe, test, expect } from 'vitest';
import {
  callerIdentityRejection,
  CALLER_IDENTITY_ERROR_CODES,
  ScopeSwitchUnidentifiedError,
  AmbientWriteUnidentifiedError,
} from '../services/callerIdentityGuard.js';

const WRITE = 'context_store';
const READ = 'context_search';
const SWITCH = 'project_switch';

describe('G1 — an unidentified caller may not PERSIST scope', () => {
  test('project_switch from an unidentified caller is rejected', () => {
    const err = callerIdentityRejection({
      toolName: SWITCH,
      identified: false,
      hasExplicitProject: true,
    });
    expect(err).toBeInstanceOf(ScopeSwitchUnidentifiedError);
    expect(err!.code).toBe(CALLER_IDENTITY_ERROR_CODES.SCOPE_SWITCH_UNIDENTIFIED);
    expect(err!.message).toContain(SWITCH);
  });

  test('naming a project does NOT buy a switch — the harm is to the OTHER callers', () => {
    // A switch is not made safe by being explicit about its target: it moves the slot every
    // other header-less caller reads. Both hasExplicitProject values reject.
    for (const hasExplicitProject of [true, false]) {
      expect(
        callerIdentityRejection({ toolName: SWITCH, identified: false, hasExplicitProject })
      ).toBeInstanceOf(ScopeSwitchUnidentifiedError);
    }
  });

  test('an IDENTIFIED caller switches freely — isolation already holds for them', () => {
    expect(
      callerIdentityRejection({ toolName: SWITCH, identified: true, hasExplicitProject: true })
    ).toBeNull();
  });
});

describe('G2 — an unidentified ambient WRITE must carry an explicit project', () => {
  test('unidentified + write + no explicit project → rejected', () => {
    const err = callerIdentityRejection({
      toolName: WRITE,
      identified: false,
      hasExplicitProject: false,
    });
    expect(err).toBeInstanceOf(AmbientWriteUnidentifiedError);
    expect(err!.code).toBe(CALLER_IDENTITY_ERROR_CODES.AMBIENT_WRITE_UNIDENTIFIED);
  });

  test('unidentified + write + an explicit project → permitted (the call is self-describing)', () => {
    expect(
      callerIdentityRejection({ toolName: WRITE, identified: false, hasExplicitProject: true })
    ).toBeNull();
  });

  test('a write op OUTSIDE ACTION_TOOLS is still guarded (the `link` gap)', () => {
    expect(
      callerIdentityRejection({ toolName: 'link', identified: false, hasExplicitProject: false })
    ).toBeInstanceOf(AmbientWriteUnidentifiedError);
  });
});

describe('G3 — reads are untouched', () => {
  test('an unidentified READ is permitted with or without an explicit project', () => {
    for (const hasExplicitProject of [true, false]) {
      expect(
        callerIdentityRejection({ toolName: READ, identified: false, hasExplicitProject })
      ).toBeNull();
    }
  });
});

describe('the marker: ONLY an explicit `false` is the guarded population', () => {
  test('identified:true and identified:undefined both fall straight through', () => {
    // `undefined` is an in-process caller / the tick / a test — never a transport, because a
    // transport cannot leave the field undefined (TransportRouteContext requires it). The
    // guard must not reject those, or it rejects our own background writes.
    for (const identified of [true, undefined]) {
      for (const toolName of [WRITE, READ, SWITCH]) {
        expect(
          callerIdentityRejection({ toolName, identified, hasExplicitProject: false }),
          `${toolName} / identified=${String(identified)}`
        ).toBeNull();
      }
    }
  });
});

describe('an UNKNOWN op name is guarded like a write (fail closed)', () => {
  test('a name not in the registry rejects rather than sails through', () => {
    for (const unknown of ['', 'not_a_tool', 'context_storee']) {
      expect(
        callerIdentityRejection({
          toolName: unknown,
          identified: false,
          hasExplicitProject: false,
        }),
        JSON.stringify(unknown)
      ).toBeInstanceOf(AmbientWriteUnidentifiedError);
    }
  });
});

describe('the errors are actionable — every rejection names every way out', () => {
  test('both messages carry the code prefix, a 💡 hint, and all three remedies', () => {
    const errs = [
      callerIdentityRejection({ toolName: SWITCH, identified: false, hasExplicitProject: false })!,
      callerIdentityRejection({ toolName: WRITE, identified: false, hasExplicitProject: false })!,
    ];
    for (const err of errs) {
      // The 💡 is load-bearing: formatMcpError appends a GENERIC "re-check your parameters"
      // hint to any message without one, and that is the wrong advice for a header problem.
      expect(err.message).toContain('💡');
      expect(err.message.startsWith(`[${err.code}]`)).toBe(true);
      expect(err.message).toContain('X-Connection-ID');
      expect(err.message).toContain('projectId');
      expect(err.message).toContain('X-Mandrel-Project');
    }
  });
});
