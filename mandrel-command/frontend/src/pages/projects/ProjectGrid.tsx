/**
 * ProjectGrid — the portfolio grid of cards. Owns the LIST-level loading / empty / error
 * state (Spinner / Empty / Alert), like DecisionList; each card owns its own insights
 * loading/error inside itself.
 */
import React from 'react';
import { Spinner, Empty, Alert } from '../../components/ui';
import type { ProjectEntity } from '../../api/generated';
import { ProjectCard } from './ProjectCard';
import styles from './Projects.module.css';
import { apiErrorMessage } from '../../api/request';

export interface ProjectGridProps {
  projects: ProjectEntity[];
  now: number;
  onOpen: (id: string) => void;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  emptyHint?: string;
}

export const ProjectGrid: React.FC<ProjectGridProps> = ({
  projects,
  now,
  onOpen,
  isLoading,
  isError,
  error,
  emptyHint,
}) => {
  if (isLoading) {
    return (
      <div className={styles.gridState}>
        <Spinner size="md" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={styles.gridState}>
        <Alert variant="error" title="Couldn't load projects">
          {apiErrorMessage(error, 'Failed to load projects.')}
        </Alert>
      </div>
    );
  }
  if (projects.length === 0) {
    return (
      <div className={styles.gridState}>
        <Empty
          title="No projects"
          description={emptyHint ?? 'No projects match the current filters.'}
        />
      </div>
    );
  }

  return (
    <div className={styles.grid} role="list" aria-label="Projects">
      {projects.map((p) => (
        <ProjectCard key={p.id} project={p} now={now} onOpen={onOpen} />
      ))}
    </div>
  );
};

export default ProjectGrid;
