/**
 * oauthPages.ts — minimal, REAL server-rendered sign-in + consent pages for the BA-1
 * OAuth browser flow. These are NOT stubs: the sign-in page
 * lets a user sign up / sign in against better-auth's email+password endpoints, and the
 * consent page approves the authorization code so the OAuth flow completes and the
 * client is redirected back with the code.
 *
 * They are intentionally dependency-free (vanilla HTML + fetch) so they render with no
 * build step and are easy to drive in the BA-2 morning browser test. The basePath the
 * forms POST to is read from config (never hardcoded).
 *
 * Styling is deliberately minimal — this is the authorization-server UI, not a product
 * surface. The operator's bar (no stubs/MVPs) is met by FUNCTION, not polish: the pages must
 * actually let the flow complete.
 */

import { BETTER_AUTH_CONFIG } from '../config/betterAuthConfig.js';

/** HTML-escape a string for safe interpolation into attributes/markup. */
function esc(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 8vh auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 1.3rem; }
  label { display: block; margin: 12px 0 4px; font-size: .9rem; }
  input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 16px; padding: 10px 16px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
  button.secondary { background: #6b7280; }
  .row { display: flex; gap: 8px; }
  .msg { margin-top: 12px; font-size: .85rem; color: #b91c1c; }
  .muted { color: #6b7280; font-size: .8rem; margin-top: 24px; }
`;

/**
 * Sign-in / sign-up page. Drives better-auth's `<basePath>/sign-up/email` and
 * `<basePath>/sign-in/email` endpoints via fetch. On success it returns the user to the
 * OAuth authorize flow (the `redirect`/authorize query param is preserved).
 */
export function renderSignInPage(query: Record<string, string>): string {
  const basePath = BETTER_AUTH_CONFIG.basePath;
  // Preserve any OAuth authorize continuation target the AS passed through.
  const next = esc(query.redirect || query.next || '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — Mandrel</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>Sign in to Mandrel</h1>
  <form id="form" autocomplete="on">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="username" />
    <label for="name">Name (sign-up only)</label>
    <input id="name" name="name" type="text" autocomplete="name" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password" minlength="8" />
    <div class="row">
      <button type="submit" id="signin">Sign in</button>
      <button type="button" class="secondary" id="signup">Create account</button>
    </div>
  </form>
  <div class="msg" id="msg"></div>
  <p class="muted">This is the Mandrel OAuth authorization server.</p>
  <script>
    const basePath = ${JSON.stringify(basePath)};
    const next = ${JSON.stringify(next)};
    const msg = document.getElementById('msg');
    function payload() {
      return {
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
        name: document.getElementById('name').value || document.getElementById('email').value,
      };
    }
    async function post(path, body) {
      const r = await fetch(basePath + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      return r;
    }
    function done() {
      if (next) { window.location.href = next; }
      else { msg.style.color = '#16a34a'; msg.textContent = 'Signed in. You may return to the application.'; }
    }
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.style.color = '#b91c1c'; msg.textContent = '';
      const p = payload();
      const r = await post('/sign-in/email', { email: p.email, password: p.password });
      if (r.ok) { done(); } else { msg.textContent = 'Sign-in failed (' + r.status + ').'; }
    });
    document.getElementById('signup').addEventListener('click', async () => {
      msg.style.color = '#b91c1c'; msg.textContent = '';
      const r = await post('/sign-up/email', payload());
      if (r.ok) { done(); } else {
        const t = await r.text();
        msg.textContent = 'Sign-up failed (' + r.status + '): ' + t.slice(0, 200);
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Consent page. The AS (better-auth oauth-provider) redirects here via
 * `redirectWithPromptCode(..., "consent")` → `signParams()`, which appends the FULL
 * original authorize query to the consent page URL as a SIGNED query string (all the
 * authorize params + `exp` + `signed_at` + a `sig` HMAC over the canonicalized params).
 *
 * To approve, we must hand that exact signed query back to better-auth so it can rebuild
 * the original OAuth request. better-auth's consent endpoint (`<basePath>/oauth2/consent`)
 * reconstructs the request from `oAuthState`, which is populated by a `before` hook keyed
 * on a body field **`oauth_query`** ("The redirected page's query parameters"): the hook
 * runs `verifyOAuthQueryParams(oauth_query, secret)` then `oAuthState.set({ query })`. In
 * Claude.ai's cross-site flow the oAuthState COOKIE isn't present on the POST, so without
 * `oauth_query` the endpoint throws "missing oauth query" → 400 ("Consent failed (400)").
 *
 * Fix: forward `oauth_query` = this consent page's own incoming query string verbatim
 * (`window.location.search` minus the leading `?`) — that IS the signed string better-auth
 * produced, so the signature verifies and the flow proceeds. We send `{ accept, oauth_query }`.
 * (The old `code` field was not in the consent endpoint's body schema and was stripped.)
 */
export function renderConsentPage(query: Record<string, string>): string {
  const basePath = BETTER_AUTH_CONFIG.basePath;
  const clientId = esc(query.client_id);
  const scope = esc(query.scope);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize — Mandrel</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>Authorize access</h1>
  <p><strong>${clientId || 'An application'}</strong> is requesting access to your Mandrel account.</p>
  <p>Requested scopes: <code>${scope || '(default)'}</code></p>
  <div class="row">
    <button id="approve">Approve</button>
    <button class="secondary" id="deny">Deny</button>
  </div>
  <div class="msg" id="msg"></div>
  <script>
    const basePath = ${JSON.stringify(basePath)};
    const msg = document.getElementById('msg');
    async function consent(accept) {
      msg.style.color = '#b91c1c'; msg.textContent = '';
      // Forward this page's own (signed) query string back to better-auth's consent
      // endpoint so it can rebuild the original OAuth request (cross-site: the
      // oAuthState cookie is absent on this POST). See renderConsentPage() doc above.
      const oauthQuery = window.location.search.replace(/^\\?/, '');
      const r = await fetch(basePath + '/oauth2/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ accept: accept, oauth_query: oauthQuery }),
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        // better-auth's handleRedirect() for a browser-fetch POST returns
        // { redirect: true, url } (it sets accept:application/json before authorizing),
        // so the redirect target is the url field. Fall back to redirectURI/redirect_uri.
        const target = (data && (data.url || data.redirectURI || data.redirect_uri)) || '';
        if (target) { window.location.href = target; return; }
        msg.style.color = '#16a34a'; msg.textContent = accept ? 'Approved.' : 'Denied.';
      } else {
        msg.textContent = 'Consent failed (' + r.status + ').';
      }
    }
    document.getElementById('approve').addEventListener('click', () => consent(true));
    document.getElementById('deny').addEventListener('click', () => consent(false));
  </script>
</body>
</html>`;
}
