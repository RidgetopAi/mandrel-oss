/**
 * Edge client-IP contract: the tenant must see the real client IP, not the
 * proxy's, so per-IP rate limits are per client. Pins (1) the compose passes
 * TRUST_PROXY=3, (3) better-auth keys on
 * x-real-ip, (4) the frontend nginx /api body limit admits the app's attachment limit.
 */
import { describe, test, expect } from 'vitest';
import { backendEnv, readRepoFile as read } from './helpers/composeEnv.js';

describe('compose TRUST_PROXY', () => {
  test('tenant compose passes TRUST_PROXY defaulting to 3 hops', () => {
    expect(backendEnv('docker-compose.yml').TRUST_PROXY).toBe('${TRUST_PROXY:-3}');
  });
});

describe('better-auth client IP header', () => {
  test('built auth options key rate limits on x-real-ip', async () => {
    const { createAuth } = await import('../server/auth.js');
    const { Pool } = await import('pg');
    const auth = createAuth(undefined, new Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' }));
    const opts = (auth as unknown as { options: { advanced?: { ipAddress?: { ipAddressHeaders?: string[] } } } }).options;
    expect(opts.advanced?.ipAddress?.ipAddressHeaders).toEqual(['x-real-ip']);
  });
});

describe('frontend nginx /api body limit', () => {
  const toBytes = (v: string) => {
    const m = /^(\d+)([kKmMgG]?)$/.exec(v)!;
    const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
    return Number(m[1]) * mult;
  };
  test('client_max_body_size in location /api is >= MAX_ATTACHMENT_BYTES', () => {
    const src = read('mandrel-command/backend/src/config/taskAttachments.ts');
    const m = /MAX_ATTACHMENT_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/.exec(src);
    expect(m).not.toBeNull();
    const appLimit = Number(m![1]) * Number(m![2]) * Number(m![3]);
    expect(appLimit).toBe(5 * 1024 * 1024);
    const conf = read('mandrel-command/frontend/nginx.conf');
    const loc = /location \/api\s*\{([\s\S]*?)\n {4}\}/.exec(conf);
    expect(loc).not.toBeNull();
    const d = /client_max_body_size\s+(\d+[kKmMgG]?)\s*;/.exec(loc![1]);
    expect(d).not.toBeNull();
    expect(toBytes(d![1])).toBeGreaterThanOrEqual(appLimit);
  });
});
