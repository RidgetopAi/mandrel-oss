import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUNCH_CLAUSE_OWNERS, PUNCH_PROOF_KINDS, TASK_STAGES } from '../src/config.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/punch-contract.golden.json', import.meta.url), 'utf8'),
);

describe('punch contract golden', () => {
  it('stages equal the golden', () => expect([...TASK_STAGES]).toEqual(golden.stages));
  it('proof kinds equal the golden', () => expect([...PUNCH_PROOF_KINDS]).toEqual(golden.proofKinds));
  it('clause owners equal the golden', () => expect([...PUNCH_CLAUSE_OWNERS]).toEqual(golden.clauseOwners));
  it('the golden has exactly these keys', () =>
    expect(Object.keys(golden).sort()).toEqual(['claim', 'clauseOwners', 'proofKinds', 'stageStatus', 'stages', 'topLevelPunchKeys']));
});
