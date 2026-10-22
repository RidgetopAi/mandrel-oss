import React from 'react';
import type { EmbeddingPanelProps } from './panelProps';
import { Card, Alert, Spin, Button, List, Tag, Space, Typography, Table } from 'antd';
import { ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useEmbeddingKnowledgeGapsQuery } from '../../hooks/useEmbeddings';
import { formatDateTime } from '../../utils/datetime';

const { Text, Title } = Typography;

// The page owns the scope; this panel is TOLD which project it is showing (one
// selector for all seven — see panelProps.ts).
const KnowledgeGapInsights: React.FC<EmbeddingPanelProps> = ({ projectId }) => {

  const gapsQuery = useEmbeddingKnowledgeGapsQuery(projectId, {
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
  });

  const loading = gapsQuery.isLoading;
  const fetching = gapsQuery.isFetching;
  const error = gapsQuery.error as Error | null;
  const metrics = gapsQuery.data ?? null;

  const handleRefresh = () => {
    void gapsQuery.refetch();
  };

  if (!projectId) {
    return (
      <Card title="Knowledge Gaps">
        <Alert
          message="Select a project"
          description="Choose a project to analyze coverage gaps."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  if (loading && !metrics) {
    return (
      <Card title="Knowledge Gaps">
        <div style={{ textAlign: 'center', padding: '50px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>Calculating knowledge gaps...</div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Knowledge Gaps">
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

  if (!metrics) {
    return null;
  }

  const columns = [
    {
      title: 'Tag',
      dataIndex: 'tag',
      key: 'tag',
      render: (tag: string) => <Tag color="geekblue">{tag}</Tag>,
    },
    {
      title: 'Total Contexts',
      dataIndex: 'totalCount',
      key: 'totalCount',
    },
    {
      title: 'Projects Using',
      dataIndex: 'projectCount',
      key: 'projectCount',
    },
    {
      title: 'Top Projects',
      dataIndex: 'topProjects',
      key: 'topProjects',
      render: (projects: Array<{ projectName: string; count: number }>) =>
        projects.length > 0 ? (
          <Space direction="vertical" size={0}>
            {projects.map(project => (
              <Text key={project.projectName}>{project.projectName} ({project.count})</Text>
            ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card bordered={false}>
        <Space size="large" align="start" wrap>
          <div>
            <Title level={4} style={{ marginBottom: 0 }}>
              {metrics.summary.projectContextCount} contexts captured
            </Title>
            <Text type="secondary">
              {metrics.summary.projectTagCount} unique tags • Last update{' '}
              {metrics.summary.lastContextAt ? formatDateTime(metrics.summary.lastContextAt) : 'N/A'}
            </Text>
          </div>
          <div>
            <Text strong>{metrics.summary.missingTagCount}</Text>
            <Text type="secondary"> missing tags</Text>
          </div>
          <div>
            <Text strong>{metrics.summary.staleTagCount}</Text>
            <Text type="secondary"> stale tags</Text>
          </div>
          <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={fetching}>
            Refresh
          </Button>
        </Space>
      </Card>

      <Card
        title={
          <Space>
            <WarningOutlined style={{ color: '#fa8c16' }} />
            Critical Coverage Gaps
          </Space>
        }
        bordered={false}
      >
        {metrics.missingTags.length > 0 ? (
          <Table
            dataSource={metrics.missingTags.map((tag, index) => ({
              key: tag.tag || index,
              ...tag,
            }))}
            columns={columns}
            pagination={false}
            size="small"
          />
        ) : (
          <Alert
            message="No missing tags detected"
            description="This project covers the major tag clusters tracked across the workspace."
            type="success"
            showIcon
          />
        )}
      </Card>

      <Card title="Stale Tags" bordered={false}>
        {metrics.staleTags.length > 0 ? (
          <List
            dataSource={metrics.staleTags}
            renderItem={item => (
              <List.Item>
                <Space size="large">
                  <Tag color="gold">{item.tag}</Tag>
                  <Text type="secondary">Last used {Math.round(item.daysSinceLastUsed)} days ago</Text>
                  <Text type="secondary">Occurrences: {item.totalCount}</Text>
                </Space>
              </List.Item>
            )}
          />
        ) : (
          <Alert
            message="No stale tags"
            description="All tags in this project have recent activity."
            type="success"
            showIcon
          />
        )}
      </Card>

      <Card title="Underrepresented Context Types" bordered={false}>
        {metrics.underrepresentedTypes.length > 0 ? (
          <List
            dataSource={metrics.underrepresentedTypes}
            renderItem={item => (
              <List.Item>
                <Space direction="vertical" size={0} style={{ width: '100%' }}>
                  <Space size="large">
                    <Text strong>{item.type.toUpperCase()}</Text>
                    <Text type="secondary">
                      {item.projectCount.toFixed(0)} contexts in project vs. {item.averagePerProject.toFixed(1)} avg
                    </Text>
                  </Space>
                  <Text type="secondary">
                    Gap: {(item.gap).toFixed(1)} · Global total {item.totalCount.toFixed(0)} across {item.globalProjectCount.toFixed(0)} projects
                  </Text>
                </Space>
              </List.Item>
            )}
          />
        ) : (
          <Alert
            message="No major type gaps"
            description="Your project is keeping pace with global activity across context types."
            type="success"
            showIcon
          />
        )}
      </Card>
    </Space>
  );
};

export default KnowledgeGapInsights;
