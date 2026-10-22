/**
 * taskAttachmentsAgentAuth.db.test.ts — the MACHINE-credential half of an earlier task
 *: the headless Walkthrough critic uploads its own evidence to a
 * Punch List task without a 24h user JWT.
 *
 * BEFORE this task, `taskScopedAttachmentRoutes` and `attachmentRoutes`
 * (routes/taskAttachments.ts) sat behind `router.use(authenticateToken)` — user JWTs
 * only, so the critic had no way to credential itself. `authenticateAgentOrUser`
 * (middleware/agentAuth.ts) already existed for `POST /api/git/push-stats`; the router-level
 * swap is the headline change, but it is not the whole one: the PROJECT-OWNERSHIP layer
 * (middleware/taskAttachmentAuthz.ts's `authorizeTaskIdParam` / `authorizeAttachmentIdParam`)
 * unconditionally required `req.user` and would 401 an agent-authenticated request (which has
 * no `user` by design — see agentAuth.ts) even after the router swap. That gap — and the
 * matching one in `TaskAttachmentController.bulkList`'s `resolveCallerScope` — is only visible
 * by driving the REAL route end-to-end, which is what this suite does, not by reading the
 * router's `.use()` line.
 *
 * RUN (throwaway DB — provision FIRST, matching taskAttachments.db.test.ts):
 *   bash scripts/provision-test-db.sh ci_mandrel_lane_attach_agent
 *   eval "$(bash scripts/provision-test-db.sh ci_mandrel_lane_attach_agent --print-env)"
 *   npx jest taskAttachmentsAgentAuth.db --runInBand
 *   bash scripts/provision-test-db.sh ci_mandrel_lane_attach_agent --drop
 */

// BEFORE the app (and therefore config/environment, which reads MANDREL_AGENT_TOKEN once
// at module load) is imported — mirrors unauthenticatedRoutesHttp.test.ts.
const AGENT_TOKEN = 'test-agent-token-taskattach-9b2c7f';
process.env.MANDREL_AGENT_TOKEN = AGENT_TOKEN;

import { describeDb } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

import app from '../server';
import { db } from '../database/connection';

// A real, minimal 1x1 PNG (valid magic bytes + IHDR/IEND) — same fixture as
// taskAttachments.db.test.ts, so the magic-byte sniffer genuinely has to recognize it.
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea739662500000000' +
    '49454e44ae426082',
  'hex'
);

describeDb('Task attachments accept the MANDREL_AGENT_TOKEN service credential', () => {
  let projectId: string;
  const taskIds: string[] = [];
  const attachmentIds: string[] = [];

  async function seedTask(): Promise<string> {
    const id = uuidv4();
    taskIds.push(id);
    await db.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority)
       VALUES ($1, $2, $3, 'seeded by taskAttachmentsAgentAuth.db.test', 'general', 'todo', 'medium')`,
      [id, projectId, `agent-auth task ${id.slice(0, 8)}`]
    );
    return id;
  }

  const agentAuthed = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${AGENT_TOKEN}`);

  beforeAll(async () => {
    projectId = uuidv4();
    await db.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, 'taskAttachmentsAgentAuth fixture', 'active', NOW())`,
      [projectId, `agent-auth-${projectId.slice(0, 8)}`]
    );
  });

  afterAll(async () => {
    if (attachmentIds.length) await db.query('DELETE FROM task_attachments WHERE id = ANY($1::uuid[])', [attachmentIds]);
    if (taskIds.length) await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [taskIds]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await db.end();
  });

  it('ANCHOR — NO credential -> 401 (the agent path does not open the route to anyone)', async () => {
    const taskId = await seedTask();
    const res = await request(app)
      .post(`/api/tasks/${taskId}/attachments`)
      .attach('file', PNG_1X1, { filename: 'evidence.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('ANCHOR — POST with the MANDREL_AGENT_TOKEN -> 201, stored as kind=evidence, no user JWT', async () => {
    const taskId = await seedTask();
    const res = await agentAuthed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .field('kind', 'evidence')
      .attach('file', PNG_1X1, { filename: 'evidence.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.kind).toBe('evidence');
    expect(res.body.data.mime).toBe('image/png');
    attachmentIds.push(res.body.data.id);

    const stored = await db.query('SELECT kind, project_id FROM task_attachments WHERE id = $1', [res.body.data.id]);
    expect(stored.rows[0].kind).toBe('evidence');
    expect(stored.rows[0].project_id).toBe(projectId);
  });

  it('GET /tasks/:id/attachments with the agent token -> 200, lists the evidence it just uploaded', async () => {
    const taskId = await seedTask();
    const up = await agentAuthed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .field('kind', 'evidence')
      .attach('file', PNG_1X1, { filename: 'evidence.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    attachmentIds.push(up.body.data.id);

    const res = await agentAuthed(request(app).get(`/api/tasks/${taskId}/attachments`));
    expect(res.status).toBe(200);
    expect(res.body.data.attachments).toHaveLength(1);
    expect(res.body.data.attachments[0].kind).toBe('evidence');
  });

  it('GET /attachments/:attachmentId with the agent token -> 200, byte-identical round trip', async () => {
    const taskId = await seedTask();
    const up = await agentAuthed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .field('kind', 'evidence')
      .attach('file', PNG_1X1, { filename: 'evidence.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const attachmentId = up.body.data.id as string;
    attachmentIds.push(attachmentId);

    const res = await agentAuthed(request(app).get(`/api/attachments/${attachmentId}`));
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, PNG_1X1)).toBe(0);
  });

  it('DELETE /attachments/:attachmentId with the agent token -> 204', async () => {
    const taskId = await seedTask();
    const up = await agentAuthed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .field('kind', 'evidence')
      .attach('file', PNG_1X1, { filename: 'evidence.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const attachmentId = up.body.data.id as string;

    const del = await agentAuthed(request(app).delete(`/api/attachments/${attachmentId}`));
    expect(del.status).toBe(204);
  });

  it('GET /attachments?taskIds= (bulk board read) with the agent token -> 200, unrestricted like admin', async () => {
    const taskId = await seedTask();
    const up = await agentAuthed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .field('kind', 'evidence')
      .attach('file', PNG_1X1, { filename: 'evidence.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    attachmentIds.push(up.body.data.id);

    const res = await agentAuthed(request(app).get(`/api/attachments?taskIds=${taskId}`));
    expect(res.status).toBe(200);
    expect(res.body.data.attachments).toHaveLength(1);
    expect(res.body.data.attachments[0].taskId).toBe(taskId);
  });

  it('a garbage bearer token (neither the agent secret nor a JWT) -> 401', async () => {
    const taskId = await seedTask();
    const res = await request(app)
      .post(`/api/tasks/${taskId}/attachments`)
      .set('Authorization', 'Bearer not-the-agent-token')
      .attach('file', PNG_1X1, { filename: 'evidence.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });
});
