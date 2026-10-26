/**
 * Behind host nginx -> Traefik -> tenant frontend nginx (TRUST_PROXY=3) req.ip must be the
 * real client, so the login limiter buckets per client, not per proxy.
 */
import express from 'express';
import request from 'supertest';
import { parseTrustProxy } from '../config/environment';
import { authLimiter } from '../routes/auth';

function makeApp() {
  const app = express();
  app.set('trust proxy', parseTrustProxy('3'));
  app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
  app.post('/login', authLimiter, (_req, res) => { res.json({ ok: true }); });
  return app;
}
const chain = (client: string) => `${client}, 172.19.0.1, 172.18.0.5`;

describe('trust proxy = 3 with a 3-hop X-Forwarded-For chain', () => {
  it('resolves req.ip to the client address', async () => {
    const res = await request(makeApp()).get('/ip').set('X-Forwarded-For', chain('203.0.113.7'));
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('gives two client addresses separate login-limiter buckets', async () => {
    const app = makeApp();
    let last = 0;
    for (let i = 0; i < 200 && last !== 429; i++) {
      last = (await request(app).post('/login').set('X-Forwarded-For', chain('203.0.113.7'))).status;
    }
    expect(last).toBe(429);
    const other = await request(app).post('/login').set('X-Forwarded-For', chain('198.51.100.9'));
    expect(other.status).not.toBe(429);
    const again = await request(app).post('/login').set('X-Forwarded-For', chain('203.0.113.7'));
    expect(again.status).toBe(429);
  });
});
