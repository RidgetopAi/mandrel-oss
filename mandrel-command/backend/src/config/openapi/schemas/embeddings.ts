/**
 * Embedding OpenAPI Schemas
 */

export const embeddingSchemas = {
  EmbeddingDataset: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      count: { type: 'integer' },
      dimensions: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time' }
    },
    required: ['id', 'name', 'count']
  },

  EmbeddingProjectionPoint: {
    type: 'object',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      z: { type: 'number' },
      label: { type: 'string' },
      content: { type: 'string' },
      id: { type: 'string' }
    },
    required: ['x', 'y', 'label', 'content', 'id']
  },

  EmbeddingSimilarityMatrix: {
    type: 'object',
    properties: {
      matrix: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'number' }
        }
      },
      labels: {
        type: 'array',
        items: { type: 'string' }
      },
      metadata: {
        type: 'object',
        properties: {
          rows: { type: 'integer' },
          cols: { type: 'integer' },
          datasetId: { type: 'string' }
        },
        required: ['rows', 'cols', 'datasetId']
      }
    },
    required: ['matrix', 'labels', 'metadata']
  },

  EmbeddingProjection: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        items: { $ref: '#/components/schemas/EmbeddingProjectionPoint' }
      },
      algorithm: { type: 'string' },
      varianceExplained: {
        type: 'array',
        items: { type: 'number' }
      }
    },
    required: ['points', 'algorithm']
  },

  EmbeddingClusterPoint: {
    allOf: [
      { $ref: '#/components/schemas/EmbeddingProjectionPoint' },
      {
        type: 'object',
        properties: {
          cluster: { type: 'integer' }
        },
        required: ['cluster']
      }
    ]
  },

  EmbeddingClusterResult: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        items: { $ref: '#/components/schemas/EmbeddingClusterPoint' }
      },
      centroids: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            cluster: { type: 'integer' }
          },
          required: ['x', 'y', 'cluster']
        }
      },
      k: { type: 'integer' },
      inertia: { type: 'number' }
    },
    required: ['points', 'centroids', 'k', 'inertia']
  },

  EmbeddingQualityMetrics: {
    type: 'object',
    properties: {
      totalEmbeddings: { type: 'integer' },
      averageNorm: { type: 'number' },
      dimensionality: { type: 'integer' },
      densityMetrics: {
        type: 'object',
        properties: {
          avgDistance: { type: 'number' },
          minDistance: { type: 'number' },
          maxDistance: { type: 'number' },
          stdDistance: { type: 'number' }
        },
        required: ['avgDistance', 'minDistance', 'maxDistance', 'stdDistance']
      },
      distributionStats: {
        type: 'object',
        properties: {
          mean: {
            type: 'array',
            items: { type: 'number' }
          },
          std: {
            type: 'array',
            items: { type: 'number' }
          },
          min: {
            type: 'array',
            items: { type: 'number' }
          },
          max: {
            type: 'array',
            items: { type: 'number' }
          }
        },
        required: ['mean', 'std', 'min', 'max']
      }
    },
    required: ['totalEmbeddings', 'averageNorm', 'dimensionality', 'densityMetrics', 'distributionStats']
  },

  EmbeddingRelevanceDistributionBucket: {
    type: 'object',
    properties: {
      range: { type: 'string' },
      count: { type: 'integer' },
      percentage: { type: 'number' }
    },
    required: ['range', 'count', 'percentage']
  },

  EmbeddingRelevanceTrendPoint: {
    type: 'object',
    properties: {
      date: { type: 'string', format: 'date' },
      averageScore: { type: 'number' },
      sampleSize: { type: 'integer' }
    },
    required: ['date', 'averageScore', 'sampleSize']
  },

  EmbeddingRelevanceTopTag: {
    type: 'object',
    properties: {
      tag: { type: 'string' },
      averageScore: { type: 'number' },
      count: { type: 'integer' }
    },
    required: ['tag', 'averageScore', 'count']
  },

  EmbeddingProjectNode: {
    type: 'object',
    properties: {
      projectId: { type: 'string', format: 'uuid' },
      projectName: { type: 'string' },
      contextCount: { type: 'integer' },
      tagCount: { type: 'integer' },
      sharedTagCount: { type: 'integer' },
      sharedTagStrength: { type: 'number' }
    },
    required: ['projectId', 'projectName', 'contextCount', 'tagCount']
  },

  EmbeddingProjectEdge: {
    type: 'object',
    properties: {
      sourceProjectId: { type: 'string', format: 'uuid' },
      targetProjectId: { type: 'string', format: 'uuid' },
      sharedTagCount: { type: 'integer' },
      sharedTagStrength: { type: 'number' },
      topTags: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['sourceProjectId', 'targetProjectId', 'sharedTagCount', 'sharedTagStrength', 'topTags']
  },

  EmbeddingProjectSummary: {
    type: 'object',
    properties: {
      totalRelatedProjects: { type: 'integer' },
      totalSharedTagStrength: { type: 'number' },
      totalSharedTagCount: { type: 'integer' }
    },
    required: ['totalRelatedProjects', 'totalSharedTagStrength', 'totalSharedTagCount']
  },

  EmbeddingProjectRelationships: {
    type: 'object',
    properties: {
      focusProject: { $ref: '#/components/schemas/EmbeddingProjectNode' },
      relatedProjects: {
        type: 'array',
        items: { $ref: '#/components/schemas/EmbeddingProjectNode' }
      },
      edges: {
        type: 'array',
        items: { $ref: '#/components/schemas/EmbeddingProjectEdge' }
      },
      summary: { $ref: '#/components/schemas/EmbeddingProjectSummary' }
    },
    required: ['focusProject', 'relatedProjects', 'edges', 'summary']
  },

  EmbeddingKnowledgeGapMissingTag: {
    type: 'object',
    properties: {
      tag: { type: 'string' },
      totalCount: { type: 'integer' },
      projectCount: { type: 'integer' },
      lastUsed: { type: 'string', format: 'date-time' },
      topProjects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            projectId: { type: 'string', format: 'uuid', nullable: true },
            projectName: { type: 'string' },
            count: { type: 'integer' }
          },
          required: ['projectName', 'count']
        }
      }
    },
    required: ['tag', 'totalCount', 'projectCount', 'topProjects']
  },

  EmbeddingKnowledgeGapStaleTag: {
    type: 'object',
    properties: {
      tag: { type: 'string' },
      lastUsed: { type: 'string', format: 'date-time' },
      daysSinceLastUsed: { type: 'number' },
      totalCount: { type: 'integer' }
    },
    required: ['tag', 'daysSinceLastUsed', 'totalCount']
  },

  EmbeddingKnowledgeGapTypeInsight: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      totalCount: { type: 'number' },
      globalProjectCount: { type: 'number' },
      averagePerProject: { type: 'number' },
      projectCount: { type: 'number' },
      gap: { type: 'number' }
    },
    required: ['type', 'totalCount', 'globalProjectCount', 'averagePerProject', 'projectCount', 'gap']
  },

  EmbeddingKnowledgeGapSummary: {
    type: 'object',
    properties: {
      projectContextCount: { type: 'integer' },
      projectTagCount: { type: 'integer' },
      missingTagCount: { type: 'integer' },
      staleTagCount: { type: 'integer' },
      lastContextAt: { type: 'string', format: 'date-time', nullable: true }
    },
    required: ['projectContextCount', 'projectTagCount', 'missingTagCount', 'staleTagCount']
  },

  EmbeddingKnowledgeGaps: {
    type: 'object',
    properties: {
      missingTags: {
        type: 'array',
        items: { $ref: '#/components/schemas/EmbeddingKnowledgeGapMissingTag' }
      },
      staleTags: {
        type: 'array',
        items: { $ref: '#/components/schemas/EmbeddingKnowledgeGapStaleTag' }
      },
      underrepresentedTypes: {
        type: 'array',
        items: { $ref: '#/components/schemas/EmbeddingKnowledgeGapTypeInsight' }
      },
      summary: { $ref: '#/components/schemas/EmbeddingKnowledgeGapSummary' }
    },
    required: ['missingTags', 'staleTags', 'underrepresentedTypes', 'summary']
  },

  EmbeddingUsagePatterns: {
    type: 'object',
    properties: {
      dailyActivity: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date' },
            contexts: { type: 'integer' }
          },
          required: ['date', 'contexts']
        }
      },
      contextsByType: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            count: { type: 'integer' },
            percentage: { type: 'number' }
          },
          required: ['type', 'count', 'percentage']
        }
      },
      topTags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string' },
            count: { type: 'integer' }
          },
          required: ['tag', 'count']
        }
      },
      hourlyDistribution: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hour: { type: 'integer' },
            contexts: { type: 'integer' }
          },
          required: ['hour', 'contexts']
        }
      },
      summary: {
        type: 'object',
        properties: {
          contextsLast7Days: { type: 'integer' },
          contextsLast30Days: { type: 'integer' },
          uniqueTags: { type: 'integer' },
          totalContexts: { type: 'integer' },
          lastContextAt: { type: 'string', format: 'date-time', nullable: true }
        },
        required: ['contextsLast7Days', 'contextsLast30Days', 'uniqueTags', 'totalContexts']
      }
    },
    required: ['dailyActivity', 'contextsByType', 'topTags', 'hourlyDistribution', 'summary']
  }
};
