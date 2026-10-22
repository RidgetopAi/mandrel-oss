import { describe, it, expect } from 'vitest';
import { punchIncompleteMissing } from './punchError';

describe('punchIncompleteMissing — reading lane A 400 off the shared ApiError', () => {
  it('reads the interceptor shape: code on the error, missing in details', () => {
    expect(
      punchIncompleteMissing({
        message: 'Punch incomplete',
        code: 'PUNCH_INCOMPLETE',
        status: 400,
        details: { code: 'PUNCH_INCOMPLETE', missing: ['doneWhen', 'proofKind'] },
      }),
    ).toEqual(['doneWhen', 'proofKind']);
  });
  it('tolerates the body nested under error / data', () => {
    expect(
      punchIncompleteMissing({ status: 400, details: { error: { code: 'PUNCH_INCOMPLETE', missing: ['doneWhen'] } } }),
    ).toEqual(['doneWhen']);
    expect(
      punchIncompleteMissing({ status: 400, details: { data: { code: 'PUNCH_INCOMPLETE', missing: ['proofKind'] } } }),
    ).toEqual(['proofKind']);
  });
  it('a PUNCH_INCOMPLETE with no missing list is still recognised (empty list, not null)', () => {
    expect(punchIncompleteMissing({ code: 'PUNCH_INCOMPLETE', status: 400 })).toEqual([]);
  });
  it('any other rejection is null — a 400 is not automatically incomplete', () => {
    expect(punchIncompleteMissing({ code: 'VALIDATION_ERROR', status: 400, details: { missing: ['x'] } })).toBeNull();
    expect(punchIncompleteMissing(new Error('boom'))).toBeNull();
    expect(punchIncompleteMissing(null)).toBeNull();
    expect(punchIncompleteMissing('PUNCH_INCOMPLETE')).toBeNull();
  });
});
