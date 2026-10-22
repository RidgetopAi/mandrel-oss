/**
 * KPI row — four StatTiles (P0.3) driven by KPI_SPECS + live counts. Every value
 * is REAL: projects/contexts/activeTasks from `/api/dashboard/stats`, decisions
 * from the decisions-search total. The only delta shown is Contexts' this-week
 * count (`recentActivity.contextsThisWeek`) — an unambiguous "+N this week";
 * other KPIs carry a caption, not a fabricated delta (no data source for a %).
 */
import React from 'react';
import { StatTile, Skeleton, Alert, Card } from '../../components/ui';
import { KPI_SPECS, type KpiSpec } from './config';
import { KPI_ICONS } from './icons';
import { formatCount, scopeCaption, type DashboardCardProps } from './parts';
import { useDashboardStats, useDecisionCount } from './hooks';
import styles from './Dashboard.module.css';
import { apiErrorMessage } from '../../api/request';

const toneClass: Record<KpiSpec['tone'], string> = {
  teal: styles.toneTeal,
  green: styles.toneGreen,
  violet: styles.toneViolet,
  blue: styles.toneBlue,
};

function KpiIcon({ spec }: { spec: KpiSpec }) {
  const Icon = KPI_ICONS[spec.icon];
  return (
    <span className={`${styles.kpiIcon} ${toneClass[spec.tone]}`}>
      <Icon size={15} />
    </span>
  );
}

export const DashboardKpis: React.FC<DashboardCardProps> = ({ projectId, projectName, scope }) => {
  const stats = useDashboardStats(projectId, scope);
  const decisions = useDecisionCount(projectId, scope);

  if (stats.isError) {
    return (
      <Alert variant="error" title="Couldn't load workspace stats">
        {apiErrorMessage(stats.error, 'Failed to load dashboard stats.')}
      </Alert>
    );
  }

  // `isPending`, not `isLoading`: a react-query v5 query that is DISABLED (this page has
  // no project yet) reports isLoading=false with no data, which every card below would
  // render as its EMPTY state — "No projects yet" on a workspace that has plenty. Pending
  // is the state that says "no answer yet", and it covers both disabled and in-flight.
  const loading = stats.isPending;
  const s = stats.data;

  const valueFor = (key: KpiSpec['key']): number | undefined => {
    switch (key) {
      case 'projects':
        return s?.projects;
      case 'activeTasks':
        return s?.activeTasks;
      case 'contexts':
        return s?.contexts;
      case 'decisions':
        return decisions.data;
    }
  };

  const captionFor = (key: KpiSpec['key']): React.ReactNode => {
    switch (key) {
      case 'projects':
        return `visible in ${scopeCaption(projectName)}`;
      case 'activeTasks':
        return s?.totalTasks != null ? `${formatCount(s.totalTasks)} total` : 'in progress';
      case 'contexts':
        return scopeCaption(projectName);
      case 'decisions':
        return 'recorded';
    }
  };

  const contextsThisWeek = s?.recentActivity?.contextsThisWeek ?? 0;

  return (
    <div className={styles.kpis}>
      {KPI_SPECS.map((spec) => {
        if (loading) {
          return (
            <Card key={spec.key}>
              <Skeleton shape="line" style={{ width: '40%' }} />
              <Skeleton shape="line" style={{ width: '60%', height: 28, marginTop: 12 }} />
            </Card>
          );
        }
        const value = valueFor(spec.key);
        const showDelta = spec.key === 'contexts' && contextsThisWeek > 0;
        return (
          <StatTile
            key={spec.key}
            label={spec.label}
            value={formatCount(value)}
            icon={<KpiIcon spec={spec} />}
            caption={captionFor(spec.key)}
            {...(showDelta ? { delta: `+${formatCount(contextsThisWeek)}`, trend: 'up' as const } : {})}
          />
        );
      })}
    </div>
  );
};

export default DashboardKpis;
