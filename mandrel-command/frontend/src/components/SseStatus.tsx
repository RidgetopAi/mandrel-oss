import React from 'react';
import { Badge } from 'antd';
import { useSseContext } from '../contexts/SseContext';

export const SseStatus: React.FC = () => {
  const { isConnected, isSupported } = useSseContext();

  if (!isSupported) {
    return <Badge status="warning" text="Polling mode" />;
  }

  return isConnected 
    ? <Badge status="success" text="Live" />
    : <Badge status="error" text="Disconnected" />;
};
