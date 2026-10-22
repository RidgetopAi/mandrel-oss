import React from 'react';
import { Result, Button, Typography, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

interface ErrorFallbackProps {
  title?: string;
  message?: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  supportId?: string;
}

const ErrorFallback: React.FC<ErrorFallbackProps> = ({
  title = 'Something went wrong',
  message = 'The interface hit an unexpected issue.',
  description,
  onRetry,
  supportId,
}) => {
  return (
    <Result
      status="error"
      title={title}
      subTitle={message}
      extra={
        <Space direction="vertical" size="middle">
          {description}
          <Space>
            {onRetry && (
              <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
                Try Again
              </Button>
            )}
            <Button onClick={() => window.location.reload()}>
              Reload Application
            </Button>
          </Space>
          {supportId && (
            <Typography.Text type="secondary">
              Support ID: {supportId}
            </Typography.Text>
          )}
        </Space>
      }
    />
  );
};

export default ErrorFallback;
