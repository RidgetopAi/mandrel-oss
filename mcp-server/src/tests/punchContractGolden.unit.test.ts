/**
 * PUNCH CONTRACT GOLDEN — NO DB, NO network.
 *
 * The reference loop (loop/) carries its own copy of the punch vocabulary because it is a client
 * of the public tool API and must not import from mcp-server. Both packages are pinned to the one
 * file loop/test/fixtures/punch-contract.golden.json; loop/test/golden.test.ts is the other half.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { validateToolArguments } from '../middleware/validation.js';
import {
  PUNCH_CLAUSE_OWNERS,
  PUNCH_PROOF_KINDS,
  TASK_STAGES,
} from '../config/taskStageConfig.js';

const GOLDEN = fileURLToPath(new URL('../../../loop/test/fixtures/punch-contract.golden.json', import.meta.url));
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));

describe('punch contract golden (mcp-server half)', () => {
  it('TASK_STAGES equals the golden stages', () => expect([...TASK_STAGES]).toEqual(golden.stages));
  it('PUNCH_PROOF_KINDS equals the golden proofKinds', () =>
    expect([...PUNCH_PROOF_KINDS]).toEqual(golden.proofKinds));
  it('PUNCH_CLAUSE_OWNERS equals the golden clauseOwners', () =>
    expect([...PUNCH_CLAUSE_OWNERS]).toEqual(golden.clauseOwners));
});

describe('punch contract golden: claim and top-level punch rules (mcp-server half)', () => {
  it('a default claim accepts the golden statuses', () =>
    expect(TASK_CLAIM_CONFIG.defaultAllowedStatuses).toEqual(golden.claim.defaultAllowedStatuses));
  it('the claimable ceiling equals the golden', () =>
    expect(TASK_CLAIM_CONFIG.claimableStatuses).toEqual(golden.claim.claimableStatuses));

  it('a top-level punch keeps exactly the golden keys and drops loop-owned ones', () => {
    const valid: Record<string, unknown> = {
      doneWhen: 'x',
      proofKind: 'test',
      source: 'machine',
      touches: ['a'],
      dependsOn: [],
    };
    const loopOwned = ['branch', 'sha', 'lane', 'verdict', 'dispatchFailures'];
    const offered = {
      ...Object.fromEntries(golden.topLevelPunchKeys.map((k: string) => [k, valid[k]])),
      ...Object.fromEntries(loopOwned.map((k) => [k, 'v'])),
    };
    const parsed = validateToolArguments('task_update', { taskId: 'a'.repeat(8), punch: offered });
    expect(Object.keys(parsed.punch).sort()).toEqual([...golden.topLevelPunchKeys].sort());
  });

  it('stage to status derivation in migration 101 equals the golden', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../database/migrations/101_task_stage.sql', import.meta.url)),
      'utf8',
    );
    for (const [stage, status] of Object.entries<string>(golden.stageStatus)) {
      expect(sql, `${stage} -> ${status}`).toMatch(new RegExp(`WHEN '${stage}'\\s+THEN '${status}'`));
    }
  });
});
