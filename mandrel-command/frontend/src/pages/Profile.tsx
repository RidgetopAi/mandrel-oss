import React from 'react';
import { Typography, Card, Space, Avatar, Descriptions, Tag, Button, Divider } from 'antd';
import {
  UserOutlined,
  MailOutlined,
  SafetyCertificateOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { formatDateTime } from '../utils/datetime';

const { Title, Text } = Typography;

const Profile: React.FC = () => {
  const { user } = useAuthContext();
  const { themeMode } = useTheme();
  const navigate = useNavigate();

  // Generate initials for avatar
  const getInitials = (username: string | undefined) => {
    if (!username) return 'U';
    return username.slice(0, 2).toUpperCase();
  };

  // Absolute timestamps in the viewer's own zone AND locale. This used to pin `'en-US'`,
  // which rendered 13/07/2026 as "July 13, 2026" for a reader who writes neither
  //. The shared formatter passes `undefined` to Intl, which means "the
  // runtime's locale" — i.e. the browser's.
  const formatDate = (dateString: string | undefined | null) =>
    dateString ? formatDateTime(dateString) : 'N/A';

  // Get role color
  const getRoleColor = (role: string | undefined) => {
    switch (role) {
      case 'admin':
        return 'gold';
      case 'user':
        return 'blue';
      default:
        return 'default';
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* Page Header */}
      <div>
        <Title level={2}>Profile</Title>
        <Text type="secondary">
          View your account information
        </Text>
      </div>

      {/* Profile Card */}
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Avatar and Basic Info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <Avatar
              size={96}
              style={{
                backgroundColor: themeMode === 'dark' ? '#1890ff' : '#1890ff',
                fontSize: 36,
                fontWeight: 600,
              }}
            >
              {getInitials(user?.username)}
            </Avatar>
            <div>
              <Title level={3} style={{ margin: 0 }}>
                {user?.username || 'User'}
              </Title>
              <Space style={{ marginTop: 8 }}>
                <Tag color={getRoleColor(user?.role)} icon={<SafetyCertificateOutlined />}>
                  {user?.role?.toUpperCase() || 'USER'}
                </Tag>
                {user?.is_active !== false && (
                  <Tag color="green">Active</Tag>
                )}
              </Space>
            </div>
          </div>

          <Divider style={{ margin: '16px 0' }} />

          {/* Detailed Information */}
          <Descriptions
            column={{ xs: 1, sm: 2 }}
            labelStyle={{ fontWeight: 500 }}
          >
            <Descriptions.Item
              label={<><UserOutlined style={{ marginRight: 8 }} />Username</>}
            >
              {user?.username || 'N/A'}
            </Descriptions.Item>
            <Descriptions.Item
              label={<><MailOutlined style={{ marginRight: 8 }} />Email</>}
            >
              {user?.email || 'N/A'}
            </Descriptions.Item>
            <Descriptions.Item
              label={<><SafetyCertificateOutlined style={{ marginRight: 8 }} />Role</>}
            >
              {user?.role || 'N/A'}
            </Descriptions.Item>
            <Descriptions.Item
              label={<><CalendarOutlined style={{ marginRight: 8 }} />Member Since</>}
            >
              {formatDate(user?.created_at)}
            </Descriptions.Item>
            <Descriptions.Item
              label={<><ClockCircleOutlined style={{ marginRight: 8 }} />Last Login</>}
            >
              {formatDate(user?.last_login)}
            </Descriptions.Item>
          </Descriptions>

          <Divider style={{ margin: '16px 0' }} />

          {/* Actions */}
          <Space>
            <Button
              type="primary"
              icon={<SettingOutlined />}
              onClick={() => navigate('/settings')}
            >
              Edit Profile
            </Button>
          </Space>
        </Space>
      </Card>
    </Space>
  );
};

export default Profile;
