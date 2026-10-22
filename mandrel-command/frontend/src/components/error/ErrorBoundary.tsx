import React from 'react';
import type { ErrorInfo } from 'react';
import { reportError, type ErrorReportContext } from '../../services/errorReporter';
import { logger } from '../../utils/logger';

export interface FallbackRenderProps {
  error: Error;
  resetErrorBoundary: () => void;
}

export type FallbackRender = (props: FallbackRenderProps) => React.ReactNode;

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  fallbackRender?: FallbackRender;
  onReset?: () => void;
  reportContext?: ErrorReportContext;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  async componentDidCatch(error: Error, info: ErrorInfo): Promise<void> {
    await reportError(error, info, this.props.reportContext);
  }

  private readonly resetErrorBoundary = (): void => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      try {
        this.props.onReset();
      } catch (resetError) {
        // eslint-disable-next-line no-console
        logger.warn('Error boundary reset handler failed', resetError);
      }
    }
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback, fallbackRender } = this.props;

    if (!hasError) {
      return children;
    }

    if (fallbackRender && error) {
      return fallbackRender({ error, resetErrorBoundary: this.resetErrorBoundary });
    }

    if (fallback) {
      return fallback;
    }

    return null;
  }
}

export default ErrorBoundary;
