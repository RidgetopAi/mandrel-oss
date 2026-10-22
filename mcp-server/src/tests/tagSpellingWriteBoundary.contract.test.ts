/**
 * THE WRITE BOUNDARY ACTUALLY RUNS THE COLLISION CHECK.
 *
 * WHY THIS EXISTS SEPARATELY FROM tagSpellingWriteWarning.contract.test.ts. That file
 * tests the pure fold with a hand-built population. It would stay GREEN with the check
 * unwired from every write path in the product — a test whose setup re-creates the
 * composition the product performs has replaced the product (CLASSES.md C3). This one
 * drives the SHIPPED TOOLS and asserts the warning reaches the caller's response.
 *
 * THE CONTRACT BEING ASSERTED is the `invalid-scope:` contract, which is the whole reason
 * this fix has the shape it has: the write SUCCEEDS, the tag is stored EXACTLY as written,
 * the problem is NAMED, and the caller is told the spelling to use. A retag alone would
 * silently undo itself the next time somebody typed the other spelling.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CONN = `spell-boundary-conn-${STAMP}`;
const PROJ_NAME = `spell-boundary-P-${STAMP}`;

let projectId: string;

async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN } as any);
}

describe('the tag-spelling collision check runs at the write boundary', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'spelling write boundary') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN } as any);

    // Establish the DOMINANT spelling: three records carrying `needs-operator`.
    for (let i = 0; i < 3; i++) {
      await viaTool('task_create', {
        title: `established spelling ${i} ${STAMP}`,
        type: 'general',
        tags: ['needs-operator'],
      });
    }
  });

  afterAll(async () => {
    await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  test('task_create WARNS about a colliding spelling and still stores the tag verbatim', async () => {
    const res = await viaTool('task_create', {
      title: `variant spelling ${STAMP}`,
      type: 'general',
      tags: ['needs:operator'],
    });
    // ACCEPTED — nothing rejected.
    expect(res.structuredContent.task.id).toBeTruthy();
    // STORED VERBATIM — not normalised behind the caller's back.
    expect(res.structuredContent.task.tags).toContain('needs:operator');
    // NAMED — in the machine channel...
    const warnings: string[] = res.structuredContent.task.tagWarnings ?? [];
    expect(warnings.join(' ')).toContain('needs:operator');
    expect(warnings.join(' ')).toContain('needs-operator');
    // ...and in the human channel, which is the one an agent reads back.
    expect(res.content[0].text).toContain('needs-operator');
  });

  test('A SPELLING NOBODY HAS EVER WRITTEN is caught on the day it is invented', async () => {
    // The mutation probe for the CLASS. A synonym table would return nothing here.
    const res = await viaTool('task_create', {
      title: `invented spelling ${STAMP}`,
      type: 'general',
      tags: ['needs_operator'],
    });
    const warnings: string[] = res.structuredContent.task.tagWarnings ?? [];
    expect(warnings.join(' ')).toContain('needs_operator');
    expect(warnings.join(' ')).toContain('needs-operator');
    expect(res.structuredContent.task.tags).toContain('needs_operator');
  });

  test('the DOMINANT spelling writes silently — the warning is only for someone who can act', async () => {
    const res = await viaTool('task_create', {
      title: `canonical spelling ${STAMP}`,
      type: 'general',
      tags: ['needs-operator'],
    });
    const warnings: string[] = res.structuredContent.task.tagWarnings ?? [];
    expect(warnings.join(' ')).not.toContain('differs only in separators');
  });

  test('an unrelated tag writes silently', async () => {
    const res = await viaTool('task_create', {
      title: `unrelated tag ${STAMP}`,
      type: 'general',
      tags: ['needs-coordinator'],
    });
    const warnings: string[] = res.structuredContent.task.tagWarnings ?? [];
    expect(warnings.join(' ')).not.toContain('differs only in separators');
  });

  test('task_UPDATE warns too — a re-tag splits a queue exactly as a create does', async () => {
    const created = await viaTool('task_create', {
      title: `retag target ${STAMP}`,
      type: 'general',
      tags: ['needs-operator'],
    });
    const res = await viaTool('task_update', {
      taskId: created.structuredContent.task.id,
      tags: ['needs:operator'],
    });
    const blob = JSON.stringify(res);
    expect(blob).toContain('differs only in separators');
    expect(blob).toContain('needs-operator');
  });

  test('decision_record warns too — the other write path that stored tags unvalidated', async () => {
    const res = await viaTool('decision_record', {
      title: `spelling decision ${STAMP}`,
      description: 'a decision carrying a variant tag spelling',
      rationale: 'exercises the decision write path',
      decisionType: 'process',
      impactLevel: 'low',
      tags: ['needs:operator'],
    });
    expect(JSON.stringify(res)).toContain('differs only in separators');
  });
});
