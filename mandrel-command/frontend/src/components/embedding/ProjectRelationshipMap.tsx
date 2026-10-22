import React, { useMemo } from 'react';
import type { EmbeddingPanelProps } from './panelProps';
import { Card, Alert, Spin, Button, Space, List, Tag, Typography } from 'antd';
import ReactFlow, { Controls, Background, type Node, type Edge, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import { ReloadOutlined } from '@ant-design/icons';
import { useEmbeddingRelationshipsQuery } from '../../hooks/useEmbeddings';

const { Text } = Typography;

const RADIUS = 250;

// The page owns the scope; this panel is TOLD which project it is showing (one
// selector for all seven — see panelProps.ts).
const ProjectRelationshipMap: React.FC<EmbeddingPanelProps> = ({ projectId }) => {

  const relationshipsQuery = useEmbeddingRelationshipsQuery(projectId, {
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
  });

  const loading = relationshipsQuery.isLoading;
  const fetching = relationshipsQuery.isFetching;
  const error = relationshipsQuery.error as Error | null;
  const relationships = relationshipsQuery.data ?? null;

  const { nodes, edges } = useMemo(() => {
    if (!relationships) {
      return { nodes: [] as Node[], edges: [] as Edge[] };
    }

    const related = relationships.relatedProjects;

    const focusNode: Node = {
      id: relationships.focusProject.projectId,
      data: {
        label: (
          <Space direction="vertical" size={0} style={{ width: '100%', color: '#fff' }}>
            <Text strong style={{ color: '#fff' }}>{relationships.focusProject.projectName}</Text>
            <Text style={{ color: '#fff', opacity: 0.85 }}>
              {relationships.focusProject.contextCount} contexts · {relationships.focusProject.tagCount} tags
            </Text>
          </Space>
        ),
      },
      position: { x: 0, y: 0 },
      style: {
        background: '#722ed1',
        color: '#fff',
        borderRadius: 12,
        padding: '12px 16px',
        minWidth: 200,
        textAlign: 'center' as const,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };

    if (related.length === 0) {
      return { nodes: [focusNode], edges: [] };
    }

    const angleStep = (Math.PI * 2) / related.length;

    const relatedNodes: Node[] = related.map((project, index) => {
      const angle = angleStep * index;
      const x = Math.cos(angle) * RADIUS;
      const y = Math.sin(angle) * RADIUS;

      return {
        id: project.projectId,
        data: {
          label: (
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Text strong style={{ color: '#000', fontSize: '14px' }}>{project.projectName}</Text>
              <Text style={{ color: '#666', fontSize: '12px' }}>
                {project.sharedTagCount ?? 0} shared tags · {project.contextCount} contexts
              </Text>
            </Space>
          ),
        },
        position: { x, y },
        style: {
          background: '#fff',
          border: '2px solid #d9d9d9',
          borderRadius: 12,
          padding: '12px 16px',
          minWidth: 200,
          textAlign: 'center' as const,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    });

    const flowEdges: Edge[] = relationships.edges.map(edge => ({
      id: `${edge.sourceProjectId}-${edge.targetProjectId}`,
      source: edge.sourceProjectId,
      target: edge.targetProjectId,
      label: `${(edge.sharedTagStrength || 0).toFixed(0)} strength`,
      animated: true,
      style: {
        stroke: '#722ed1',
        strokeWidth: Math.min(6, Math.max(2, (edge.sharedTagStrength || 0) / 5)),
      },
    }));

    return {
      nodes: [focusNode, ...relatedNodes],
      edges: flowEdges,
    };
  }, [relationships]);

  const handleRefresh = () => {
    void relationshipsQuery.refetch();
  };

  if (!projectId) {
    return (
      <Card title="Project Relationship Map">
        <Alert
          message="Select a project"
          description="Choose a project to explore cross-project relationships."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  if (loading && !relationships) {
    return (
      <Card title="Project Relationship Map">
        <div style={{ textAlign: 'center', padding: '50px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>Loading project relationships...</div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Project Relationship Map">
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

  if (!relationships || relationships.summary.totalRelatedProjects === 0) {
    return (
      <Card
        title="Project Relationship Map"
        extra={
          <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={fetching}>
            Refresh
          </Button>
        }
      >
        <Alert
          message="No cross-project overlaps yet"
          description="The selected project does not share tagged contexts with other projects. As teams capture more context with shared tags, relationships will appear here."
          type="info"
          showIcon
        />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title="Project Relationship Graph"
        bordered={false}
        extra={
          <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={fetching}>
            Refresh
          </Button>
        }
        bodyStyle={{ height: '70vh', minHeight: 500 }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          minZoom={0.5}
          maxZoom={1.5}
        >
          <Background color="#f0f0f0" gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </Card>

      <Card title="Relationship Details" bordered={false}>
        <List
          dataSource={relationships.relatedProjects}
          renderItem={(project) => {
            const edge = relationships.edges.find(e => e.targetProjectId === project.projectId);
            const tags = edge?.topTags ?? [];

            return (
              <List.Item>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Space size="large">
                    <Text strong style={{ color: '#000', fontSize: '15px' }}>{project.projectName}</Text>
                    <Text style={{ color: '#666', fontSize: '14px' }}>{project.contextCount} contexts</Text>
                    <Text style={{ color: '#666', fontSize: '14px' }}>Shared strength: {edge?.sharedTagStrength.toFixed(0)}</Text>
                  </Space>
                  {tags.length > 0 ? (
                    <Space wrap>
                      {tags.map(tag => (
                        <Tag key={tag} color="geekblue">
                          {tag}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <Text type="secondary">No shared tags identified.</Text>
                  )}
                </Space>
              </List.Item>
            );
          }}
        />
      </Card>
    </Space>
  );
};

export default ProjectRelationshipMap;
