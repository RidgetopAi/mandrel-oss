/**
 * Feature A — per-record deep-link routes: page wiring guarantees.
 *
 * The repo has no React render-testing infra (see SessionDetail.uuid.test.tsx),
 * so — as that suite does — we assert the exact source wiring that makes each
 * detail page correct: it fetches the record by id via the EXISTING client,
 * gates the fetch on a real UUID, renders the EXISTING detail component (reused,
 * NOT a duplicated detail UI), routes not-found through the shared predicate,
 * and threads the optional `?q=` term to the detail view. The pure behavior of
 * those helpers is proven in deepLink.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('Decisions deep-link wiring (P2 why-ledger rebuild)', () => {
  // The old DecisionDetailPage (antd DecisionDetail drawer) was replaced by the P2 "why
  // ledger": the `decisions/:id` route now renders the Decisions screen itself, and the
  // route id pre-selects the reader pane (the /r/:id resolve flow lands here).
  const src = read('Decisions.tsx');

  test('the deep-link is served by the why-ledger Decisions screen (route id pre-selects)', () => {
    expect(src).toMatch(/useParams<\{\s*id:\s*string\s*\}>/);
    expect(src).toMatch(/routeId/);
    expect(src).toMatch(/<DecisionReader/);
  });
  test('fetches the selected record by id via the unified api client hook', () => {
    expect(src).toMatch(/useDecision\(selectedId\)/);
  });
  test('surfaces the TYPED thread box from real graph edges (the moat)', () => {
    expect(src).toMatch(/useDecisionLinks\(selectedId\)/);
  });
  test('does not re-implement the old antd detail drawer', () => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
  });
});

describe('Contexts deep-link wiring (rail + reader — the Decisions shape)', () => {
  // The Contexts screen is a list rail + reader (the 2026-07-16 card grid + slide-over
  // drawer was REVERSED). The `contexts/:id` route id pre-selects the
  // reader (the /r/:id resolve flow lands here). ContextDetail OWNS the detail wiring: it
  // fetches the record + its typed links by id and renders the ContextReader body — so the
  // deep-link invariant (fetch the context + its links + render the reader) lives across
  // these two files. The BEHAVIOUR is proven by render tests in Contexts.test.tsx; these
  // are the cheap source-level guards.
  const page = read('Contexts.tsx');
  const detail = read('contexts/ContextDetail.tsx');

  test('the deep-link is served by the Contexts screen — route id pre-selects the reader', () => {
    expect(page).toMatch(/useParams<\{\s*id:\s*string\s*\}>/);
    expect(page).toMatch(/routeId/);
    expect(page).toMatch(/<ContextDetail/);
  });
  test('the detail fetches the selected record by id (unified api hook) + renders the reader', () => {
    expect(detail).toMatch(/useContext\(id\)/);
    expect(detail).toMatch(/<ContextReader/);
  });
  test('surfaces the TYPED thread box from real graph edges (the moat)', () => {
    expect(detail).toMatch(/useContextLinks\(id\)/);
  });
  test('does not re-implement the old antd detail drawer', () => {
    expect(page).not.toMatch(/from\s+['"]antd['"]/);
    expect(detail).not.toMatch(/from\s+['"]antd['"]/);
  });
});

describe('Tasks deep-link wiring (P2 live-thread rebuild)', () => {
  // The old TaskDetailPage (antd TaskCardList drawer) was replaced by the P2 "live
  // thread" Tasks screen: the `tasks/:id` route now renders the Tasks screen itself,
  // and the route id pre-selects the task — opening the CRUD drawer (TaskDrawer) in
  // edit mode for that task (the /r/:id resolve flow lands here).
  const src = read('Tasks.tsx');

  test('the deep-link is served by the live-thread Tasks screen (route id pre-selects)', () => {
    expect(src).toMatch(/useParams<\{\s*id:\s*string\s*\}>/);
    expect(src).toMatch(/routeId/);
    expect(src).toMatch(/<TaskDrawer/);
  });
  test('fetches the selected record by id via the unified api client hook', () => {
    expect(src).toMatch(/useTask\(selectedId\)/);
  });
  test('surfaces the TYPED build-story box from real graph edges (the moat)', () => {
    expect(src).toMatch(/useTaskLinks\(selectedId\)/);
  });
  test('does not re-implement the old antd detail drawer', () => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
  });
});

describe('App routes register the deep-link detail pages under the protected layout', () => {
  const src = read('../App.tsx');

  test('all three :id routes are declared', () => {
    expect(src).toMatch(/path="decisions\/:id"/);
    expect(src).toMatch(/path="contexts\/:id"/);
    expect(src).toMatch(/path="tasks\/:id"/);
  });

  test('each :id route renders its detail page', () => {
    // The decisions/:id deep-link renders the why-ledger Decisions screen itself.
    expect(src).toMatch(/path="decisions\/:id"[\s\S]*?<Decisions \/>/);
    // The contexts/:id deep-link renders the wide-reader Contexts screen itself.
    expect(src).toMatch(/path="contexts\/:id"[\s\S]*?<Contexts \/>/);
    // The tasks/:id deep-link renders the live-thread Tasks screen itself.
    expect(src).toMatch(/path="tasks\/:id"[\s\S]*?<Tasks \/>/);
  });

  test('the detail routes sit ABOVE the catch-all redirect (so they resolve)', () => {
    const idIdx = src.indexOf('path="decisions/:id"');
    const catchAllIdx = src.indexOf('path="*"');
    expect(idIdx).toBeGreaterThan(-1);
    expect(catchAllIdx).toBeGreaterThan(idIdx);
  });
});

describe('Tab-reuse: in-app record links use client-side navigation', () => {
  // Post-rebuild, the SessionDetail Contexts tab lives in the sessionDetail/ module
  // (panels.tsx); the "open context" affordance still uses the shared recordPath +
  // client-side navigate so the record opens in the SAME tab (no full reload).
  const src = read('sessionDetail/panels.tsx');

  test('SessionDetail opens a context via the shared recordPath + navigate (same tab)', () => {
    expect(src).toMatch(/import \{ recordPath \} from '\.\.\/\.\.\/utils\/deepLink'/);
    expect(src).toMatch(/navigate\(recordPath\('context',\s*c\.id\)\)/);
  });
});
