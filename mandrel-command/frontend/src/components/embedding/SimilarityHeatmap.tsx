import React, { useMemo, useState } from 'react';
import type { EmbeddingPanelProps } from './panelProps';
import { Card, Spin, Alert, Select, Space, InputNumber, Button } from 'antd';
import { ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import Plot from 'react-plotly.js';
import { useTheme } from '../../contexts/ThemeContext';
import {
  useSimilarityMatrixQuery,
} from '../../hooks/useEmbeddings';
import { useEmbeddingStore } from '../../stores/embeddingStore';
import { useEmbeddingDatasetSelection } from '../../hooks/useEmbeddingDatasetSelection';

const { Option } = Select;

// The page owns the scope; this panel is TOLD which project it is showing (one
// selector for all seven — see panelProps.ts).
const SimilarityHeatmap: React.FC<EmbeddingPanelProps> = ({ projectId }) => {
  const { themeMode } = useTheme();

  const { heatmapSize, updateHeatmapSize } = useEmbeddingStore();
  const [showSettings, setShowSettings] = useState(false);

  const { datasetsQuery, datasets, selectedDatasetId, setSelectedDatasetId } =
    useEmbeddingDatasetSelection(projectId);

  const similarityQuery = useSimilarityMatrixQuery(
    {
      datasetId: selectedDatasetId ?? undefined,
      rows: heatmapSize.rows,
      cols: heatmapSize.cols,
      projectId,
    },
    {
      enabled: Boolean(projectId && selectedDatasetId),
      refetchOnWindowFocus: false,
    }
  );

  const loading = datasetsQuery.isLoading || similarityQuery.isLoading;
  const fetching = datasetsQuery.isFetching || similarityQuery.isFetching;
  const error = (datasetsQuery.error as Error) ?? (similarityQuery.error as Error) ?? null;
  const similarityMatrix = similarityQuery.data ?? null;

  const plotlyData = useMemo(() => {
    if (!similarityMatrix) {
      return [];
    }

    const { matrix, labels } = similarityMatrix;

    return [{
      type: 'heatmap' as const,
      z: matrix,
      x: labels,
      y: labels,
      colorscale: [
        [0, '#313695'],
        [0.1, '#4575b4'],
        [0.2, '#74add1'],
        [0.3, '#abd9e9'],
        [0.4, '#e0f3f8'],
        [0.5, '#ffffcc'],
        [0.6, '#fee090'],
        [0.7, '#fdae61'],
        [0.8, '#f46d43'],
        [0.9, '#d73027'],
        [1, '#a50026']
      ] as Array<[number, string]>,
      colorbar: {
        title: {
          text: 'Cosine<br>Similarity',
          side: 'right',
        },
        tickfont: {
          color: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.85)' : '#000',
          size: 11,
        },
        titlefont: {
          color: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.85)' : '#000',
          size: 12,
        },
        thickness: 20,
        len: 0.7,
      },
      hovertemplate:
        '<b>X:</b> %{x}<br>' +
        '<b>Y:</b> %{y}<br>' +
        '<b>Similarity:</b> %{z:.3f}<br>' +
        '<extra></extra>',
      zmin: 0,
      zmax: 1,
      showscale: true,
      xgap: 1,
      ygap: 1,
    }] as any;
  }, [similarityMatrix, themeMode]);

  const layout = useMemo(() => ({
    width: 1100,
    height: 1100,
    autosize: false,
    xaxis: {
      title: {
        text: 'Context Items',
        font: {
          size: 12,
          color: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.85)' : '#000',
        },
      },
      tickangle: -45,
      tickfont: {
        size: 9,
        color: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.85)' : '#666',
      },
      ticklabelstandoff: -20,
      side: 'bottom' as const,
      gridcolor: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
      showgrid: false,
    },
    yaxis: {
      title: {
        text: 'Context Items',
        font: {
          size: 12,
          color: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.85)' : '#000',
        },
      },
      tickfont: {
        size: 9,
        color: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.85)' : '#666',
      },
      ticklabelstandoff: 5,
      autorange: 'reversed' as const,
      gridcolor: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
      showgrid: false,
      scaleanchor: 'x' as const,
      scaleratio: 1,
      automargin: true,
    },
    plot_bgcolor: themeMode === 'dark' ? '#141414' : '#fff',
    paper_bgcolor: themeMode === 'dark' ? '#141414' : '#fff',
    font: {
      color: themeMode === 'dark' ? 'rgba(255, 255, 255, 0.85)' : '#000',
    },
    margin: {
      l: 305,
      r: 85,
      t: 35,
      b: 130,
      pad: 0,
    },
  }), [themeMode]);

  const config = useMemo(() => ({
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['select2d', 'lasso2d'] as any,
    toImageButtonOptions: {
      format: 'png' as const,
      filename: 'similarity-heatmap',
      height: 1200,
      width: 1200,
      scale: 2,
    },
    responsive: true,
  }), []);

  const handleRetry = () => {
    void Promise.all([datasetsQuery.refetch(), similarityQuery.refetch()]);
  };

  const handleRefresh = () => {
    void similarityQuery.refetch();
  };

  if (!projectId) {
    return (
      <Card title="Embedding Similarity Heatmap">
        <Alert
          message="Select a project"
          description="Choose a project to load embedding datasets and similarity analytics."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  if (loading && !similarityMatrix) {
    return (
      <Card title="Embedding Similarity Heatmap">
        <div style={{ textAlign: 'center', padding: '24px' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>Loading embedding datasets...</div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Embedding Similarity Heatmap">
        <Alert
          message="Error"
          description={error.message}
          type="error"
          showIcon
        />
        <Button onClick={handleRetry} style={{ marginTop: 16 }} icon={<ReloadOutlined />}>
          Retry
        </Button>
      </Card>
    );
  }

  return (
    <Card
      title="Embedding Similarity Heatmap"
      extra={
        <Space>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setShowSettings(!showSettings)}
            type={showSettings ? 'primary' : 'default'}
          >
            Settings
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            disabled={!selectedDatasetId}
            loading={fetching && Boolean(selectedDatasetId)}
          >
            Refresh
          </Button>
        </Space>
      }
    >
      {showSettings && (
        <Card
          size="small"
          style={{
            marginBottom: 16,
            backgroundColor: themeMode === 'dark' ? '#1f1f1f' : '#f9f9f9'
          }}
        >
          <Space wrap>
            <div>
              <label>Dataset: </label>
              <Select
                value={selectedDatasetId ?? undefined}
                onChange={setSelectedDatasetId}
                style={{ width: 240 }}
                placeholder="Select dataset"
                loading={datasetsQuery.isFetching}
              >
                {datasets.map(dataset => (
                  <Option key={dataset.id} value={dataset.id}>
                    {dataset.name} ({dataset.count} items)
                  </Option>
                ))}
              </Select>
            </div>
            <div>
              <label>Rows: </label>
              <InputNumber
                min={10}
                max={200}
                value={heatmapSize.rows}
                onChange={(value) =>
                  updateHeatmapSize({ rows: Number(value ?? 50), cols: heatmapSize.cols })
                }
              />
            </div>
            <div>
              <label>Cols: </label>
              <InputNumber
                min={10}
                max={200}
                value={heatmapSize.cols}
                onChange={(value) =>
                  updateHeatmapSize({ rows: heatmapSize.rows, cols: Number(value ?? 50) })
                }
              />
            </div>
          </Space>
        </Card>
      )}

      {!selectedDatasetId && (
        <Alert
          message="No dataset selected"
          description="Choose an embedding dataset to visualize similarity scores."
          type="info"
          showIcon
        />
      )}

      {selectedDatasetId && similarityMatrix && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <Plot
            data={plotlyData}
            layout={layout}
            config={config}
            useResizeHandler={false}
          />
        </div>
      )}
    </Card>
  );
};

export default SimilarityHeatmap;
