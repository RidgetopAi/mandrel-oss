import React, { useEffect, useMemo, useState } from 'react';
import type { EmbeddingPanelProps } from './panelProps';
import { Card, Spin, Alert, Row, Col, Statistic, Select, Slider, Divider, Button, Space } from 'antd';
import { Scatter } from '@ant-design/plots';
import { ReloadOutlined } from '@ant-design/icons';
import { useTheme } from '../../contexts/ThemeContext';
import {
  useEmbeddingProjectionQuery,
} from '../../hooks/useEmbeddings';
import { useEmbeddingDatasetSelection } from '../../hooks/useEmbeddingDatasetSelection';
import { markdownExcerpt } from '../common/MarkdownContent';
import { chartTheme } from '../../utils/chartTheme';

const { Option } = Select;

type ProjectionPoint = {
  x: number;
  y: number;
  z?: number;
  label: string;
  content: string;
  id: string;
};

// The page owns the scope; this panel is TOLD which project it is showing (one
// selector for all seven — see panelProps.ts).
const ScatterProjection: React.FC<EmbeddingPanelProps> = ({ projectId }) => {
  const { themeMode } = useTheme();
  // Single source for the dark-mode chart tokens (utils/chartTheme).
  const ct = chartTheme(themeMode);

  const [algorithm, setAlgorithm] = useState<string>('pca');
  const [sampleSize, setSampleSize] = useState<number>(500);
  const [selectedPoint, setSelectedPoint] = useState<ProjectionPoint | null>(null);
  const { datasetsQuery, datasets, selectedDatasetId, setSelectedDatasetId } =
    useEmbeddingDatasetSelection(projectId);

  const projectionQuery = useEmbeddingProjectionQuery(
    {
      datasetId: selectedDatasetId ?? undefined,
      algorithm,
      sampleSize,
      projectId,
    },
    {
      enabled: Boolean(projectId && selectedDatasetId),
      refetchOnWindowFocus: false,
    }
  );

  const projectionData = projectionQuery.data ?? null;
  const loading = datasetsQuery.isLoading || projectionQuery.isLoading;
  const fetching = datasetsQuery.isFetching || projectionQuery.isFetching;
  const error = (datasetsQuery.error as Error) ?? (projectionQuery.error as Error) ?? null;

  useEffect(() => {
    if (!projectionData) {
      setSelectedPoint(null);
    }
  }, [projectionData]);

  const handleRefresh = () => {
    void projectionQuery.refetch();
  };

  const fmtPercentage = (value?: number) =>
    typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'N/A';

  const config = useMemo(() => ({
    appendPadding: 10,
    data: projectionData?.points ?? [],
    xField: 'x',
    yField: 'y',
    colorField: 'id',
    size: 4,
    shape: 'circle',
    tooltip: {
      fields: ['label', 'content', 'x', 'y'],
      formatter: (datum: ProjectionPoint) => ({
        name: datum.label,
        value: `${markdownExcerpt(datum.content, 160)}\nCoords: (${datum.x.toFixed(3)}, ${datum.y.toFixed(3)})`,
      }),
    },
    interactions: [
      { type: 'brush', enable: true },
      { type: 'zoom-canvas', enable: true },
      { type: 'drag-canvas', enable: true },
    ],
    onReady: (plot: any) => {
      plot.off('plot:click');
      plot.on('plot:click', (evt: any) => {
        const { data } = evt;
        if (data) {
          setSelectedPoint(data.data);
        }
      });
    },
    xAxis: {
      title: {
        text: `PC1 ${fmtPercentage(projectionData?.varianceExplained?.[0])}`,
        style: {
          fill: ct.textColor,
        },
      },
      label: {
        style: {
          fill: ct.textColor,
        },
      },
      grid: {
        line: {
          style: {
            stroke: ct.gridColor,
          },
        },
      },
    },
    yAxis: {
      title: {
        text: `PC2 ${fmtPercentage(projectionData?.varianceExplained?.[1])}`,
        style: {
          fill: ct.textColor,
        },
      },
      label: {
        style: {
          fill: ct.textColor,
        },
      },
      grid: {
        line: {
          style: {
            stroke: ct.gridColor,
          },
        },
      },
    },
    legend: false,
    // Dark-mode-aware theme (single source: utils/chartTheme). 'classicDark'
    // is the valid G2 v5 key — the prior 'dark'/'light' were not registered.
    theme: ct.theme,
  }), [projectionData, ct.textColor, ct.gridColor, ct.theme]);

  if (!projectId) {
    return (
      <Card title="2D Scatter Plot Projection" bordered={false}>
        <Alert
          message="Select a project"
          description="Choose a project to explore embedding projections."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  if (loading && !projectionData) {
    return (
      <Card title="2D Scatter Plot Projection" bordered={false}>
        <div style={{ textAlign: 'center', padding: '50px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>Loading embeddings...</div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="2D Scatter Plot Projection" bordered={false}>
        <Alert
          message="Error"
          description={error.message}
          type="error"
          showIcon
        />
        <Button style={{ marginTop: 16 }} icon={<ReloadOutlined />} onClick={handleRefresh}>
          Retry
        </Button>
      </Card>
    );
  }

  if (datasets.length === 0) {
    return (
      <Card title="2D Scatter Plot Projection" bordered={false}>
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
      <Card title="2D Scatter Plot Projection" bordered={false}>
        <Alert
          message="No dataset selected"
          description="Select an embedding dataset to visualize the projection."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  const totalVariance = projectionData?.varianceExplained?.reduce((sum, value) => sum + value, 0) ?? 0;

  return (
    <Row gutter={16}>
      <Col span={selectedPoint ? 16 : 24}>
        <Card
          title="2D Scatter Plot Projection"
          bordered={false}
          extra={
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={fetching}>
              Refresh
            </Button>
          }
        >
          <Card size="small" title="Projection Settings" style={{ marginBottom: 16 }} bodyStyle={{ padding: '12px 16px' }}>
            <Row gutter={16} align="middle">
              <Col span={6}>
                <label>Dataset:</label>
                <Select
                  value={selectedDatasetId}
                  onChange={setSelectedDatasetId}
                  style={{ width: '100%', marginTop: 4 }}
                  loading={datasetsQuery.isFetching}
                >
                  {datasets.map(dataset => (
                    <Option key={dataset.id} value={dataset.id}>
                      {dataset.name} ({dataset.count} items)
                    </Option>
                  ))}
                </Select>
              </Col>
              <Col span={6}>
                <label>Algorithm:</label>
                <Select
                  value={algorithm}
                  onChange={(value) => setAlgorithm(value)}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  <Option value="pca">PCA (2D)</Option>
                  <Option value="pca3d" disabled>
                    PCA (3D) – Coming soon
                  </Option>
                  <Option value="tsne" disabled>t-SNE – Roadmap</Option>
                </Select>
              </Col>
              <Col span={8}>
                <label>Sample Size: {sampleSize}</label>
                <Slider
                  min={100}
                  max={2000}
                  step={100}
                  value={sampleSize}
                  onChange={value => setSampleSize(value)}
                />
              </Col>
              <Col span={4}>
                <Space direction="vertical" size={4}>
                  <Statistic
                    title="Point Count"
                    value={projectionData?.points.length ?? 0}
                  />
                  <Statistic
                    title="Variance Captured"
                    value={fmtPercentage(totalVariance)}
                  />
                </Space>
              </Col>
            </Row>
          </Card>

          {projectionData ? <Scatter {...config} /> : (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin size="large" />
            </div>
          )}
        </Card>
      </Col>
      {selectedPoint && (
        <Col span={8}>
          <Card title="Point Details" bordered={false}>
            <Space direction="vertical" size="small">
              <Statistic title="Label" value={selectedPoint.label} />
              <Statistic
                title="Coordinates"
                value={`(${selectedPoint.x.toFixed(3)}, ${selectedPoint.y.toFixed(3)})`}
              />
              <Divider />
              <div>
                <strong>Content Preview</strong>
                <p style={{ marginTop: 8 }}>{markdownExcerpt(selectedPoint.content, 400)}</p>
              </div>
              <Button onClick={() => setSelectedPoint(null)}>Clear Selection</Button>
            </Space>
          </Card>
        </Col>
      )}
    </Row>
  );
};

export default ScatterProjection;
