/**
 * StoryView — the Story tab: one branch read top to bottom as chapters (local calendar
 * days) of typed beats, with a sidebar (where it stands / still open / key). All shaping is
 * the pure `story.ts`; this file only renders it. Colour is token-only: a role's token name
 * comes from config and is handed to CSS as a custom property.
 */
import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cx } from '../../components/ui';
import type { ThreadGraph } from '../../api/domains/treewalker';
import { STORY_CONFIG, STORY_ROLES, URL_PARAMS, type StoryRoleKey } from './config';
import { whyTo } from './links';
import { buildStory, plural, type Beat, type BeatGroup, type StoryRef } from './story';
import styles from './Story.module.css';

export interface StoryViewProps {
  graph: ThreadGraph | undefined;
  unavailable: boolean;
  isLoading: boolean;
}

const roleStyle = (role: StoryRoleKey): React.CSSProperties =>
  ({ '--role': `var(${STORY_ROLES[role].colorVar})` }) as React.CSSProperties;

const Marker: React.FC<{ role: StoryRoleKey }> = ({ role }) => (
  <span className={cx(styles.marker, styles[`m-${STORY_ROLES[role].marker}`])} style={roleStyle(role)} aria-hidden="true" />
);

/** A record's short id; clicking it opens the Why view for that record. */
const RecordLink: React.FC<{ id: string; id8: string }> = ({ id, id8 }) => {
  const [params] = useSearchParams();
  return (
    <Link className={styles.id} to={whyTo(params, id)}>
      {id8}
    </Link>
  );
};

/** DOM id of a beat's row — the target a Timeline marker click scrolls to. */
export const beatDomId = (id: string) => `tw-beat-${id}`;

const BeatBody: React.FC<{ beat: Beat }> = ({ beat }) => {
  const [params] = useSearchParams();
  const card = STORY_CONFIG.cardRoles.includes(beat.role);
  return (
    <div className={cx(styles.body, card && styles.card)} style={roleStyle(beat.role)}>
      <div className={styles.meta}>
        <span className={styles.roleLabel}>{STORY_ROLES[beat.role].label}</span>
        <RecordLink id={beat.id} id8={beat.id8} />
      </div>
      <div className={styles.title}>{beat.title}</div>
      {beat.chips.length > 0 && (
        <ul className={styles.chips} aria-label="Spawned tasks">
          {beat.chips.map((chip) => (
            <li key={chip.id}>
              <Link className={cx(styles.chip, styles[`chip-${chip.state}`])} to={whyTo(params, chip.id)}>
                <span className={styles.chipState}>{chip.state}</span>
                {chip.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {beat.leansOn.map((l) => (
        <div className={styles.leans} key={l.id}>
          leans on{' '}
          <Link className={styles.leansLink} to={whyTo(params, l.id)}>
            {l.title}
          </Link>
        </div>
      ))}
    </div>
  );
};

const BeatRow: React.FC<{ beat: Beat }> = ({ beat }) => {
  const [params] = useSearchParams();
  return (
    <li
      className={styles.beat}
      data-role={beat.role}
      id={beatDomId(beat.id)}
      data-current={params.get(URL_PARAMS.beat) === beat.id ? 'true' : undefined}
    >
      <time className={styles.time} dateTime={beat.at}>
        {beat.time}
      </time>
      <Marker role={beat.role} />
      <BeatBody beat={beat} />
    </li>
  );
};

const GroupRow: React.FC<{ group: BeatGroup }> = ({ group }) => {
  const [params] = useSearchParams();
  const target = params.get(URL_PARAMS.beat);
  // A group holding the beat a Timeline click targeted opens so the beat can be scrolled to.
  const [open, setOpen] = React.useState(() => !!target && group.beats.some((b) => b.id === target));
  const { label } = STORY_ROLES[group.role];
  return (
    <li className={styles.beat} data-role={group.role} data-group="true">
      <time className={styles.time}>{group.firstTime}</time>
      <Marker role={group.role} />
      <div className={styles.body} style={roleStyle(group.role)}>
        <div className={styles.groupHead}>
          <span className={styles.roleLabel}>
            {label} ×{group.count}
          </span>
          <span className={styles.groupSpan}>
            {group.firstTime}–{group.lastTime}
          </span>
          <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show all'}
          </button>
        </div>
        {open && (
          <ol className={styles.nested}>
            {group.beats.map((b) => (
              <BeatRow key={b.id} beat={b} />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
};

const RefLine: React.FC<{ item: StoryRef | null; empty: string }> = ({ item, empty }) =>
  item ? (
    <div className={styles.sideLine}>
      <RecordLink id={item.id} id8={item.id8} /> {item.title}
    </div>
  ) : (
    <div className={styles.sideEmpty}>{empty}</div>
  );

export const StoryView: React.FC<StoryViewProps> = ({ graph, unavailable, isLoading }) => {
  const story = React.useMemo(() => (graph ? buildStory(graph) : null), [graph]);
  const [params] = useSearchParams();
  const targetBeat = params.get(URL_PARAMS.beat);
  const ready = !!story && story.header.recordCount > 0;
  React.useEffect(() => {
    if (!targetBeat || !ready) return;
    document.getElementById(beatDomId(targetBeat))?.scrollIntoView?.({ block: 'center' });
  }, [targetBeat, ready]);

  if (unavailable) {
    return <div className={styles.empty} data-testid="tw-story">The thread read is not available yet.</div>;
  }
  if (isLoading || !story) {
    return <div className={styles.empty} data-testid="tw-story">Loading the story…</div>;
  }
  if (story.header.recordCount === 0) {
    return <div className={styles.empty} data-testid="tw-story">No records on this thread yet.</div>;
  }
  const { header, sidebar } = story;
  return (
    <div className={styles.story} data-testid="tw-story">
      <div className={styles.main}>
        <header className={styles.head}>
          <h3 className={styles.headTitle}>{header.title}</h3>
          <div className={styles.counts}>
            <span>{plural(header.recordCount, 'record')}</span>
            <span>{header.span}</span>
            <span>{plural(header.decisions, 'decision')}</span>
            <span>{plural(header.outcomes, 'outcome')}</span>
            <span>{plural(header.problems, 'problem')}</span>
            <span>{header.openTasks} open</span>
          </div>
          <p className={styles.summary}>{story.summary}</p>
          {story.truncated && (
            <p className={styles.truncated} data-testid="tw-truncated">
              showing newest {story.truncated.shown} of {story.truncated.total}
            </p>
          )}
        </header>
        {story.chapters.map((chapter) => (
          <section className={styles.chapter} key={chapter.dayKey} aria-label={chapter.date}>
            <div className={styles.chapHead}>
              <span className={styles.chapDate}>{chapter.date}</span>
              <h4 className={styles.chapTitle}>{chapter.title}</h4>
              <span className={styles.chapCount}>{plural(chapter.recordCount, 'record')}</span>
            </div>
            <ol className={styles.beats}>
              {chapter.items.map((item) =>
                item.type === 'beat' ? (
                  <BeatRow key={item.beat.id} beat={item.beat} />
                ) : (
                  <GroupRow key={item.group.beats[0].id} group={item.group} />
                ),
              )}
            </ol>
          </section>
        ))}
      </div>
      <aside className={styles.side} aria-label="Story sidebar">
        <section className={styles.sideCard}>
          <h4 className={styles.sideHead}>Where it stands</h4>
          <div className={styles.sideLabel}>Newest outcome</div>
          <RefLine item={sidebar.newestOutcome} empty="No outcome yet" />
          <div className={styles.sideLabel}>Newest record</div>
          <RefLine item={sidebar.newestRecord} empty="—" />
        </section>
        <section className={styles.sideCard}>
          <h4 className={styles.sideHead}>Still open</h4>
          {sidebar.stillOpen.length === 0 ? (
            <div className={styles.sideEmpty}>Nothing open</div>
          ) : (
            <ul className={styles.sideList}>
              {sidebar.stillOpen.map((t) => (
                <li key={t.id} className={styles.sideLine}>
                  <RecordLink id={t.id} id8={t.id8} /> {t.title}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={styles.sideCard}>
          <h4 className={styles.sideHead}>Key</h4>
          <ul className={styles.sideList}>
            {sidebar.key.map((k) => (
              <li key={k.role} className={styles.keyRow}>
                <Marker role={k.role} />
                {k.label}
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
};

export default StoryView;
