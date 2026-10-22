/**
 * taskAttachmentsAgentAuthFailClosed.test.ts — the fail-CLOSED half of an earlier task.
 *
 * `unauthenticatedRoutesHttp.test.ts` already proves `authenticateAgentOrUser` itself
 * refuses when `MANDREL_AGENT_TOKEN` is unset (an `||''` default plus a naive compare
 * would let the empty string through). This file proves the SAME property one layer up,
 * on the REAL `taskAttachments` routers this task changed: with the credential
 * unconfigured, the exact header that would have worked if it HAD been configured still
 * gets a 401 from `POST /tasks/:id/attachments`, not a 201 and not a silent passthrough.
 * That distinction matters here specifically because this task also touched
 * `middleware/taskAttachmentAuthz.ts` (the project-ownership `router.param` layer) to stop
 * it 401ing an agent-authenticated request for lacking `req.user` — a fix broad enough that
 * it is worth re-confirming, on THIS router, that "no valid credential" still means 401 and
 * not "treated as agent-authenticated by accident".
 *
 * DB-free: no route below reaches a handler. `authenticateAgentOrUser` 401s straight from
 * the header — the presented value has no dots, so `authenticateToken`'s own JWT-shape
 * check (`token.split('.').length !== 3`) rejects it before any `AuthService` or database
 * call, exactly as it does for a plain garbage token.
 */

import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

const AGENT_TOKEN = 'test-agent-token-taskattach-9b2c7f'; // same shape as the DB suite's

describe('with MANDREL_AGENT_TOKEN unset, the taskAttachments routers stay CLOSED to the same header', () => {
  let taskApp: express.Express;
  let attachmentApp: express.Express;

  beforeAll(() => {
    delete process.env.MANDREL_AGENT_TOKEN;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { taskScopedAttachmentRoutes, attachmentRoutes } = require('../routes/taskAttachments');
      taskApp = express();
      taskApp.use('/tasks', taskScopedAttachmentRoutes);
      attachmentApp = express();
      attachmentApp.use('/attachments', attachmentRoutes);
    });
  });

  afterAll(() => {
    delete process.env.MANDREL_AGENT_TOKEN;
  });

  it('POST /tasks/:id/attachments — the token that would have worked if configured -> 401, not 201', async () => {
    const res = await request(taskApp)
      .post(`/tasks/${uuidv4()}/attachments`)
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .attach('file', Buffer.from('irrelevant'), { filename: 'evidence.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('GET /tasks/:id/attachments — same header, same refusal', async () => {
    const res = await request(taskApp).get(`/tasks/${uuidv4()}/attachments`).set('Authorization', `Bearer ${AGENT_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('DELETE /attachments/:attachmentId — same header, same refusal', async () => {
    const res = await request(attachmentApp)
      .delete(`/attachments/${uuidv4()}`)
      .set('Authorization', `Bearer ${AGENT_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('an anonymous request (no header at all) still -> 401', async () => {
    const res = await request(taskApp).post(`/tasks/${uuidv4()}/attachments`);
    expect(res.status).toBe(401);
  });
});
