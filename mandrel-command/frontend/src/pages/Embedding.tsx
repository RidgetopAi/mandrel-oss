/**
 * Embedding Visualization — the analytics screen for the embedding vectors behind the
 * context corpus.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  ONE SELECTOR, SEVEN PANELS (epic 41293984 §E)
 * ════════════════════════════════════════════════════════════════════════════════════
 * Every one of the seven panels used to call `useEffectiveProjectId()` for itself, and the
 * page had no control at all — so which project's embedding space you were looking at was
 * decided by the global switcher in the app shell, which this epic deletes. The scope now
 * lives HERE, in one `usePageProject()`, and is passed down. That is a requirement, not a
 * tidy-up: seven independent readers cannot be pointed anywhere by a single control, and
 * two of them disagreeing would be invisible (each panel renders its own numbers).
 *
 * No `allowAll`. `requireProjectId` in `api/embeddingsClient.ts` throws without a concrete
 * project and the routes are header-scoped on a uuid, so `'all'` is not a wider view here —
 * it is an error. The panels below are still antd (migrating them is a separate job); the
 * SELECTOR is the new token-driven primitive regardless.
 */
import React from 'react';
import { Typography, Tabs, Card, Space, Alert } from 'antd';
import {
  HeatMapOutlined,
  DotChartOutlined,
  GroupOutlined,
  ThunderboltOutlined,
  BarChartOutlined,
  SettingOutlined,
  ClusterOutlined,
  AlertOutlined,
  LineChartOutlined,
} from '@ant-design/icons';
import { useEmbeddingStore } from '../stores/embeddingStore';
import { usePageProject } from '../hooks/usePageProject';
import SimilarityHeatmap from '../components/embedding/SimilarityHeatmap';
import ScatterProjection from '../components/embedding/ScatterProjection';
import ClusterAnalysis from '../components/embedding/ClusterAnalysis';
import QualityMetrics from '../components/embedding/QualityMetrics';
import ProjectRelationshipMap from '../components/embedding/ProjectRelationshipMap';
import KnowledgeGapInsights from '../components/embedding/KnowledgeGapInsights';
import UsagePatterns from '../components/embedding/UsagePatterns';

const { Title, Text } = Typography;

const Embedding: React.FC = () => {
  const { activeTab, setActiveTab } = useEmbeddingStore();
  const project = usePageProject();
  // ONE value, spread to all seven. Read it once here so no panel can be handed a
  // different project than its neighbour.
  const panelProps = { projectId: project.projectId };

  const tabItems = [
    {
      key: 'heatmap',
      label: (
        <Space>
          <HeatMapOutlined />
          Similarity Heatmap
        </Space>
      ),
      children: <SimilarityHeatmap {...panelProps} />,
    },
    {
      key: 'scatter',
      label: (
        <Space>
          <DotChartOutlined />
          2D Projection
        </Space>
      ),
      children: <ScatterProjection {...panelProps} />,
    },
    {
      key: 'cluster',
      label: (
        <Space>
          <GroupOutlined />
          Clustering
        </Space>
      ),
      children: <ClusterAnalysis {...panelProps} />,
    },
    {
      key: 'relationships',
      label: (
        <Space>
          <ClusterOutlined />
          Relationships
        </Space>
      ),
      children: <ProjectRelationshipMap {...panelProps} />,
    },
    {
      key: 'knowledge',
      label: (
        <Space>
          <AlertOutlined />
          Knowledge Gaps
        </Space>
      ),
      children: <KnowledgeGapInsights {...panelProps} />,
    },
    {
      key: 'usage',
      label: (
        <Space>
          <LineChartOutlined />
          Usage Patterns
        </Space>
      ),
      children: <UsagePatterns {...panelProps} />,
    },
    {
      key: '3d',
      label: (
        <Space>
          <ThunderboltOutlined />
          3D View
        </Space>
      ),
      children: (
        <Card title="3D Embedding Space" bordered={false}>
          <Alert
            message="Phase 4: 3D Toggle with Plotly"
            description="Interactive 3D visualization using react-plotly.js for immersive exploration."
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Text type="secondary">
            Explore embeddings in 3D space with interactive rotation, zoom, and hover details
            for a more immersive understanding of the embedding space.
          </Text>
        </Card>
      ),
    },
    {
      key: 'metrics',
      label: (
        <Space>
          <BarChartOutlined />
          Metrics
        </Space>
      ),
      children: <QualityMetrics {...panelProps} />,
    },
    {
      key: 'settings',
      label: (
        <Space>
          <SettingOutlined />
          Settings
        </Space>
      ),
      children: (
        <Card title="Visualization Settings" bordered={false}>
          <Alert
            message="Phase 6: Performance & Polish"
            description="Configuration options, performance optimizations, and export capabilities."
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Text type="secondary">
            Configure visualization parameters, performance settings, 
            and export options for sharing insights.
          </Text>
        </Card>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={2}>Embedding Visualization System</Title>
        <Text type="secondary">
          Interactive visualization and analysis of embedding vectors from your Mandrel context data.
          Explore similarities, clusters, and patterns in high-dimensional space.
        </Text>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        size="large"
        tabPosition="top"
      />
    </div>
  );
};

export default Embedding;
