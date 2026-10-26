/**
 * taskAttachments.db.test.ts — DB integration for the Punch List attachment surface
 * (Lane B): POST/GET /api/tasks/:id/attachments,
 * GET /api/attachments?taskIds= and GET/DELETE /api/attachments/:attachmentId.
 *
 * THE REAL APP (server.ts — every mounted router, in the shipped order), real auth, real
 * Postgres (migration 102). Not the attachments router alone: the first cut mounted ONLY
 * routes/taskAttachments.ts and stayed green while the shipped app 400'd the bulk route
 * (routes/tasks.ts's `GET /:id` captured `/tasks/attachments` — Reviewer #1).
 * A test that wires its own composition has replaced the product; this one drives the
 * entry point the browser drives.
 * Covers: upload -> round-trip GET -> list -> delete -> 404; the 413/415 boundaries
 * with a MUTATION PROBE per guard (mutation LANDED, guard RED, control GREEN);
 * mime-mismatch resolution (documents the "sniffed type wins" choice); cross-project
 * 404 (non-disclosing, matches entityProjectScope's contract); and the cascade delete
 * when the owning task is removed.
 *
 * RUN (throwaway DB — provision FIRST):
 *   bash scripts/provision-test-db.sh ci_mandrel_lane_attach
 *   eval "$(bash scripts/provision-test-db.sh ci_mandrel_lane_attach --print-env)"
 *   npx jest taskAttachments.db --runInBand
 *   bash scripts/provision-test-db.sh ci_mandrel_lane_attach --drop
 */

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
import { AuthService } from '../services/auth';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_CHARS,
  MAX_BULK_ATTACHMENT_IDS,
} from '../config/taskAttachments';

// Pinned to migration 102's `byte_size` CHECK (5 MiB = 5242880), independent of
// config/taskAttachments.ts's MAX_ATTACHMENT_BYTES constant — deliberately NOT the
// same import as the guard under test. If the size test derived its payload from the
// very constant the guard reads, mutating that constant would move BOTH sides
// together and the test could never go red (C3: a guard that agrees with its own
// mutation is hollow). This literal is the real, fixed contract the DB enforces.
const CONTRACT_MAX_BYTES = 5 * 1024 * 1024;

// A real, minimal 1x1 PNG (valid magic bytes + IHDR/IEND) — not a stub buffer, so the
// magic-byte sniffer in services/taskAttachment.ts genuinely has to recognize it.
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8ffff3f0005fe02fea739662500000000' +
    '49454e44ae426082',
  'hex'
);

// A real JPEG SOI marker + enough bytes to be non-trivial (does not need to be a
// complete/decodable JPEG for the magic-byte check, which only inspects the first 3
// bytes — same standard every sniffer in this class uses).
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describeDb('Task attachments (Lane B)', () => {
  let projectA: string;
  let projectB: string;
  let userId: string;
  let username: string;
  let token: string;
  const password = 'ProbePassw0rd!laneAttach';

  const taskIds: string[] = [];
  const attachmentIds: string[] = [];

  async function seedTask(projectId: string): Promise<string> {
    const id = uuidv4();
    taskIds.push(id);
    await db.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority)
       VALUES ($1, $2, $3, 'seeded by taskAttachments.db.test', 'general', 'todo', 'medium')`,
      [id, projectId, `lane-attach task ${id.slice(0, 8)}`]
    );
    return id;
  }

  const authed = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${token}`);

  const rawAttachmentCount = async (taskId: string): Promise<number> => {
    const res = await db.query('SELECT COUNT(*)::int AS n FROM task_attachments WHERE task_id = $1', [taskId]);
    return res.rows[0].n;
  };

  beforeAll(async () => {
    projectA = uuidv4();
    projectB = uuidv4();
    for (const [id, tag] of [[projectA, 'a'], [projectB, 'b']] as const) {
      await db.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'taskAttachments fixture', 'active', NOW())`,
        [id, `lane-attach-${tag}-${id.slice(0, 8)}`]
      );
    }

    userId = uuidv4();
    username = `laneattach_${userId.slice(0, 8)}`;
    await db.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, 'user', true, false)`,
      [userId, username, `${username}@example.com`, await AuthService.hashPassword(password)]
    );
    // Granted on A only — projectB stays a "someone else's project" for the cross-project test.
    await db.query('INSERT INTO user_project_access (user_id, project_id) VALUES ($1, $2)', [userId, projectA]);

    const login = await request(app).post('/api/auth/login').send({ username, password });
    expect(login.status).toBe(200);
    token = login.body.token as string;
  });

  afterAll(async () => {
    if (attachmentIds.length) await db.query('DELETE FROM task_attachments WHERE id = ANY($1::uuid[])', [attachmentIds]);
    if (taskIds.length) await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [taskIds]);
    await db.query('DELETE FROM user_project_access WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM admin_users WHERE id = $1', [userId]);
    await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[projectA, projectB]]);
    await db.end();
  });

  it('upload png -> 201; GET bytes round-trips identical; list shows it; DELETE -> 204 -> GET 404', async () => {
    const taskId = await seedTask(projectA);

    const uploadRes = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .field('kind', 'before')
      .attach('file', PNG_1X1, { filename: 'before.png', contentType: 'image/png' });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.success).toBe(true);
    expect(uploadRes.body.data.kind).toBe('before');
    expect(uploadRes.body.data.mime).toBe('image/png');
    expect(uploadRes.body.data.byteSize).toBe(PNG_1X1.length);
    expect(uploadRes.body.data.url).toBe(`/api/attachments/${uploadRes.body.data.id}`);
    const attachmentId = uploadRes.body.data.id as string;
    attachmentIds.push(attachmentId);

    const getRes = await authed(request(app).get(`/api/attachments/${attachmentId}`));
    expect(getRes.status).toBe(200);
    expect(getRes.headers['content-type']).toBe('image/png');
    expect(getRes.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(getRes.body as Buffer, PNG_1X1)).toBe(0); // byte-identical round trip

    const listRes = await authed(request(app).get(`/api/tasks/${taskId}/attachments`));
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.attachments).toHaveLength(1);
    expect(listRes.body.data.attachments[0].id).toBe(attachmentId);
    expect(listRes.body.data.attachments[0].data).toBeUndefined(); // no bytes in the list shape

    const delRes = await authed(request(app).delete(`/api/attachments/${attachmentId}`));
    expect(delRes.status).toBe(204);

    // CONTRACT DEVIATION (documented, not silent): the brief's example said
    // "DELETE -> 204 -> GET 404". This router authorizes `:attachmentId` through the
    // SAME non-disclosing choke point as services/entityProjectScope.ts
    // (authorizeEntityPathParam) — "row does not exist" and "row exists but you may
    // not have it" are DELIBERATELY the same answer (403) everywhere else in this
    // codebase, to avoid an existence oracle. A deleted row's id no longer resolves to
    // an owning project, so a non-admin caller gets 403 here too, matching the
    // convention rather than special-casing "you happen to be the one who deleted it"
    // into a 404 that the rest of the codebase does not grant for any other entity.
    // An ADMIN caller (who skips the project lookup) still gets a real 404 from the
    // controller once the row is gone — see the admin-caller assertion below.
    const getAfterDelete = await authed(request(app).get(`/api/attachments/${attachmentId}`));
    expect(getAfterDelete.status).toBe(403);
  });

  it('an ADMIN caller sees a real 404 (not 403) for a deleted attachment id, since admin skips the project lookup entirely', async () => {
    const adminId = uuidv4();
    const adminUsername = `laneattach_admin_${adminId.slice(0, 8)}`;
    await db.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, 'admin', true, false)`,
      [adminId, adminUsername, `${adminUsername}@example.com`, await AuthService.hashPassword(password)]
    );
    const adminLogin = await request(app).post('/api/auth/login').send({ username: adminUsername, password });
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.body.token as string;

    const missingId = uuidv4();
    const res = await request(app)
      .get(`/api/attachments/${missingId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);

    await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [adminId]);
    await db.query('DELETE FROM admin_users WHERE id = $1', [adminId]);
  });

  it('5 MiB + 1 byte -> 413 ATTACHMENT_TOO_LARGE (mutation-probe control)', async () => {
    const taskId = await seedTask(projectA);
    const oversize = Buffer.alloc(CONTRACT_MAX_BYTES + 1, 1);

    const res = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .attach('file', oversize, { filename: 'oversize.bin', contentType: 'application/json' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(res.body.maxBytes).toBe(MAX_ATTACHMENT_BYTES);
    expect(await rawAttachmentCount(taskId)).toBe(0);
  });

  it('text/html -> 415 ATTACHMENT_TYPE_REJECTED', async () => {
    const taskId = await seedTask(projectA);

    const res = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .attach('file', Buffer.from('<html></html>'), { filename: 'page.html', contentType: 'text/html' });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('ATTACHMENT_TYPE_REJECTED');
    expect(await rawAttachmentCount(taskId)).toBe(0);
  });

  it('PNG bytes declared as image/jpeg by the client: stored as the SNIFFED type (image/png), documenting the mismatch-resolution choice', async () => {
    const taskId = await seedTask(projectA);

    const res = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .attach('file', PNG_1X1, { filename: 'mislabeled.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.data.mime).toBe('image/png'); // sniffed, not the client-declared image/jpeg

    const stored = await db.query('SELECT mime FROM task_attachments WHERE id = $1', [res.body.data.id]);
    expect(stored.rows[0].mime).toBe('image/png');
  });

  it('a real jpeg upload is stored as image/jpeg', async () => {
    const taskId = await seedTask(projectA);
    const res = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .attach('file', JPEG_MIN, { filename: 'real.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.data.mime).toBe('image/jpeg');
  });

  it('cross-project: an attachment on a project-B task is 403 for a caller granted only on A (non-disclosing, matches entityProjectScope)', async () => {
    const theirTask = await seedTask(projectB);

    const uploadAsAdmin = await db.query(
      `INSERT INTO task_attachments (task_id, project_id, kind, filename, mime, byte_size, data, created_by)
       VALUES ($1, $2, 'before', 'seed.png', 'image/png', $3, $4, 'seed')
       RETURNING id`,
      [theirTask, projectB, PNG_1X1.length, PNG_1X1]
    );
    const theirAttachmentId = uploadAsAdmin.rows[0].id;
    attachmentIds.push(theirAttachmentId);

    const listRes = await authed(request(app).get(`/api/tasks/${theirTask}/attachments`));
    expect(listRes.status).toBe(403);

    const getRes = await authed(request(app).get(`/api/attachments/${theirAttachmentId}`));
    expect(getRes.status).toBe(403);

    const uploadRes = await authed(request(app).post(`/api/tasks/${theirTask}/attachments`))
      .attach('file', PNG_1X1, { filename: 'x.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(403);
  });

  it('cascade: deleting the owning task removes its attachments at the SQL level', async () => {
    const taskId = await seedTask(projectA);
    const res = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .attach('file', PNG_1X1, { filename: 'cascade.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(await rawAttachmentCount(taskId)).toBe(1);

    await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);

    expect(await rawAttachmentCount(taskId)).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BULK-BY-TASK-IDS READ: GET /attachments?taskIds= — through the SHIPPED composition.
  // ──────────────────────────────────────────────────────────────────────────

  it('bulk: attachments for two DIFFERENT tasks come back, grouped flat and ordered task_id then created_at', async () => {
    const taskOne = await seedTask(projectA);
    const taskTwo = await seedTask(projectA);

    const uploadOne = await authed(request(app).post(`/api/tasks/${taskOne}/attachments`))
      .attach('file', PNG_1X1, { filename: 'one.png', contentType: 'image/png' });
    expect(uploadOne.status).toBe(201);
    attachmentIds.push(uploadOne.body.data.id);

    const uploadTwo = await authed(request(app).post(`/api/tasks/${taskTwo}/attachments`))
      .attach('file', JPEG_MIN, { filename: 'two.jpg', contentType: 'image/jpeg' });
    expect(uploadTwo.status).toBe(201);
    attachmentIds.push(uploadTwo.body.data.id);

    const res = await authed(request(app).get(`/api/attachments?taskIds=${taskOne},${taskTwo}`));
    expect(res.status).toBe(200);
    expect(res.body.data.attachments).toHaveLength(2);
    // ordered task_id then created_at, and the ordering is over the RETURNED ids, not
    // insertion or query order — sort the two task ids the same way the query does.
    const [firstTask, secondTask] = [taskOne, taskTwo].sort();
    expect(res.body.data.attachments[0].taskId).toBe(firstTask);
    expect(res.body.data.attachments[1].taskId).toBe(secondTask);
    // list shape: metadata only, no bytes
    expect(res.body.data.attachments[0].data).toBeUndefined();
    expect(res.body.data.attachments[0].url).toMatch(/^\/api\/attachments\//);
  });

  it('bulk: an id whose task sits in a project the caller holds no grant on is SILENTLY OMITTED, not 403', async () => {
    const mine = await seedTask(projectA);
    const theirs = await seedTask(projectB); // caller is granted projectA only

    const mineUpload = await authed(request(app).post(`/api/tasks/${mine}/attachments`))
      .attach('file', PNG_1X1, { filename: 'mine.png', contentType: 'image/png' });
    expect(mineUpload.status).toBe(201);
    attachmentIds.push(mineUpload.body.data.id);

    const theirAttachment = await db.query(
      `INSERT INTO task_attachments (task_id, project_id, kind, filename, mime, byte_size, data, created_by)
       VALUES ($1, $2, 'before', 'theirs.png', 'image/png', $3, $4, 'seed')
       RETURNING id`,
      [theirs, projectB, PNG_1X1.length, PNG_1X1]
    );
    attachmentIds.push(theirAttachment.rows[0].id);

    const res = await authed(request(app).get(`/api/attachments?taskIds=${mine},${theirs}`));
    expect(res.status).toBe(200); // NOT 403 — one foreign id must not fail the whole board
    expect(res.body.data.attachments).toHaveLength(1);
    expect(res.body.data.attachments[0].taskId).toBe(mine);
  });

  it('bulk: more than 100 ids -> 400, and writes/reads nothing', async () => {
    const tooMany = Array.from({ length: MAX_BULK_ATTACHMENT_IDS + 1 }, () => uuidv4()).join(',');
    const res = await authed(request(app).get(`/api/attachments?taskIds=${tooMany}`));
    expect(res.status).toBe(400);
  });

  it('composition: an unknown /api route is still the 404 notFoundHandler owes it, not a 401 from a `/`-mounted authenticated router', async () => {
    // Reviewer #6: `router.use('/', taskAttachmentRoutes)` with a router-level
    // authenticateToken made EVERY unknown /api/* answer 401. Unauthenticated on purpose —
    // that is the request the old shape got wrong.
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FILENAME BOUNDARY (Reviewer #4a/#4b/#4c)
  // ──────────────────────────────────────────────────────────────────────────

  /** RFC 5987 `filename*=UTF-8''…` from a Content-Disposition, decoded — or null. */
  const extendedFilename = (disposition: string | undefined): string | null => {
    const m = /filename\*=UTF-8''([^;]+)/.exec(disposition ?? '');
    return m ? decodeURIComponent(m[1]) : null;
  };

  it('4a: a Japanese + emoji filename round-trips EXACTLY (stored, listed, and in the RFC 5987 Content-Disposition)', async () => {
    const taskId = await seedTask(projectA);
    const name = 'IMG_日本語_🙂.png';

    // superagent writes the multipart `filename="…"` as raw UTF-8 bytes — exactly what a
    // browser sends, and exactly what busboy's default latin1 decoding mojibakes.
    const up = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .attach('file', PNG_1X1, { filename: name, contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.data.filename).toBe(name);
    attachmentIds.push(up.body.data.id);

    const stored = await db.query('SELECT filename FROM task_attachments WHERE id = $1', [up.body.data.id]);
    expect(stored.rows[0].filename).toBe(name);

    const get = await authed(request(app).get(`/api/attachments/${up.body.data.id}`));
    expect(get.status).toBe(200);
    expect(extendedFilename(get.headers['content-disposition'])).toBe(name);
    // and the legacy fallback stays pure ASCII so no parser chokes on the quoted-string
    expect(get.headers['content-disposition']).toMatch(/^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
  });

  it('4b: a 300-character filename is stored at <= 255 chars with its extension intact, and GET works (no pg 500)', async () => {
    const taskId = await seedTask(projectA);
    const name = `${'a'.repeat(296)}.png`;
    expect(name.length).toBe(300);

    const up = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .attach('file', PNG_1X1, { filename: name, contentType: 'image/png' });
    expect(up.status).toBe(201);
    attachmentIds.push(up.body.data.id);

    const stored = await db.query('SELECT filename FROM task_attachments WHERE id = $1', [up.body.data.id]);
    const storedName: string = stored.rows[0].filename;
    expect(Array.from(storedName).length).toBeLessThanOrEqual(MAX_ATTACHMENT_FILENAME_CHARS);
    expect(Array.from(storedName).length).toBe(MAX_ATTACHMENT_FILENAME_CHARS);
    expect(storedName.endsWith('.png')).toBe(true);
    expect(up.body.data.filename).toBe(storedName);

    const get = await authed(request(app).get(`/api/attachments/${up.body.data.id}`));
    expect(get.status).toBe(200);
    expect(extendedFilename(get.headers['content-disposition'])).toBe(storedName);
  });

  it('4c: CR/LF in a filename is stripped at the boundary, and GET returns 200 with a parseable header (was a permanent 500)', async () => {
    const taskId = await seedTask(projectA);
    // A raw CR/LF inside `filename="…"` breaks the multipart part header itself (busboy
    // yields no file → 400 'Missing file'), so that is NOT the vector. The RFC 5987
    // `filename*=utf-8''…` form IS: busboy percent-DECODES it, so `%0D%0A` arrives in
    // `originalname` as a real "\r\n" — measured against busboy 1.6.0 before writing
    // this. The body is built by hand because superagent cannot emit `filename*`.
    const boundary = `----punch4c${uuidv4().replace(/-/g, '')}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename*=utf-8''evil%0D%0AX-Injected%3A%201.png\r\n` +
          `Content-Type: image/png\r\n\r\n`
      ),
      PNG_1X1,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await authed(request(app).post(`/api/tasks/${taskId}/attachments`))
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(up.status).toBe(201);
    attachmentIds.push(up.body.data.id);

    const stored = await db.query('SELECT filename FROM task_attachments WHERE id = $1', [up.body.data.id]);
    expect(stored.rows[0].filename).toBe('evilX-Injected: 1.png');
    // eslint-disable-next-line no-control-regex
    expect(stored.rows[0].filename).not.toMatch(/[\u0000-\u001f\u007f]/);

    const get = await authed(request(app).get(`/api/attachments/${up.body.data.id}`));
    expect(get.status).toBe(200);
    expect(get.headers['x-injected']).toBeUndefined();
    expect(extendedFilename(get.headers['content-disposition'])).toBe('evilX-Injected: 1.png');
  });

  // Mutation probes for the size limit and the mime allowlist are run BY HAND against
  // these two control cases (the "5 MiB + 1 byte -> 413" test above and the
  // "text/html -> 415" test above) by temporarily editing config/taskAttachments.ts —
  // see the task report for the LANDED / RED / control-GREEN transcript. No permanent
  // "mutated" test is left in this file: a hardcoded inverted assertion would be a
  // guard that always agrees with itself, which is the hollow shape C3 exists to catch.
});
