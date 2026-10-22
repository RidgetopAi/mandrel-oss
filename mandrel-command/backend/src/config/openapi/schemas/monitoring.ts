/**
 * Monitoring OpenAPI Schemas
 */

export const monitoringSchemas = {
  MonitoringHealth: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['healthy', 'degraded', 'unhealthy']
      },
      timestamp: { type: 'number' },
      checks: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['healthy', 'degraded', 'unhealthy']
            },
            message: { type: 'string' },
            responseTime: { type: 'number' }
          },
          required: ['status', 'message']
        }
      },
      summary: {
        type: 'object',
        properties: {
          totalChecks: { type: 'integer' },
          healthyChecks: { type: 'integer' }
        }
      }
    },
    required: ['status', 'timestamp', 'checks']
  },

  MonitoringMetrics: {
    type: 'object',
    properties: {
      timestamp: { type: 'number' },
      system: {
        type: 'object',
        properties: {
          uptime: { type: 'number' },
          memory: {
            type: 'object',
            properties: {
              used: { type: 'number' },
              free: { type: 'number' },
              total: { type: 'number' },
              percentage: { type: 'number' }
            }
          },
          cpu: {
            type: 'object',
            properties: {
              usage: { type: 'number' }
            }
          },
          process: {
            type: 'object',
            properties: {
              pid: { type: 'integer' },
              uptime: { type: 'number' },
              memoryUsage: {
                type: 'object',
                properties: {
                  rss: { type: 'number' },
                  heapUsed: { type: 'number' },
                  heapTotal: { type: 'number' },
                  external: { type: 'number' }
                }
              }
            }
          }
        }
      },
      database: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['healthy', 'degraded', 'unhealthy']
          },
          responseTime: { type: 'number' },
          activeConnections: { type: 'number' }
        }
      },
      api: {
        type: 'object',
        properties: {
          requestCount: { type: 'integer' },
          errorRate: { type: 'number' },
          averageResponseTime: { type: 'number' }
        }
      }
    },
    required: ['timestamp', 'system', 'database', 'api']
  },

  MonitoringTrends: {
    type: 'object',
    properties: {
      timestamp: { type: 'number' },
      windowMinutes: { type: 'number' },
      trends: {
        type: 'object',
        properties: {
          responseTime: {
            type: 'array',
            items: { type: 'number' }
          },
          errorRate: { type: 'number' },
          requestVolume: { type: 'number' }
        }
      }
    },
    required: ['timestamp', 'windowMinutes', 'trends']
  },

  MonitoringServiceStatus: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      port: { type: 'integer' },
      status: {
        type: 'string',
        enum: ['healthy', 'degraded', 'down']
      },
      responseTime: { type: 'number' },
      lastCheck: { type: 'string', format: 'date-time' },
      url: { type: 'string' },
      slaTarget: { type: 'number' },
      uptime: { type: 'number' },
      error: { type: 'string' }
    },
    required: ['name', 'port', 'status', 'responseTime', 'lastCheck', 'url', 'slaTarget']
  },

  MonitoringServicesHealth: {
    type: 'object',
    properties: {
      timestamp: { type: 'string', format: 'date-time' },
      services: {
        type: 'array',
        items: { $ref: '#/components/schemas/MonitoringServiceStatus' }
      },
      summary: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          healthy: { type: 'integer' },
          degraded: { type: 'integer' },
          down: { type: 'integer' }
        },
        required: ['total', 'healthy', 'degraded', 'down']
      }
    },
    required: ['timestamp', 'services', 'summary']
  },

  MonitoringStats: {
    type: 'object',
    properties: {
      totalServices: { type: 'integer' },
      healthyServices: { type: 'integer' },
      degradedServices: { type: 'integer' },
      downServices: { type: 'integer' },
      averageResponseTime: { type: 'number' },
      slaCompliance: { type: 'number' },
      lastUpdate: { type: 'string', format: 'date-time' }
    }
  },

  MonitoringAlertRule: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      service: { type: 'string' },
      metric: { type: 'string' },
      threshold: { type: 'number' },
      operator: { type: 'string', enum: ['gt', 'lt', 'eq'] },
      severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
      enabled: { type: 'boolean' },
      cooldown: { type: 'number' },
      lastTriggered: { type: 'string', format: 'date-time' }
    },
    required: ['id', 'service', 'metric', 'threshold', 'operator', 'severity', 'enabled', 'cooldown']
  },

  MonitoringAlert: {
    type: 'object',
    properties: {
      rule: { $ref: '#/components/schemas/MonitoringAlertRule' },
      timestamp: { type: 'string', format: 'date-time' },
      value: { type: 'number' }
    },
    required: ['rule', 'timestamp', 'value']
  }
};
