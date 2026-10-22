/**
 * Feature C — /r/:id landing route: page-wiring guarantees.
 *
 * The repo has no React render-testing infra (see RecordDetailPages.deeplink.test.tsx),
 * so — as those suites do — we assert the exact source wiring that makes the landing
 * correct: it reads :id, resolves via the shared resolveNavRecord client, client-side
 * navigate()s on a unique match, renders a candidate list on ambiguity (never
 * auto-picks), and shows a clean not-found otherwise. The pure branching of the
 * client is proven in resolveClient.test.ts; the id detection in navIdLinkify.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('ResolveRedirectPage wiring', () => {
  const src = read('ResolveRedirectPage.tsx');

  test('reads :id from the route', () => {
    expect(src).toMatch(/useParams<\{ id: string \}>\(\)/);
  });
  test('resolves via the shared resolveNavRecord client (single source)', () => {
    expect(src).toMatch(/import \{ resolveNavRecord.* \} from '\.\.\/api\/resolveClient'/);
    expect(src).toMatch(/queryFn: \(\) => resolveNavRecord\(/);
  });
  test('on a unique match, client-side navigate()s to the typed detail url (same tab, replace)', () => {
    expect(src).toMatch(/status === 'unique'/);
    expect(src).toMatch(/navigate\(data\.record\.url, \{ replace: true \}\)/);
  });
  test('on ambiguity, renders the candidates as links and NEVER auto-picks', () => {
    expect(src).toMatch(/status === 'ambiguous'/);
    expect(src).toMatch(/candidates/);
    expect(src).toMatch(/<Link to=\{candidate\.url\}>/);
  });
  test('renders a clean not-found for notfound/invalid', () => {
    expect(src).toMatch(/<Empty/);
  });
});

describe('App registers the /r/:id landing route under the protected layout', () => {
  const src = read('../App.tsx');

  test('the r/:id route is declared and renders ResolveRedirectPage', () => {
    expect(src).toMatch(/path="r\/:id"/);
    expect(src).toMatch(/<ResolveRedirectPage \/>/);
  });

  test('the r/:id route sits ABOVE the catch-all redirect (so it resolves)', () => {
    const rIdx = src.indexOf('path="r/:id"');
    const catchAllIdx = src.indexOf('path="*"');
    expect(rIdx).toBeGreaterThan(-1);
    expect(catchAllIdx).toBeGreaterThan(rIdx);
  });
});

describe('LinkifiedText reuses the single id-detection source (no drift)', () => {
  const src = read('../components/common/LinkifiedText.tsx');
  test('uses segmentNavIds + react-router Link', () => {
    expect(src).toMatch(/import \{ segmentNavIds \} from '\.\.\/\.\.\/utils\/navIdLinkify'/);
    expect(src).toMatch(/<Link/);
  });
});
