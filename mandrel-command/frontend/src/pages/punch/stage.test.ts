/**
 * Stage derivation — the pure functions the board renders from.
 * The legacy `stage:null` mirror is the one that matters most: against an un-migrated
 * backend every task is null, and a wrong mirror is an EMPTY board.
 */
import { describe, it, expect } from 'vitest';
import type { DropResult } from 'react-beautiful-dnd';
import {
  effectiveStage,
  columnFor,
  groupByColumn,
  missingPunchFields,
  missingLabels,
  rejectReason,
  stageIndex,
  stageChangeFromDrop,
} from './stage';
import { STAGES, BLOCKED_LANE, riskGateLabel } from './config';
import type { Task } from '../../types/task';

const t = (over: Partial<Task>): Task =>
  ({ id: 'x', status: 'todo', stage: null, metadata: null, ...over }) as unknown as Task;

describe('effectiveStage — legacy stage:null mirrors the backend backfill', () => {
  it.each([
    ['todo', 'ready'],
    ['in_progress', 'claimed'],
    ['completed', 'merged'],
    ['blocked', 'ready'],
  ] as const)('status %s with stage null → %s', (status, stage) => {
    expect(effectiveStage(t({ status, stage: null }))).toBe(stage);
    expect(effectiveStage(t({ status, stage: undefined }))).toBe(stage);
  });

  it('cancelled with stage null is OFF the board (null)', () => {
    expect(effectiveStage(t({ status: 'cancelled', stage: null }))).toBeNull();
  });

  it('a REAL stage wins over the status mirror', () => {
    expect(effectiveStage(t({ status: 'todo', stage: 'deployed' }))).toBe('deployed');
    expect(effectiveStage(t({ status: 'completed', stage: 'draft' }))).toBe('draft');
  });

  it('an unknown stage string is treated as unstamped, not rendered as a column', () => {
    expect(effectiveStage(t({ status: 'in_progress', stage: 'bogus' as never }))).toBe('claimed');
  });
});

describe('columnFor / groupByColumn — the blocked lane is by STATUS, any stage', () => {
  it('blocked status lands in the blocked lane whatever its stage', () => {
    expect(columnFor(t({ status: 'blocked', stage: 'evidence' }))).toBe(BLOCKED_LANE);
    expect(columnFor(t({ status: 'blocked', stage: null }))).toBe(BLOCKED_LANE);
  });

  it('every column exists even when empty, and cancelled tasks are dropped', () => {
    const groups = groupByColumn([
      t({ id: 'a', status: 'todo' }),
      t({ id: 'b', status: 'cancelled' }),
      t({ id: 'c', status: 'blocked', stage: 'claimed' }),
      t({ id: 'd', stage: 'deployed', status: 'completed' }),
    ]);
    expect(Object.keys(groups).sort()).toEqual([...STAGES, BLOCKED_LANE].sort());
    expect(groups.ready.map((x) => x.id)).toEqual(['a']);
    expect(groups.blocked.map((x) => x.id)).toEqual(['c']);
    expect(groups.deployed.map((x) => x.id)).toEqual(['d']);
    expect(groups.claimed).toEqual([]);
    expect(Object.values(groups).flat()).toHaveLength(3);
  });

  it('an empty list yields every column empty (never a crash)', () => {
    const groups = groupByColumn([]);
    expect(Object.values(groups).every((g) => g.length === 0)).toBe(true);
  });
});

describe('missingPunchFields — the draft card line + the form error twin', () => {
  it('both missing on a task never filed as a punch', () => {
    expect(missingPunchFields({})).toEqual(['doneWhen', 'proofKind']);
  });
  it('blank done-when counts as missing; a proof kind alone is not enough', () => {
    expect(missingPunchFields({ doneWhen: '   ', proofKind: 'browser' })).toEqual(['doneWhen']);
  });
  it('a LEGACY STRING doneWhen is never satisfying, even non-blank — it cannot name an owner or a proof', () => {
    expect(missingPunchFields({ doneWhen: 'the button works', proofKind: 'test' })).toEqual(['doneWhen']);
  });
  it('an empty or malformed clause array still counts as missing', () => {
    expect(missingPunchFields({ doneWhen: [], proofKind: 'test' })).toEqual(['doneWhen']);
    expect(missingPunchFields({ doneWhen: [{ text: 'works' }], proofKind: 'test' })).toEqual(['doneWhen']); // owner unset
    expect(
      missingPunchFields({ doneWhen: [{ text: 'works', owner: 'lane' }], proofKind: 'test' }),
    ).toEqual(['doneWhen']); // lane clause missing proof
  });
  it('nothing missing when doneWhen is a complete structured clause array', () => {
    expect(
      missingPunchFields({
        doneWhen: [{ text: 'the button works', owner: 'human' }],
        proofKind: 'test',
      }),
    ).toEqual([]);
    expect(
      missingPunchFields({
        doneWhen: [{ text: 'the button works', owner: 'lane', proof: 'Punch.test.tsx' }],
        proofKind: 'test',
      }),
    ).toEqual([]);
  });
  it('labels read as the card shows them', () => {
    expect(missingLabels(['doneWhen', 'proofKind'])).toBe('done-when, proof');
    expect(missingLabels(['proofKind'])).toBe('proof');
    expect(missingLabels([])).toBe('');
  });
});

describe('rejectReason — the picker verdict tag, read verbatim', () => {
  it('no reject: tag at all → null (pickable, no badge)', () => {
    expect(rejectReason(t({ tags: [] } as Partial<Task>))).toBeNull();
    expect(rejectReason(t({ tags: ['some:other'] } as Partial<Task>))).toBeNull();
    expect(rejectReason(t({} as Partial<Task>))).toBeNull();
  });

  it('reject:tag-excluded + picker:exhausted → the exhausted wording', () => {
    expect(
      rejectReason(t({ tags: ['reject:tag-excluded', 'picker:exhausted'] } as Partial<Task>)),
    ).toBe('exhausted, 2 attempts failed');
  });

  it('reject:tag-excluded + risk:gate → the risk-gate wording (default build: the operator)', () => {
    expect(
      rejectReason(t({ tags: ['reject:tag-excluded', 'risk:gate'] } as Partial<Task>)),
    ).toBe(import.meta.env.VITE_PUNCH_RISK_GATE_LABEL?.trim() || 'waiting on the operator');
  });

  it('riskGateLabel: unset or blank → waiting on the operator; set → that text, trimmed', () => {
    expect(riskGateLabel(undefined)).toBe('waiting on the operator');
    expect(riskGateLabel('')).toBe('waiting on the operator');
    expect(riskGateLabel('   ')).toBe('waiting on the operator');
    expect(riskGateLabel(' waiting on Pat ')).toBe('waiting on Pat');
  });

  it('reject:tag-excluded with neither known secondary tag → generic excluded fallback', () => {
    expect(rejectReason(t({ tags: ['reject:tag-excluded'] } as Partial<Task>))).toBe('excluded');
  });

  it('reject:punch-incomplete reuses the SAME missing-fields wording as a draft card', () => {
    expect(
      rejectReason(
        t({ tags: ['reject:punch-incomplete'], metadata: { punch: {} } } as Partial<Task>),
      ),
    ).toBe('missing: done-when, proof');
    expect(
      rejectReason(
        t({
          tags: ['reject:punch-incomplete'],
          metadata: { punch: { doneWhen: [{ text: 'x', owner: 'lane', proof: 'p' }], proofKind: undefined } },
        } as Partial<Task>),
      ),
    ).toBe('missing: proof');
  });

  it('reject:not-ready → not a punch, no contract', () => {
    expect(rejectReason(t({ tags: ['reject:not-ready'] } as Partial<Task>))).toBe(
      'not a punch, no contract',
    );
  });

  it('an unrecognized reject: value still renders a badge rather than staying silent', () => {
    expect(rejectReason(t({ tags: ['reject:something-new'] } as Partial<Task>))).toBe(
      'reject: something-new',
    );
  });
});

describe('stageIndex', () => {
  it('walks the pipeline in order; null is -1', () => {
    expect(stageIndex('draft')).toBe(0);
    expect(stageIndex('deployed')).toBe(STAGES.length - 1);
    expect(stageIndex(null)).toBe(-1);
  });
});

const drop = (from: string, to: string | null, id = 'task-1'): DropResult =>
  ({
    draggableId: id,
    source: { droppableId: from, index: 0 },
    destination: to === null ? null : { droppableId: to, index: 0 },
    reason: 'DROP',
    mode: 'FLUID',
    type: 'DEFAULT',
    combine: null,
  }) as unknown as DropResult;

describe('stageChangeFromDrop — which drops are a write', () => {
  it('a drop on a different stage column writes { stage } only', () => {
    expect(stageChangeFromDrop(drop('ready', 'claimed'))).toEqual({
      id: 'task-1',
      updates: { stage: 'claimed' },
      to: 'claimed',
    });
  });
  it('every stage is a valid target', () => {
    for (const stage of STAGES) {
      const from = stage === 'draft' ? 'ready' : 'draft';
      expect(stageChangeFromDrop(drop(from, stage))?.updates).toEqual({ stage });
    }
  });
  it('same column, cancelled mid-air, or off-board is a no-op (no write)', () => {
    expect(stageChangeFromDrop(drop('ready', 'ready'))).toBeNull();
    expect(stageChangeFromDrop(drop('ready', null))).toBeNull();
    expect(stageChangeFromDrop(drop('ready', 'not-a-column'))).toBeNull();
    expect(stageChangeFromDrop(drop('ready', ''))).toBeNull();
  });
  it('onto the blocked lane writes status:blocked and leaves the stage alone', () => {
    expect(stageChangeFromDrop(drop('claimed', 'blocked'))).toEqual({
      id: 'task-1',
      updates: { status: 'blocked' },
      to: 'blocked',
    });
  });
  it('OUT of the blocked lane writes the stage AND the status it implies (or it stays blocked)', () => {
    expect(stageChangeFromDrop(drop('blocked', 'verifying'))?.updates).toEqual({
      stage: 'verifying',
      status: 'in_progress',
    });
    expect(stageChangeFromDrop(drop('blocked', 'ready'))?.updates).toEqual({ stage: 'ready', status: 'todo' });
    expect(stageChangeFromDrop(drop('blocked', 'merged'))?.updates).toEqual({ stage: 'merged', status: 'completed' });
  });
  it('the moved task is the DRAGGED one', () => {
    expect(stageChangeFromDrop(drop('ready', 'claimed', 'other'))?.id).toBe('other');
  });
});
