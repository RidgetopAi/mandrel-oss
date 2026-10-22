import React, { useMemo } from 'react';
import type { EmbeddingPanelProps } from './panelProps';
import { Card, Alert, Spin, Button, Space, Typography, List } from 'antd';
import { Line, Column } from '@ant-design/plots';
import { ReloadOutlined } from '@ant-design/icons';
import { useEmbeddingUsagePatternsQuery } from '../../hooks/useEmbeddings';
import { useTheme } from '../../contexts/ThemeContext';
import { chartTheme } from '../../utils/chartTheme';
import { dailyActivityConfig, hourlyActivityConfig, contextTypeConfig } from './chartConfigs';
import { formatDateTime } from '../../utils/datetime';

const { Text, Title } = Typography;

// The page owns the scope; this panel is TOLD which project it is showing (one
// selector for all seven — see panelProps.ts).
const UsagePatterns: React.FC<EmbeddingPanelProps> = ({ projectId }) => {
  const { themeMode } = useTheme();
  // Stable per themeMode so the chart-config memos below don't recompute (and
  // re-init the canvas charts) on every unrelated render.
  const ct = useMemo(() => chartTheme(themeMode), [themeMode]);

  const usageQuery = useEmbeddingUsagePatternsQuery(projectId, {
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
  });

  const loading = usageQuery.isLoading;
  const fetching = usageQuery.isFetching;
  const error = usageQuery.error as Error | null;
  const usage = usageQuery.data ?? null;

  const handleRefresh = () => {
    void usageQuery.refetch();
  };

  // Chart configs live in ./chartConfigs (isolated + unit-tested v5 migration).
  const dailyConfig = useMemo(
    () => dailyActivityConfig(usage?.dailyActivity ?? [], ct),
    [usage?.dailyActivity, ct],
  );

  const hourlyConfig = useMemo(
    () => hourlyActivityConfig(usage?.hourlyDistribution ?? [], ct),
    [usage?.hourlyDistribution, ct],
  );

  const typeConfig = useMemo(
    () => contextTypeConfig(usage?.contextsByType ?? [], ct),
    [usage?.contextsByType, ct],
  );

  if (!projectId) {
    return (
      <Card title="Usage Patterns">
        <Alert
          message="Select a project"
          description="Choose a project to review activity trends."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  if (loading && !usage) {
    return (
      <Card title="Usage Patterns">
        <div style={{ textAlign: 'center', padding: '50px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>Loading usage analytics...</div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Usage Patterns">
        <Alert
          message="Error"
          description={error.message}
          type="error"
          showIcon
        />
        <Button onClick={handleRefresh} style={{ marginTop: 16 }} icon={<ReloadOutlined />}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!usage) {
    return null;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card bordered={false}>
        <Space size="large" align="start" wrap>
          <div>
            <Title level={4} style={{ marginBottom: 0 }}>
              {usage.summary.totalContexts} contexts captured overall
            </Title>
            <Text type="secondary">
              {usage.summary.contextsLast7Days} in last 7 days • {usage.summary.contextsLast30Days} in last 30 days
            </Text>
          </div>
          <div>
            <Text strong>{usage.summary.uniqueTags}</Text>
            <Text type="secondary"> active tags</Text>
          </div>
          <div>
            <Text type="secondary">
              Last context:{' '}
              {usage.summary.lastContextAt ? formatDateTime(usage.summary.lastContextAt) : 'N/A'}
            </Text>
          </div>
          <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={fetching}>
            Refresh
          </Button>
        </Space>
      </Card>

      <Card title="Daily Activity (30 days)" bordered={false}>
        {usage.dailyActivity.length > 0 ? (
          <Line {...dailyConfig} />
        ) : (
          <Alert
            message="No recent activity"
            description="Create contexts to populate daily activity insights."
            type="info"
            showIcon
          />
        )}
      </Card>

      <Card title="Activity by Hour" bordered={false}>
        {usage.hourlyDistribution.length > 0 ? (
          <Column {...hourlyConfig} />
        ) : (
          <Alert
            message="Insufficient data"
            description="Hourly breakdown requires recent context activity."
            type="info"
            showIcon
          />
        )}
      </Card>

      <Card title="Context Types" bordered={false}>
        {usage.contextsByType.length > 0 ? (
          <Column {...typeConfig} />
        ) : (
          <Alert
            message="No contexts captured"
            description="Add contexts to evaluate type distribution."
            type="info"
            showIcon
          />
        )}
      </Card>

      <Card title="Top Tags" bordered={false}>
        {usage.topTags.length > 0 ? (
          <List
            dataSource={usage.topTags}
            renderItem={item => (
              <List.Item>
                <Space size="large">
                  <Text strong>{item.tag}</Text>
                  <Text type="secondary">{item.count} contexts</Text>
                </Space>
              </List.Item>
            )}
          />
        ) : (
          <Alert
            message="No tag activity yet"
            description="Tag contexts to expose top themes for this project."
            type="info"
            showIcon
          />
        )}
      </Card>
    </Space>
  );
};

export default UsagePatterns;
