/**
 * Guard test: GET /projects/:id/insights rejects non-UUID ids with 400 and
 * lets a real UUID through to the controller.
 *
 * Backstops the customer-reported "Failed to Load Project Insights — Bad
 * Request": the frontend was sending a synthetic, non-UUID project id
 * (e.g. `aidis-my-project`) to this UUID-validated route, which returns 400.
 * The real fix is on the frontend (don't call UUID routes with a non-UUID id),
 * but this test pins the BACKEND contract the frontend guard is written against:
 *   - synthetic / undefined-like / sentinel ids => 400 (never reach the handler)
 *   - a valid UUID => reaches the handler (here a stub, asserting the param
 *     survived validation)
 *
 * No DB required — validateUUIDParam runs purely on the route param.
 */
import request from 'supertest';
import express from 'express';
import { validateUUIDParam } from '../middleware/validation';

// Minimal app that mirrors the production route shape:
//   router.get('/:id/insights', validateUUIDParam(), <controller>)
// The controller is a stub so we test ONLY the validation gate.
const app = express();
app.get('/projects/:id/insights', validateUUIDParam(), (req, res) => {
  res.status(200).json({ success: true, reachedHandler: true, id: req.params.id });
});

const REAL_UUID = '11111111-2222-4333-8444-555555555555';

describe('GET /projects/:id/insights — UUID param validation gate', () => {
  test.each([
    ['synthetic aidis id', 'aidis-my-project'],
    ['literal "undefined"', 'undefined'],
    ['plainly non-uuid', 'not-a-uuid'],
  ])('rejects %s with 400 and never reaches the handler', async (_label, badId) => {
    const res = await request(app).get(`/projects/${badId}/insights`);
    expect(res.status).toBe(400);
    expect(res.body.reachedHandler).toBeUndefined();
  });

  test('lets a valid UUID through to the handler', async () => {
    const res = await request(app).get(`/projects/${REAL_UUID}/insights`).expect(200);
    expect(res.body.reachedHandler).toBe(true);
    expect(res.body.id).toBe(REAL_UUID);
  });

  // NOTE on the nil/UNASSIGNED sentinel '00000000-0000-0000-0000-000000000000':
  // z.string().uuid() ACCEPTS it (it is a syntactically valid UUID), so the
  // backend does NOT 400 on it. That is precisely why the frontend `isValidUuid`
  // guard (which rejects the sentinel) is the load-bearing fix — covered by the
  // frontend uuid.test.ts. Asserting a 400 here would be wrong; we document it.
  test('the nil/UNASSIGNED sentinel is NOT rejected by backend UUID validation', async () => {
    const res = await request(app)
      .get('/projects/00000000-0000-0000-0000-000000000000/insights');
    expect(res.status).toBe(200); // passes validation — guarded on the frontend instead
  });
});
