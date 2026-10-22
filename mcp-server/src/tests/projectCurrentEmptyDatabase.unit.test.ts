/**
 * project_current on a database with no user-created projects must name the default project the
 * next write lands in, and must not send the caller to project_create.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../handlers/project.js', () => ({
  projectHandler: {
    getCurrentProject: vi.fn(async () => null),
    initializeSession: vi.fn(async () => null),
  },
}));

import { projectRoutes } from '../routes/project.routes.js';
import { DEFAULT_PERSONAL_PROJECT_NAME } from '../config/defaultProjectConfig.js';

describe('project current on an empty database', () => {
  it('names the default project and does not instruct project_create', async () => {
    const res = await projectRoutes.handleCurrent({}, { sessionId: 'empty-db-session' } as any);
    const text = res.content.map((c: any) => c.text).join('\n');
    expect(text).toContain(DEFAULT_PERSONAL_PROJECT_NAME);
    expect(text).not.toContain('project_create');
    expect((res as any).structuredContent.defaultProject).toBe(DEFAULT_PERSONAL_PROJECT_NAME);
  });
});
