/**
 * projectResolution — pure, deterministic helpers for turning the MCP
 * `project_current` response (and the loaded project/session lists) into a REAL
 * selectable project whose id is ALWAYS a real UUID.
 *
 * Why this module exists (a past incident — fix the class, not the instance):
 * the AIDIS-name → project resolution and the "what do we fall back to" logic
 * previously lived inline in TWO places in ProjectContext.tsx
 * (loadCurrentProjectFromSession and the since-deleted switchProjectViaAidis), each with its own
 * synthetic-`aidis-<name>` early-return. A synthetic id is NOT a UUID, so it
 * (a) is echoed literally by the AntD <Select> as `aidis-**pi-rivet**` and
 * (b) 400s every UUID-validated backend route ("Failed to load contexts").
 *
 * Centralizing the logic here means there is ONE definition that both call
 * sites use, it can never construct a synthetic id, and it is directly
 * unit-testable without mounting the whole provider.
 *
 * INVARIANT guaranteed by this module: every Project it returns has an id that
 * passes isValidUuid(). It never fabricates a synthetic `aidis-<name>` id.
 */
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import { isValidUuid } from '../utils/uuid';

const UNASSIGNED_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_BOOTSTRAP_PROJECT_NAME = 'aidis-bootstrap';

/**
 * Extract the project NAME from an MCP `project_current` text payload and
 * sanitize it.
 *
 * The MCP route returns markdown like:
 *   `🟢 Current Project: **pi-rivet**\n\n📄 Description: ...`
 *   `🟢 Current Project: **pi-rivet** (auto-selected)\n\n...`
 *
 * The raw regex capture therefore includes the `**` markdown bold markers (and
 * possibly a trailing ` (auto-selected)` marker). We strip the markdown here so
 * `**pi-rivet**` resolves to the real `pi-rivet` project instead of being
 * treated as a brand-new name and falling into the synthetic branch.
 *
 * Returns the cleaned name, or null if no project name is present / it is a
 * sentinel ("None" / "unassigned").
 */
export function parseAidisProjectName(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/Current project:\s*([^\n]+)/i);
  if (!match) return null;

  let name = match[1];
  // STRIP THE MARKDOWN: `**pi-rivet**` -> `pi-rivet`.
  name = name.replace(/\*\*/g, '').trim();
  // Drop the trailing ` (auto-selected)` annotation the auto-select path adds,
  // so the auto-selected case resolves to the real project too.
  name = name.replace(/\s*\(auto-selected\)\s*$/i, '').trim();

  if (!name || name === 'None' || name === 'unassigned') {
    return null;
  }
  return name;
}

/**
 * Resolve an AIDIS project NAME to a REAL project from the loaded list — one
 * whose id is a real UUID (never the UNASSIGNED sentinel). Returns null when the
 * name cannot be resolved to a real project, so the caller falls through to
 * selectFallbackProject instead of synthesizing a bad id.
 */
export function resolveRealProject(
  name: string | null | undefined,
  allProjects: Project[]
): Project | null {
  if (!name) return null;
  const real = allProjects.find(
    (p) => p.name === name && p.id !== UNASSIGNED_PROJECT_ID && isValidUuid(p.id)
  );
  return real ?? null;
}

/**
 * The durable fallback. Used whenever we cannot resolve a real project by name
 * (or by stored value). Priority:
 *   (a) last-active   — the project of the most-recent valid session.
 *   (b) most-recently-updated — projects sorted by last_activity desc
 *       (the ordering <ProjectSelect> renders, so every list agrees).
 *   (c) explicit aidis-bootstrap, then the first non-unassigned project.
 *
 * Every candidate is filtered through isValidUuid, so the returned project's id
 * is ALWAYS a real UUID — never synthetic, never the UNASSIGNED sentinel.
 *
 * `defaultProjectId` (the user's saved preference) is honoured first when it
 * resolves to a real project, matching the existing selectBootstrapProject
 * contract.
 *
 * THE PREFERENCE IS AN ID, NOT A NAME (page-scope epic §A). It used to be matched by
 * `p.name === defaultProject`, which meant renaming a project silently detached
 * every user whose default pointed at it — they were bounced to the durable
 * fallback with no error and no way to tell. Matching on the id makes that
 * unreachable rather than merely unlikely.
 */
export function selectFallbackProject(
  allProjects: Project[],
  allSessions: Session[],
  defaultProjectId?: string | null
): Project | null {
  const realProjects = allProjects.filter(
    (p) => p.id !== UNASSIGNED_PROJECT_ID && isValidUuid(p.id)
  );
  if (realProjects.length === 0) {
    return null;
  }

  // User preference wins when it resolves to a real project.
  if (defaultProjectId) {
    const preferred = realProjects.find((p) => p.id === defaultProjectId);
    if (preferred) return preferred;
  }

  // (a) last-active: project of the most-recent valid session.
  const sessionProject = selectMostRecentSessionProject(realProjects, allSessions);
  if (sessionProject) return sessionProject;

  // (b) most-recently-updated by last_activity (the order <ProjectSelect> renders).
  const byActivity = [...realProjects].sort((a, b) => {
    const ta = a.last_activity ? new Date(a.last_activity).getTime() : 0;
    const tb = b.last_activity ? new Date(b.last_activity).getTime() : 0;
    return tb - ta;
  });
  if (byActivity[0] && byActivity[0].last_activity) {
    return byActivity[0];
  }

  // (c) explicit bootstrap project, then first non-unassigned real project.
  const bootstrap = realProjects.find((p) => p.name === DEFAULT_BOOTSTRAP_PROJECT_NAME);
  if (bootstrap) return bootstrap;

  return realProjects[0] ?? null;
}

/**
 * Find the project belonging to the most-recent valid session — a session that
 * has a real project_id (non-unassigned, real UUID) that maps to a real project
 * in the list. "Most recent" is by last_activity_at, then started_at.
 */
function selectMostRecentSessionProject(
  realProjects: Project[],
  allSessions: Session[]
): Project | null {
  const ts = (s: Session): number => {
    const v = s.last_activity_at || s.started_at || s.created_at;
    return v ? new Date(v).getTime() : 0;
  };

  const candidates = allSessions
    .filter(
      (s) =>
        !!s.project_id &&
        s.project_id !== UNASSIGNED_PROJECT_ID &&
        isValidUuid(s.project_id)
    )
    .sort((a, b) => ts(b) - ts(a));

  for (const session of candidates) {
    const project = realProjects.find((p) => p.id === session.project_id);
    if (project) return project;
  }
  return null;
}
