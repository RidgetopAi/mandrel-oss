import React from 'react';
import { useLocation } from 'react-router-dom';
import { Alert } from 'antd';
import ErrorBoundary from './ErrorBoundary';
import ErrorFallback from './ErrorFallback';

interface SectionErrorBoundaryProps {
  children: React.ReactNode;
  section: string;
}

const SectionErrorBoundary: React.FC<SectionErrorBoundaryProps> = ({ children, section }) => {
  const location = useLocation();

  return (
    <ErrorBoundary
      key={`${section}-${location.pathname}`}
      reportContext={{ severity: 'medium', section }}
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ErrorFallback
          title={`${section} temporarily unavailable`}
          message="We ran into a problem while loading this section."
          description={
            <Alert
              type="warning"
              showIcon
              message={error.message || 'An unexpected section error occurred.'}
              description="Try again or reload the page. If the problem persists, contact support."
            />
          }
          onRetry={resetErrorBoundary}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
};

export default SectionErrorBoundary;
