import { describe, expect, it } from 'vitest';
import type { DoneWhenClause } from '../src/board.js';
import { passViolation, score, type CriticVerdict } from '../src/critic.js';

const lane = (text: string): DoneWhenClause => ({ text, owner: 'lane', proof: 'p' });
const MUT = lane('Critic applies and shows RED: changing x makes y fail; Unmutated control GREEN.');
const pass = (clauses: CriticVerdict['clauses']): CriticVerdict => ({ verdict: 'PASS', note: '', clauses });
const red = { passed: false };
const green = { passed: true };

describe('mechanical PASS rules', () => {
  it('accepts a PASS with every lane clause verified', () => {
    const v = pass([{ index: 0, verified: true }, { index: 1, verified: true }]);
    expect(score(v, [lane('a'), lane('b')]).verdict).toBe('PASS');
  });

  it('scores a PASS with one unverified owner:lane clause as FAIL', () => {
    const v = pass([{ index: 0, verified: true }, { index: 1, verified: false }]);
    const s = score(v, [lane('a'), lane('b')]);
    expect(s.verdict).toBe('FAIL');
    expect(s.note).toMatch(/clause 1/);
  });

  it('scores a PASS that omits a lane clause as FAIL', () => {
    expect(score(pass([{ index: 0, verified: true }]), [lane('a'), lane('b')]).verdict).toBe('FAIL');
  });

  it('does not require owner:human clauses to be verified', () => {
    const human: DoneWhenClause = { text: 'looks right', owner: 'human' };
    expect(score(pass([{ index: 0, verified: true }]), [lane('a'), human]).verdict).toBe('PASS');
  });

  it('scores a mutation clause with a named mutation and no red run as FAIL', () => {
    const v = pass([{ index: 0, verified: true, mutations: [{ name: 'flip-rule', green }] }]);
    const s = score(v, [MUT]);
    expect(s.verdict).toBe('FAIL');
    expect(s.note).toMatch(/flip-rule.*no red run/);
  });

  it('scores a mutation clause listing no mutation as FAIL', () => {
    expect(score(pass([{ index: 0, verified: true }]), [MUT]).verdict).toBe('FAIL');
  });

  it('scores red and green both passing as FAIL', () => {
    const v = pass([{ index: 0, verified: true, mutations: [{ name: 'm', red: green, green }] }]);
    const s = score(v, [MUT]);
    expect(s.verdict).toBe('FAIL');
    expect(s.note).toMatch(/GREEN in both runs/);
  });

  it('scores a failing unmutated control as FAIL', () => {
    const v = pass([{ index: 0, verified: true, mutations: [{ name: 'm', red, green: red }] }]);
    expect(score(v, [MUT]).verdict).toBe('FAIL');
  });

  it('accepts red failing with a green control', () => {
    const v = pass([{ index: 0, verified: true, mutations: [{ name: 'm', red, green }] }]);
    expect(score(v, [MUT]).verdict).toBe('PASS');
  });

  it('never touches a non-PASS verdict', () => {
    for (const verdict of ['FAIL', 'COULD-NOT-MEASURE', 'CONTRACT-DEFECT'] as const) {
      expect(passViolation({ verdict, note: '', clauses: [] }, [MUT])).toBeNull();
    }
  });
});
