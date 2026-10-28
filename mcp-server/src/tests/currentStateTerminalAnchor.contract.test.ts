/**
 * current-state — a FINISHED task anchor is not held open by a weakly related task
 * (dogfood finding 7: a completed thread's nextAction said "Start an earlier task",
 * an unrelated task reached through `related_to`).
 *
 * Drives the REAL surface (validateToolArguments → routeExecutor, altitude current) against the CI
 * Postgres, building every graph with the public tools.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { THREAD_PROJECTION_ALTITUDES } from '../config/threadConfig.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import { ARTIFACT_REF_CONFIG, PROVIDER_RULES, effectiveProviders, effectiveArtifactTypes } from '../config/artifactRefConfig.js';
import { validateArtifactRef } from '../services/artifactRef.js';

const STAMP = Date.now();
const CONN = `current-state-conn-${STAMP}`;
const PROJ_NAME = `current-state-P-${STAMP}`;
/** The altitude under test, read from config — never a literal typed into this file. */
const CURRENT = THREAD_PROJECTION_ALTITUDES[0];

let projectId: string;


async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

async function createTask(title: string, status?: string, metadata?: any): Promise<string> {
  const r = await viaTool('task_create', { title, ...(metadata ? { metadata } : {}) });
  const id = r.structuredContent.task.id;
  // a move to `blocked` must now NAME its blocker.
  if (status) await viaTool('task_update', {
    taskId: id, status, ...(status === 'blocked' ? { blockedOn: 'agent' } : {}) });
  return id;
}
async function link(from: string, fromType: string, to: string, toType: string, edgeType: string) {
  return viaTool('link', { from, fromType, to, toType, edgeType });
}

/** A valid artifact reference derived from (and validated by) the product's own config. */
function artifactRef(): Record<string, unknown> {
  for (const artifactType of effectiveArtifactTypes()) {
    for (const provider of effectiveProviders()) {
      const rule = PROVIDER_RULES[provider];
      const candidate: Record<string, unknown> = {
        artifactType,
        repository: 'mandrel',
        head: 'a'.repeat(40),
        base: 'b'.repeat(40),
        sha256: 'c'.repeat(64),
        producerThread: 'T-current-state-contract',
        retrieval: {
          provider,
          [rule.locatorField]:
            rule.locatorField === 'uri'
              ? 'https://example.invalid/artifacts/thing.bundle'
              : '/srv/artifacts/thing.bundle',
        },
      };
      if (validateArtifactRef(candidate).ok) return candidate;
    }
  }
  throw new Error('no valid (artifactType × provider) combination — fixture cannot be built');
}
const artifactMetadata = () => ({ [ARTIFACT_REF_CONFIG.metadataKey]: [artifactRef()] });


describe('recall_thread altitude:current — terminal task anchor, structural edges only', () => {
  let weakRoot: string, weakTask: string;
  let subRoot: string, subTask: string;
  let liveRoot: string, liveTask: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'terminal anchor contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    // Completed + released, with a todo task linked ONLY by related_to.
    weakRoot = await createTask('WEAK root', 'completed', artifactMetadata());
    weakTask = await createTask('UNRELATED sync E2E');
    await link(weakTask, 'task', weakRoot, 'task', 'related_to');

    // Completed + released, with a todo SUBTASK.
    subRoot = await createTask('SUB root', 'completed', artifactMetadata());
    subTask = await createTask('STRUCTURAL subtask');
    await link(subTask, 'task', subRoot, 'task', 'subtask_of');

    // In-progress anchor with a todo task linked by related_to — behaviour unchanged.
    liveRoot = await createTask('LIVE root', 'in_progress');
    liveTask = await createTask('LIVE related todo');
    await link(liveTask, 'task', liveRoot, 'task', 'related_to');
    // The product mints an auto `informs` edge alongside this link; strip it so the pair is
    // joined by related_to ALONE — otherwise the fixture cannot tell a gate that ignores the
    // anchor's status from one that honours it.
    await db.query(
      `DELETE FROM links WHERE project_id = $1 AND edge_type <> 'related_to'
         AND from_id IN ($2, $3) AND to_id IN ($2, $3)`,
      [projectId, liveRoot, liveTask]
    );
  }, 60000);

  afterAll(async () => {
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]).catch(() => {});
  });

  async function next(anchor: string) {
    const v = validateToolArguments('recall_thread', { anchor, altitude: CURRENT });
    const r = await routeExecutor('recall_thread', v, { connectionId: CONN });
    return r.structuredContent!.currentState.nextAction;
  }

  test('related_to is not a structural edge (config)', () => {
    expect(CURRENT_STATE_CONFIG.structuralEdgeTypes).not.toContain('related_to');
    expect(CURRENT_STATE_CONFIG.structuralEdgeTypes).toContain('subtask_of');
  });

  test('completed anchor + todo task via related_to only → gate complete, names no task', async () => {
    const na = await next(weakRoot);
    expect(na.gate).toBe('complete');
    expect(JSON.stringify(na)).not.toContain(weakTask);
    expect(JSON.stringify(na)).not.toContain('UNRELATED sync E2E');
    expect(JSON.stringify(na)).not.toMatch(/Start task/);
  });

  test('completed anchor + todo subtask → in-progress gate naming the subtask', async () => {
    const na = await next(subRoot);
    expect(na.gate).toBe('in-progress');
    expect(na.targetId).toBe(subTask);
    expect(na.action).toBe(`Start task ${subTask} — STRUCTURAL subtask`);
  });

  test('in_progress anchor + todo task via related_to → unchanged from origin/main', async () => {
    // The old code's first active task is the in_progress anchor itself → "Continue" on it, and the
    // related_to todo stays counted in the open-task total. Asserted verbatim, not re-derived.
    const na = await next(liveRoot);
    expect(na.gate).toBe('in-progress');
    expect(na.targetId).toBe(liveRoot);
    expect(na.action).toBe(`Continue task ${liveRoot} — LIVE root`);
    expect(na.gateReason).toBe('2 open task(s)');
  });
});
