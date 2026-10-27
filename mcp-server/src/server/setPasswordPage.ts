/**
 * setPasswordPage.ts — the page a new hosted customer opens from their welcome email to choose
 * their own password (sign-up S5). See setPasswordConfig.ts for the
 * mechanism: the token is minted by src/scripts/mint-set-password-link.ts and SPENT by
 * better-auth's own `POST <basePath>/reset-password`, which is single-use and expiry-checked.
 *
 * Two routes, mounted by mountOAuthRoutes (so they exist only when OAuth is enabled):
 *   GET  <pagePath>          the page. The token is in the URL FRAGMENT (#token=…): browsers
 *                            never send a fragment, so it is in no access log on the way in.
 *   POST <pagePath>/status   { token } → { valid: boolean }. READ-ONLY: it never spends the
 *                            token. The page calls it on load so a used or expired link says
 *                            "ask us for a new one" BEFORE the customer types a password.
 *
 * The page posts the new password straight to better-auth's reset endpoint. Every "this link
 * is no good" answer (status invalid, or INVALID_TOKEN from the reset) renders the SAME message.
 */

import { createHash } from 'node:crypto';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import type { AuthInstance } from './auth.js';
import { BETTER_AUTH_CONFIG } from '../config/betterAuthConfig.js';
import { SET_PASSWORD_CONFIG, SET_PASSWORD_TOKEN_RE } from '../config/setPasswordConfig.js';

/** Is this token an unspent, unexpired set-password link? Never consumes it. */
export async function setPasswordTokenValid(auth: AuthInstance, token: unknown, now: Date = new Date()): Promise<boolean> {
  if (typeof token !== 'string' || !SET_PASSWORD_TOKEN_RE.test(token)) return false;
  const ctx = await auth.$context;
  const row = await ctx.internalAdapter.findVerificationValue(`${SET_PASSWORD_CONFIG.identifierPrefix}${token}`);
  if (!row) return false;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 8vh auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 1.3rem; }
  label { display: block; margin: 12px 0 4px; font-size: .9rem; }
  input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 16px; padding: 10px 16px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
  .msg { margin-top: 12px; font-size: .9rem; }
  .err { color: #b91c1c; } .ok { color: #16a34a; }
  [hidden] { display: none; }
`;

/** The page's ONE inline script. Hashed into the CSP, so no other inline script can run. */
function pageScript(): string {
  const basePath = BETTER_AUTH_CONFIG.basePath;
  const statusPath = `${SET_PASSWORD_CONFIG.pagePath}/status`;
  return `
    const basePath = ${JSON.stringify(basePath)};
    const statusPath = ${JSON.stringify(statusPath)};
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    // Drop the token from the address bar and history once read.
    history.replaceState(null, '', window.location.pathname);
    const $ = (id) => document.getElementById(id);
    function dead() { $('checking').hidden = true; $('form').hidden = true; $('dead').hidden = false; }
    async function check() {
      if (!token) return dead();
      try {
        const r = await fetch(statusPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        if (r.status !== 200) throw new Error('status ' + r.status);
        const j = await r.json();
        if (!j || j.valid !== true) return dead();
        $('checking').hidden = true; $('form').hidden = false;
      } catch (e) {
        $('checking').textContent = 'Could not check your link. Reload the page to try again.';
      }
    }
    $('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('msg').textContent = '';
      const pw = $('pw').value;
      if (pw !== $('pw2').value) { $('msg').textContent = 'The two passwords do not match.'; return; }
      $('save').disabled = true;
      try {
        const r = await fetch(basePath + '/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword: pw }) });
        if (r.ok) { $('form').hidden = true; $('done').hidden = false; return; }
        const j = await r.json().catch(() => ({}));
        const code = (j && j.code) || '';
        if (code === 'INVALID_TOKEN') return dead();
        if (code === 'PASSWORD_TOO_SHORT') $('msg').textContent = 'That password is too short.';
        else if (code === 'PASSWORD_TOO_LONG') $('msg').textContent = 'That password is too long.';
        else $('msg').textContent = 'Could not set the password (' + r.status + '). Try again.';
      } catch (e2) {
        $('msg').textContent = 'Could not reach the server. Try again.';
      }
      $('save').disabled = false;
    });
    check();
`;
}

const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/**
 * Strict CSP: nothing loads from anywhere but this origin, the only script and style that
 * run are the two inline blocks below (by hash), and no one may frame the page.
 */
export function setPasswordCsp(): string {
  return [
    "default-src 'self'",
    `script-src ${sha256(pageScript())}`,
    `style-src ${sha256(STYLE)}`,
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function renderSetPasswordPage(minLength: number, maxLength: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>Set your password — Mandrel</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>Set your Mandrel password</h1>
  <p id="checking">Checking your link…</p>
  <form id="form" hidden>
    <label for="pw">New password (at least ${minLength} characters)</label>
    <input id="pw" type="password" required autocomplete="new-password" minlength="${minLength}" maxlength="${maxLength}" />
    <label for="pw2">Type it again</label>
    <input id="pw2" type="password" required autocomplete="new-password" minlength="${minLength}" maxlength="${maxLength}" />
    <button type="submit" id="save">Set password</button>
  </form>
  <p class="msg err" id="dead" hidden>This link has expired or has already been used. Ask us for a new one: reply to your welcome email.</p>
  <p class="msg ok" id="done" hidden>Your password is set. Use your email address and this password to sign in to your Mandrel dashboard, and when Claude Code or Claude.ai asks you to.</p>
  <p class="msg err" id="msg"></p>
  <script>${pageScript()}</script>
</body>
</html>`;
}

/** Mount the page + its read-only status check. Called from mountOAuthRoutes. */
export function mountSetPasswordRoutes(app: Application, auth: AuthInstance): void {
  const pagePath = SET_PASSWORD_CONFIG.pagePath;
  const noStore = (res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };
  const csp = setPasswordCsp();
  const limit = statusRateLimiter();
  app.get(pagePath, async (_req: Request, res: Response) => {
    const ctx = await auth.$context;
    noStore(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderSetPasswordPage(ctx.password.config.minPasswordLength, ctx.password.config.maxPasswordLength));
  });
  // Route-scoped body parser: this app mounts better-auth BEFORE the global express.json().
  app.post(`${pagePath}/status`, limit, express.json({ limit: '2kb' }), async (req: Request, res: Response) => {
    noStore(res);
    try {
      res.status(200).json({ valid: await setPasswordTokenValid(auth, req.body?.token) });
    } catch {
      // Could not measure is not "invalid": tell the page to retry, never "ask for a new one".
      res.status(503).json({ error: 'unavailable' });
    }
  });
}

/**
 * A small fixed-window limiter for the status check (named config in setPasswordConfig.ts).
 * In-memory, per process: each tenant runs one mcp-server. Expired buckets are swept on use,
 * so the map cannot grow past one window's worth of distinct clients.
 */
export function statusRateLimiter(cfg = SET_PASSWORD_CONFIG, now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const t = now();
    if (buckets.size > 1000) for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
    const hdr = req.headers[cfg.statusRateIpHeader];
    const key = (typeof hdr === 'string' && hdr.trim()) || req.socket.remoteAddress || 'unknown';
    let b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + cfg.statusRateWindowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > cfg.statusRateMax) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - t) / 1000)));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}
