/**
 * Projects section — the user's DEFAULT PROJECT (an earlier epic §A).
 *
 * ── WHAT THIS WRITES NOW ─────────────────────────────────────────────────────────────
 *   PATCH /api/users/preferences { defaultProjectId: "<uuid>" | null }
 *
 * It used to write `POST /api/projects/:id/set-primary` and `POST
 * /api/projects/clear-primary`. Those set an INSTANCE-WIDE flag on the shared `projects`
 * table: one user clearing "their" default cleared it for every user on the instance,
 * and the value was carried as a project NAME, so a rename broke it. This control is now
 * per-user and stores the id.
 *
 * The set-primary / clear-primary endpoints are NOT deleted — they have non-UI consumers
 * (mcp-server bootstrap). This screen simply no longer calls them.
 *
 * The Select here is the shared ProjectSelect primitive with a "No default" entry
 * layered on: unlike a page selector, "none" is a legitimate saved state here.
 */
import React from 'react';
import { Alert, Select, Text } from '../../components/ui';
import { useProjectContext } from '../../contexts/ProjectContext';
import { useSettings } from '../../contexts/SettingsContext';
import { Group, Row } from './parts';
import styles from './Settings.module.css';
import { apiErrorMessage } from '../../api/request';

const UNASSIGNED_ID = '00000000-0000-0000-0000-000000000000';
const CLEAR_VALUE = '__none__';

export const ProjectsSection: React.FC = () => {
  const { allProjects } = useProjectContext();
  const { defaultProjectId, defaultProjectName, setDefaultProjectId } = useSettings();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const projects = React.useMemo(
    () => allProjects.filter((p) => p.id !== UNASSIGNED_ID),
    [allProjects],
  );

  const options = React.useMemo(
    () => [
      { value: CLEAR_VALUE, label: 'No default (system chooses)' },
      ...projects.map((p) => ({ value: p.id, label: p.name })),
    ],
    [projects],
  );

  const onChange = (value: string) => {
    setBusy(true);
    setError(null);
    // `null` is an explicit CLEAR, not an omitted field — the backend distinguishes them.
    setDefaultProjectId(value === CLEAR_VALUE ? null : value)
      .catch((err) => setError(err))
      .finally(() => setBusy(false));
  };

  // The stored value is an id; the label is derived. A default whose project is gone
  // (deleted / access revoked) still has an id, so say so rather than rendering blank.
  const help = !defaultProjectId
    ? 'No default set — Command picks the most recently active project.'
    : defaultProjectName
      ? (
          <>
            Currently <Text variant="data">{defaultProjectName}</Text>. Saved to your
            account, not the whole instance.
          </>
        )
      : 'Your saved default project is no longer available — choose another.';

  return (
    <Group
      title="Default project"
      description="Where every project-scoped page starts. This is YOUR preference — it does not affect other users."
    >
      {error != null && (
        <div className={styles.rowInset}>
          <Alert variant="error" title="Couldn't update default">
            {apiErrorMessage(error, 'Update failed.')}
          </Alert>
        </div>
      )}
      <Row label="Default project" help={help}>
        <Select
          options={options}
          value={defaultProjectId ?? CLEAR_VALUE}
          onChange={onChange}
          disabled={busy}
          searchable={projects.length > 8}
          searchPlaceholder="Search projects…"
          aria-label="Default project"
        />
      </Row>
    </Group>
  );
};

export default ProjectsSection;
