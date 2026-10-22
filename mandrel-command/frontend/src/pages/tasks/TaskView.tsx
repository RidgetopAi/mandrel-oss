/**
 * TaskView — the READ-ONLY task panel.
 *
 * Clicking a task used to land the user straight in an editable form, with no read-only
 * stop: there was nowhere to just *look* at a task, and every board card, list row, ops-bar
 * item and `/r/<id8>` deep link opened a form with a live Save and a live Delete in it.
 * This renders the same information that form does — title, description, status, priority,
 * type, assignee, tags — plus the typed-edge build story, with no control that can write.
 *
 * It is a panel, not a page. The drawer owns the mode and supplies the Edit button in its
 * footer, so switching to edit happens in place and needs no route of its own.
 *
 * Every field renders an honest empty ("No description", "unassigned", "No tags") rather
 * than collapsing to a blank gap, so a genuinely unset field is distinguishable from a
 * rendering bug.
 */
import React from 'react';
import { Badge, Alert } from '../../components/ui';
import { BuildStory } from './BuildStory';
import { statusTone, typeTint, priorityDotVar, priorityLabel, STATUS_LABEL } from './config';
import { formatRelative, id8 } from './parts';
import type { Task, TaskLink } from '../../types/task';
import s from './TaskView.module.css';

export interface TaskViewProps {
  task: Task;
  links?: TaskLink[];
  linksLoading?: boolean;
  linksError?: boolean;
  linksErrorObj?: unknown;
}

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className={s.section}>
    <span className={s.label}>{label}</span>
    <div className={s.value}>{children}</div>
  </div>
);

const Unset: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className={s.empty}>{children}</span>
);

export const TaskView: React.FC<TaskViewProps> = ({
  task,
  links,
  linksLoading = false,
  linksError = false,
  linksErrorObj,
}) => {
  const description = (task.description ?? '').trim();
  const assignee = (task.assigned_to ?? '').trim();
  const tags = task.tags ?? [];

  return (
    <div className={s.view}>
      {/* Same warning the edit form carries — an archived task is off the board, and that
          is exactly as true when you are only reading it. */}
      {task.archived_at && (
        <Alert variant="warning" title="This task is deleted (archived)">
          It is hidden from the board and the counts. Restore it to put it back — nothing was
          destroyed.
        </Alert>
      )}

      <div>
        <h3 className={s.title}>{task.title}</h3>
      </div>

      <div className={s.badges}>
        <Badge variant={typeTint(task.type)}>{task.type}</Badge>
        <Badge variant={statusTone(task.status)}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
        <span className={s.prio}>
          <span
            className={s.prioDot}
            style={{ background: `var(${priorityDotVar(task.priority)})` }}
            aria-hidden="true"
          />
          {priorityLabel(task.priority)}
        </span>
      </div>

      <Section label="Description">
        {description ? (
          <span className={s.prose}>{description}</span>
        ) : (
          <Unset>No description</Unset>
        )}
      </Section>

      <div className={s.grid2}>
        <Section label="Status">{STATUS_LABEL[task.status] ?? task.status}</Section>
        <Section label="Priority">{priorityLabel(task.priority)}</Section>
        <Section label="Type">{task.type}</Section>
        <Section label="Assignee">
          {assignee ? assignee : <Unset>unassigned</Unset>}
        </Section>
      </div>

      <Section label="Tags">
        {tags.length > 0 ? (
          <div className={s.tags}>
            {tags.map((t) => (
              <span key={t} className={s.tagChip}>
                {t}
              </span>
            ))}
          </div>
        ) : (
          <Unset>No tags</Unset>
        )}
      </Section>

      <div className={s.storyBlock}>
        <BuildStory
          links={links}
          isLoading={linksLoading}
          isError={linksError}
          error={linksErrorObj}
        />
      </div>

      <div className={s.meta}>
        <span>
          task <b className={s.metaMono}>{id8(task.id)}</b>
        </span>
        <span>
          created <b>{formatRelative(task.created_at)}</b>
        </span>
        <span>
          updated <b>{formatRelative(task.updated_at)}</b>
        </span>
      </div>
    </div>
  );
};

export default TaskView;
