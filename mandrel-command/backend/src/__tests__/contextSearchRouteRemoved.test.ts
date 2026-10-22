/**
 * Guards that the LYING search path stays deleted (search consolidation).
 *
 * `POST /contexts/search` was labeled "semantic" but ran the LITERAL matcher. It +
 * ContextController.semanticSearch are removed. All context search now flows through
 * `GET /contexts` (2-mode dispatch). This test fails if either is reintroduced.
 */

import contextsRouter from '../routes/contexts';
import { ContextController } from '../controllers/context';

type ExpressLayer = { route?: { path?: string; methods?: Record<string, boolean> } };

describe('deleted lying POST /contexts/search path', () => {
  it('has no POST /search route registered on the contexts router', () => {
    const layers = (contextsRouter as unknown as { stack: ExpressLayer[] }).stack || [];
    const postSearch = layers.find(
      (l) => l.route?.path === '/search' && l.route?.methods?.post === true,
    );
    expect(postSearch).toBeUndefined();
  });

  it('still registers GET /contexts (the one search+browse entry point)', () => {
    const layers = (contextsRouter as unknown as { stack: ExpressLayer[] }).stack || [];
    const getRoot = layers.find(
      (l) => l.route?.path === '/' && l.route?.methods?.get === true,
    );
    expect(getRoot).toBeDefined();
  });

  it('no longer exposes ContextController.semanticSearch', () => {
    expect((ContextController as unknown as Record<string, unknown>).semanticSearch).toBeUndefined();
  });
});
