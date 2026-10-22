import React from 'react';
import { Alert } from 'antd';
import ErrorBoundary from './ErrorBoundary';
import ErrorFallback from './ErrorFallback';

interface GlobalErrorBoundaryProps {
  children: React.ReactNode;
}

const GlobalErrorBoundary: React.FC<GlobalErrorBoundaryProps> = ({ children }) => (
  <ErrorBoundary
    reportContext={{ severity: 'high', section: 'global-app' }}
    fallbackRender={({ error, resetErrorBoundary }) => (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: 520, width: '100%' }}>
          <ErrorFallback
            title="Mandrel Command encountered a problem"
            message="The interface hit an unexpected error."
            description={
              <Alert
                type="error"
                showIcon
                message={error.message || 'An unexpected UI error occurred.'}
                description="Our team has been notified. You can reload or try again."
              />
            }
            onRetry={resetErrorBoundary}
          />
        </div>
      </div>
    )}
  >
    {children}
  </ErrorBoundary>
);

export default GlobalErrorBoundary;
