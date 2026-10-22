/**
 * projectSort — the single "most-recently-active first" ordering shared by every
 * project selector. These tests are the MUTATION guard: reverse or remove the
 * comparator (utils/projectSort) and the ordering assertions go RED.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectEntity } from '../api/generated/models/ProjectEntity';
import { compareByRecentActivity, sortProjectsByRecentActivity } from './projectSort';

const proj = (name: string, last_activity?: string): ProjectEntity =>
  ({
    id: `id-${name}`,
    name,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_activity,
  }) as ProjectEntity;

describe('sortProjectsByRecentActivity', () => {
  it('orders projects most-recently-active FIRST (last_activity DESC)', () => {
    const older = proj('Older', '2026-05-01T00:00:00.000Z');
    const newest = proj('Newest', '2026-07-10T00:00:00.000Z');
    const middle = proj('Middle', '2026-06-15T00:00:00.000Z');

    const sorted = sortProjectsByRecentActivity([older, newest, middle]);

    expect(sorted.map((p) => p.name)).toEqual(['Newest', 'Middle', 'Older']);
  });

  it('sorts a project with no last_activity LAST', () => {
    const active = proj('Active', '2026-07-01T00:00:00.000Z');
    const never = proj('Never'); // undefined last_activity → epoch 0 → last
    const alsoActive = proj('AlsoActive', '2026-06-01T00:00:00.000Z');

    const sorted = sortProjectsByRecentActivity([never, active, alsoActive]);

    expect(sorted.map((p) => p.name)).toEqual(['Active', 'AlsoActive', 'Never']);
  });

  it('does NOT mutate the input array', () => {
    const input = [proj('A', '2026-01-01T00:00:00.000Z'), proj('B', '2026-07-01T00:00:00.000Z')];
    const before = input.map((p) => p.name);

    sortProjectsByRecentActivity(input);

    expect(input.map((p) => p.name)).toEqual(before); // original order untouched
  });

  it('compareByRecentActivity returns negative when a is more recent than b', () => {
    const a = proj('a', '2026-07-01T00:00:00.000Z');
    const b = proj('b', '2026-01-01T00:00:00.000Z');
    expect(compareByRecentActivity(a, b)).toBeLessThan(0);
    expect(compareByRecentActivity(b, a)).toBeGreaterThan(0);
  });
});
