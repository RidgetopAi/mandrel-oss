import React, { useMemo } from 'react';
import type { EmbeddingPanelProps } from './panelProps';
import { Card, Alert, Spin, Button, Row, Col, Statistic, Space, Progress, Typography, Select } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useEmbeddingDatasetSelection } from '../../hooks/useEmbeddingDatasetSelection';
import { useEmbeddingMetricsQuery } from '../../hooks/useEmbeddings';

const { Text } = Typography;
const { Option } = Select;

const formatNumber = (value: number | undefined, digits = 3) =>
  typeof value === 'number' ? Number(value).toFixed(digits) : '—';

// The page owns the scope; this panel is TOLD which project it is showing (one
// selector for all seven — see panelProps.ts).
const QualityMetrics: React.FC<EmbeddingPanelProps> = ({ projectId }) => {

  const {
    datasetsQuery,
    datasets,
    selectedDatasetId,
    setSelectedDatasetId,
  } = useEmbeddingDatasetSelection(projectId);

  const metricsQuery = useEmbeddingMetricsQuery(
    {
      datasetId: selectedDatasetId ?? undefined,
      projectId,
    },
    {
      enabled: Boolean(projectId && selectedDatasetId),
      refetchOnWindowFocus: false,
    }
  );

  const metrics = metricsQuery.data ?? null;
  const loading = datasetsQuery.isLoading || metricsQuery.isLoading;
  const fetching = datasetsQuery.isFetching || metricsQuery.isFetching;
  const error = (datasetsQuery.error as Error) ?? (metricsQuery.error as Error) ?? null;

  const densityBars = useMemo(() => {
    if (!metrics) {
      return [];
    }
    const { avgDistance, minDistance, maxDistance } = metrics.densityMetrics;
    const normalizedMin = maxDistance > 0 ? (minDistance / maxDistance) * 100 : 0;
    const normalizedAvg = maxDistance > 0 ? (avgDistance / maxDistance) * 100 : 0;

    return [
      {
        label: 'Avg distance vs. max',
        percent: Number(normalizedAvg.toFixed(1)),
        description: `Average pairwise distance (${formatNumber(avgDistance)}) relative to max (${formatNumber(maxDistance)})`,
      },
      {
        label: 'Min distance vs. max',
        percent: Number(normalizedMin.toFixed(1)),
        description: `Closest neighbours (${formatNumber(minDistance)}) versus farthest (${formatNumber(maxDistance)})`,
      },
    ];
  }, [metrics]);

  const aggregatedDistribution = useMemo(() => {
    if (!metrics) {
      return null;
    }

    const { mean, std, min, max } = metrics.distributionStats;
    const getAverage = (values: number[]) =>
      values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

    const safeMin = min.length > 0 ? Math.min(...min) : 0;
    const safeMax = max.length > 0 ? Math.max(...max) : 0;

    return {
      mean: getAverage(mean),
      std: getAverage(std),
      min: safeMin,
      max: safeMax,
    };
  }, [metrics]);

  const handleRefresh = () => {
    void metricsQuery.refetch();
  };

  if (!projectId) {
    return (
      <Card title="Embedding Quality Metrics" bordered={false}>
        <Alert
          message="Select a project"
          description="Choose a project to review embedding quality metrics."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  if (loading && !metrics) {
    return (
      <Card title="Embedding Quality Metrics" bordered={false}>
        <div style={{ textAlign: 'center', padding: '50px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>Loading quality metrics...</div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Embedding Quality Metrics" bordered={false}>
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

  if (datasets.length === 0) {
    return (
      <Card title="Embedding Quality Metrics" bordered={false}>
        <Alert
          message="No embeddings available"
          description="No embedding datasets were found for this project."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  if (!selectedDatasetId) {
    return (
      <Card title="Embedding Quality Metrics" bordered={false}>
        <Alert
          message="No dataset selected"
          description="Select an embedding dataset to inspect quality metrics."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  return (
    <Card
      title="Embedding Quality Metrics"
      bordered={false}
      extra={
        <Button
          icon={<ReloadOutlined />}
          onClick={handleRefresh}
          loading={fetching}
        >
          Refresh
        </Button>
      }
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title="Total Embeddings" value={metrics?.totalEmbeddings ?? 0} />
          </Col>
          <Col span={8}>
            <Statistic title="Dimensionality" value={metrics?.dimensionality ?? 0} />
          </Col>
          <Col span={8}>
            <Statistic
              title="Average Vector Norm"
              value={formatNumber(metrics?.averageNorm)}
            />
          </Col>
        </Row>

        {metrics && (
          <Card size="small" title="Density Metrics" bodyStyle={{ padding: '12px 16px' }}>
            <Row gutter={16}>
              <Col span={6}>
                <Statistic title="Avg Distance" value={formatNumber(metrics.densityMetrics.avgDistance)} />
              </Col>
              <Col span={6}>
                <Statistic title="Std Dev" value={formatNumber(metrics.densityMetrics.stdDistance)} />
              </Col>
              <Col span={6}>
                <Statistic title="Min Distance" value={formatNumber(metrics.densityMetrics.minDistance)} />
              </Col>
              <Col span={6}>
                <Statistic title="Max Distance" value={formatNumber(metrics.densityMetrics.maxDistance)} />
              </Col>
            </Row>
            <Row gutter={16} style={{ marginTop: 12 }}>
              {densityBars.map(bar => (
                <Col key={bar.label} span={12}>
                  <Text strong>{bar.label}</Text>
                  <Progress percent={bar.percent} size="small" strokeColor="#722ed1" />
                  <Text type="secondary">{bar.description}</Text>
                </Col>
              ))}
            </Row>
          </Card>
        )}

        {aggregatedDistribution && (
          <Card size="small" title="Distribution Overview" bodyStyle={{ padding: '12px 16px' }}>
            <Row gutter={16}>
              <Col span={6}>
                <Statistic title="Mean (avg)" value={formatNumber(aggregatedDistribution.mean)} />
              </Col>
              <Col span={6}>
                <Statistic title="Std Dev (avg)" value={formatNumber(aggregatedDistribution.std)} />
              </Col>
              <Col span={6}>
                <Statistic title="Min (global)" value={formatNumber(aggregatedDistribution.min)} />
              </Col>
              <Col span={6}>
                <Statistic title="Max (global)" value={formatNumber(aggregatedDistribution.max)} />
              </Col>
            </Row>
            <Text type="secondary">
              Aggregates collapse per-dimension statistics to provide a quick health signal. Use the raw
              arrays from the API for deeper audits or to feed offline validation suites.
            </Text>
          </Card>
        )}

        <Card size="small" title="Dataset" bodyStyle={{ padding: '12px 16px' }}>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <div>
              <Text strong>Select Dataset</Text>
              <Select
                value={selectedDatasetId ?? undefined}
                onChange={(value) => setSelectedDatasetId(value ?? null)}
                style={{ width: '100%', marginTop: 8 }}
                loading={datasetsQuery.isFetching}
                allowClear
              >
                {datasets.map(dataset => (
                  <Option key={dataset.id} value={dataset.id}>
                    {dataset.name} ({dataset.count} items)
                  </Option>
                ))}
              </Select>
            </div>
            <Text type="secondary">
              Dataset selection is shared across the embeddings workspace. Choose an alternative corpus to
              recompute quality metrics.
            </Text>
          </Space>
        </Card>
      </Space>
    </Card>
  );
};

export default QualityMetrics;
