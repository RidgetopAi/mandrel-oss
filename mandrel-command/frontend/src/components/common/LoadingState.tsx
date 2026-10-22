import React from 'react';
import { Spin, Typography } from 'antd';

interface LoadingStateProps {
  message?: string;
  fullscreen?: boolean;
}

const LoadingState: React.FC<LoadingStateProps> = ({ message = 'Loading Mandrel…', fullscreen }) => {
  const content = (
    <div style={{ textAlign: 'center', padding: '2rem' }}>
      <Spin size="large" />
      <Typography.Paragraph type="secondary" style={{ marginTop: '1rem' }}>
        {message}
      </Typography.Paragraph>
    </div>
  );

  if (!fullscreen) {
    return content;
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {content}
    </div>
  );
};

export default LoadingState;
