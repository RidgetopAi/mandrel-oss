/**
 * Contract: every `FROM node:` base image in the repo is pinned to an exact patch release at
 * or above the security floor.
 *
 * WHY A FLOOR AND NOT JUST THE MAJOR: the gate's node-pin stage already
 * holds every declaration to the .nvmrc MAJOR. That cannot see a floating `node:22-slim`
 * resolving to whatever patch the build host has cached — the fleet build does not --pull —
 * which is how the fleet stayed on 22.23.3 / 22.22.3 past the 22.23.4 security release
 * (sweep). An exact `22.y.z` tag forces the pull; this test keeps it exact and
 * keeps it at or above the floor.
 *
 * Raise NODE_BASE_IMAGE_FLOOR with the Dockerfiles when a newer Node 22 security release
 * ships. The population is every Dockerfile `git ls-files` reports — not a hand list.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The lowest Node release a shipped image may run: v22.23.4 (security release, 2026-10-20). */
const NODE_BASE_IMAGE_FLOOR: readonly [number, number, number] = [22, 23, 4];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface NodeFrom { site: string; ref: string }

function nodeFromLines(): NodeFrom[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f));
  const out: NodeFrom[] = [];
  for (const f of files) {
    readFileSync(path.join(repoRoot, f), 'utf8').split('\n').forEach((line, i) => {
      // Image ref = first token after FROM that is not a --flag (e.g. --platform=…).
      const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(line);
      if (m && /^(?:[^/\s]+\/)*node(?:[:@]|$)/i.test(m[1])) out.push({ site: `${f}:${i + 1}`, ref: m[1] });
    });
  }
  return out;
}

function belowFloor(v: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== NODE_BASE_IMAGE_FLOOR[i]) return v[i] < NODE_BASE_IMAGE_FLOOR[i];
  }
  return false;
}

describe('node base images — exact patch at or above the security floor', () => {
  it('every FROM node: stage is an exact x.y.z tag >= the floor', () => {
    const froms = nodeFromLines();
    // Absent is not clean: a population of zero means the scan found nothing to judge.
    expect(froms.length, 'no FROM node: line found — the scan measured nothing').toBeGreaterThan(0);
    const bad = froms.flatMap(({ site, ref }) => {
      const m = /:(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/.exec(ref);
      if (!m) return [`${site} ${ref} — not an exact x.y.z tag (a floating tag builds from the host's cache)`];
      const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return belowFloor(v) ? [`${site} ${ref} — below floor ${NODE_BASE_IMAGE_FLOOR.join('.')}`] : [];
    });
    expect(bad).toEqual([]);
  });
});
