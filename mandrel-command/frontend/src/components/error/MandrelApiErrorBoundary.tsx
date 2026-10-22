/**
 * TR002-6: Enhanced Error Boundary for AIDIS API Integration
 * Provides comprehensive error handling with V2 API error reporting and graceful degradation
 */

import React, { Component, ReactNode } from 'react';
import { Alert, Button, Card, Space, Typography, Spin } from 'antd';
import { ExclamationCircleOutlined, ReloadOutlined, ApiOutlined } from '@ant-design/icons';
import { mandrelApi } from '../../api/mandrelApiClient';
import { reportError } from '../../services/errorReporter';
import { logger } from '../../utils/logger';


const { Text, Title } = Typography;

interface MandrelApiErrorBoundaryProps {
  children: ReactNode;
  componentName: string;
  fallbackComponent?: ReactNode;
  enableAutoRetry?: boolean;
  maxRetries?: number;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface MandrelApiErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  isRetrying: boolean;
  retryCount: number;
  lastErrorTime: Date | null;
  aidisApiConnected: boolean;
}

export class MandrelApiErrorBoundary extends Component<MandrelApiErrorBoundaryProps, MandrelApiErrorBoundaryState> {
  private retryTimeoutId: NodeJS.Timeout | null = null;

  constructor(props: MandrelApiErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      isRetrying: false,
      retryCount: 0,
      lastErrorTime: null,
      aidisApiConnected: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<MandrelApiErrorBoundaryState> {
    return {
      hasError: true,
      error,
      lastErrorTime: new Date(),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });

    // Report to parent callback if provided
    this.props.onError?.(error, errorInfo);

    // Report error to AIDIS V2 API (async, non-blocking)
    this.reportErrorToAidis(error, errorInfo);

    // Auto-retry logic for API-related errors
    if (this.props.enableAutoRetry && this.isApiError(error) && this.state.retryCount < (this.props.maxRetries || 3)) {
      this.scheduleAutoRetry();
    }
  }

  componentWillUnmount() {
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
    }
  }

  private isApiError(error: Error): boolean {
    // Check if error is related to API calls
    const apiErrorIndicators = [
      'fetch',
      'network',
      'timeout',
      'AIDIS',
      'API',
      'HTTP',
      'Connection',
      'Request failed'
    ];

    return apiErrorIndicators.some(indicator =>
      error.message.toLowerCase().includes(indicator.toLowerCase()) ||
      error.name.toLowerCase().includes(indicator.toLowerCase()) ||
      error.stack?.toLowerCase().includes(indicator.toLowerCase())
    );
  }

  private async reportErrorToAidis(error: Error, errorInfo: React.ErrorInfo) {
    try {
      // Check if AIDIS API is available
      await mandrelApi.ping('Error boundary test');
      this.setState({ aidisApiConnected: true });

      // Store error context via AIDIS API
      const errorContext = {
        componentName: this.props.componentName,
        errorName: error.name,
        errorMessage: error.message,
        componentStack: errorInfo.componentStack,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        url: window.location.href,
        retryCount: this.state.retryCount
      };

      // NOT via MCP `context_store` — see the identical note in
      // hooks/useErrorHandler.ts. A browser is permanently an unidentified caller, so an
      // ambient context_store is rejected by callerIdentityGuard G2 under `enforce`, and
      // before the flip it wrote UI stack traces into whatever project the shared
      // `http-default` slot pointed at. errorReporter is the purpose-built, scope-free path.
      await reportError(error, errorInfo, {
        section: this.props.componentName,
        severity: 'high',
        metadata: { ...errorContext, tags: ['ui-error', 'error-boundary'] },
      });

      logger.log('✅ Error reported:', errorContext);
    } catch (aidisError) {
      this.setState({ aidisApiConnected: false });
      logger.warn('⚠️ Failed to report error to AIDIS API:', aidisError);

      // DELETED HERE (review round 3): the `aidis_ui_errors` localStorage
      // fallback. It pushed up to 10 error records — name, message, stack and component
      // stack — into localStorage under the banner of "offline error tracking".
      //
      // NOTHING EVER READ THEM. The only `getItem('aidis_ui_errors')` in the repo was this
      // function's own accumulator, so the ring buffer was write-only: no UI, no upload on
      // reconnect, no support tooling, no test. It delivered zero diagnostics while being a
      // real liability — localStorage survives reload and is visible to the NEXT user of
      // that browser profile, it was never cleared on logout, and `error.message` is
      // server-returned text that in this product can carry resource ids and names.
      //
      // It was also not tenable to simply wire into the logout teardown: resetAuthState's
      // rule is "everything that survives a route change gets cleared, no exceptions", and
      // adding a member whose only remaining purpose is to be cleared weakens that rule for
      // the next author. Delete beats clear when nothing consumes the data.
      //
      // WHAT IS LOST: nothing that was read. The failure is still surfaced — the warn above
      // fires with the underlying reason, and the primary path (services/errorReporter →
      // POST /api/monitoring/errors, plus Sentry) is unchanged and is where a browser-side
      // breadcrumb belongs. If we later want offline buffering, it belongs in errorReporter
      // with an upload-on-reconnect path, not in an unread buffer here.
    }
  }

  private scheduleAutoRetry() {
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
    }

    this.setState({ isRetrying: true });

    // Exponential backoff: 2^retryCount seconds
    const retryDelay = Math.pow(2, this.state.retryCount) * 1000;

    this.retryTimeoutId = setTimeout(() => {
      this.handleRetry();
    }, retryDelay);
  }

  private handleRetry = () => {
    this.setState(prevState => ({
      hasError: false,
      error: null,
      errorInfo: null,
      isRetrying: false,
      retryCount: prevState.retryCount + 1,
    }));

    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
  };

  private handleManualRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      isRetrying: false,
      retryCount: 0,
    });
  };

  private getErrorSeverity(): 'error' | 'warning' | 'info' {
    if (!this.state.error) return 'info';

    if (this.isApiError(this.state.error)) {
      return this.state.aidisApiConnected ? 'warning' : 'error';
    }

    return 'error';
  }

  private getErrorTitle(): string {
    const { componentName } = this.props;
    const { error } = this.state;

    if (this.isApiError(error!)) {
      return `${componentName} - API Connection Issue`;
    }

    return `${componentName} - Component Error`;
  }

  private getErrorDescription(): string {
    const { error, aidisApiConnected, retryCount } = this.state;

    if (!error) return '';

    if (this.isApiError(error)) {
      if (aidisApiConnected) {
        return 'Temporary API issue detected. The connection is working but this specific request failed.';
      } else {
        return 'Unable to connect to AIDIS API. Check your connection or try again later.';
      }
    }

    if (retryCount > 0) {
      return `Component error persists after ${retryCount} retry attempts.`;
    }

    return 'An unexpected error occurred in this component.';
  }

  private renderFallbackUI() {
    const { fallbackComponent, enableAutoRetry } = this.props;
    const { error, isRetrying, retryCount, aidisApiConnected, lastErrorTime } = this.state;

    if (fallbackComponent) {
      return fallbackComponent;
    }

    return (
      <Card
        style={{
          margin: '16px 0',
          borderColor: this.getErrorSeverity() === 'error' ? '#ff4d4f' : '#faad14'
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ExclamationCircleOutlined
              style={{
                fontSize: '18px',
                color: this.getErrorSeverity() === 'error' ? '#ff4d4f' : '#faad14'
              }}
            />
            <Title level={4} style={{ margin: 0 }}>
              {this.getErrorTitle()}
            </Title>
          </div>

          <Alert
            type={this.getErrorSeverity()}
            message={this.getErrorDescription()}
            description={
              <Space direction="vertical" style={{ width: '100%' }}>
                {error && (
                  <Text code style={{ fontSize: '12px' }}>
                    {error.message}
                  </Text>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                  <ApiOutlined />
                  <Text type="secondary">
                    AIDIS API: {aidisApiConnected ? '✅ Connected' : '❌ Disconnected'}
                  </Text>
                  {lastErrorTime && (
                    <Text type="secondary">
                      | Error time: {lastErrorTime.toLocaleTimeString()}
                    </Text>
                  )}
                </div>

                {enableAutoRetry && retryCount > 0 && (
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    Auto-retry attempts: {retryCount} / {this.props.maxRetries || 3}
                  </Text>
                )}
              </Space>
            }
            showIcon={false}
          />

          <Space>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={this.handleManualRetry}
              loading={isRetrying}
              disabled={isRetrying}
            >
              {isRetrying ? 'Retrying...' : 'Retry'}
            </Button>

            {this.isApiError(error!) && !aidisApiConnected && (
              <Button
                type="default"
                onClick={() => window.location.reload()}
              >
                Reload Page
              </Button>
            )}
          </Space>

          {isRetrying && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Spin size="small" />
              <Text type="secondary">
                Automatically retrying in {Math.pow(2, retryCount)} seconds...
              </Text>
            </div>
          )}
        </Space>
      </Card>
    );
  }

  render() {
    if (this.state.hasError) {
      return this.renderFallbackUI();
    }

    return this.props.children;
  }
}

export default MandrelApiErrorBoundary;