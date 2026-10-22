import React, { useState } from 'react';
import { Typography, Card, Form, Input, Button, Space, message } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '../contexts/AuthContext';
import { logger } from '../utils/logger';

const { Title, Text } = Typography;

/**
 * Forced first-login password change.
 *
 * Rendered (via ProtectedRoute) for any authenticated user whose profile reports
 * must_change_password === true. The rest of the app is blocked until the change
 * succeeds. Reuses the existing /users/change-password endpoint and the same
 * password-strength rules as Settings; the backend clears the flag on success.
 * After a successful change we invalidate the cached profile so the gate re-reads
 * the now-false flag and normal access resumes.
 */
const ForcePasswordChange: React.FC = () => {
  const { user, logout } = useAuthContext();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [isSaving, setIsSaving] = useState(false);

  const apiBaseUrl = import.meta.env.VITE_API_URL || '/api';
  const token = localStorage.getItem('aidis_token') || '';

  const handleSubmit = async (values: any) => {
    setIsSaving(true);
    try {
      const { currentPassword, newPassword, confirmPassword } = values;

      if (newPassword !== confirmPassword) {
        message.error('New passwords do not match');
        setIsSaving(false);
        return;
      }

      if (newPassword === currentPassword) {
        message.error('New password must be different from your current password');
        setIsSaving(false);
        return;
      }

      const response = await fetch(`${apiBaseUrl}/users/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        message.success('Password updated. Welcome!');
        form.resetFields();
        // Force the profile (and its must_change_password flag) to be refetched so
        // ProtectedRoute stops gating and lets the user into the app.
        await queryClient.invalidateQueries({ queryKey: ['auth', 'profile'] });
      } else {
        if (data.details && Array.isArray(data.details) && data.details.length > 0) {
          message.error(`Password requirements not met: ${data.details.join('; ')}`, 6);
        } else {
          message.error(data.message || 'Failed to change password');
        }
      }
    } catch (error) {
      logger.error('Forced password change failed:', error);
      message.error('Failed to change password. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 460 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <LockOutlined style={{ fontSize: 32 }} />
            <Title level={3} style={{ marginTop: 12, marginBottom: 4 }}>
              Set a New Password
            </Title>
            <Text type="secondary">
              {user?.username ? `Welcome, ${user.username}. ` : ''}
              For security, you must change your temporary password before continuing.
            </Text>
          </div>

          <Text type="secondary">
            Password must contain:
            <ul style={{ marginTop: 8, marginBottom: 0 }}>
              <li>At least 8 characters</li>
              <li>One uppercase letter (A-Z)</li>
              <li>One lowercase letter (a-z)</li>
              <li>One number (0-9)</li>
              <li>One special character (!@#$%^&amp;*...)</li>
            </ul>
          </Text>

          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Form.Item
              label="Current (temporary) Password"
              name="currentPassword"
              rules={[{ required: true, message: 'Please enter your current password' }]}
            >
              <Input.Password placeholder="Enter current password" autoFocus />
            </Form.Item>

            <Form.Item
              label="New Password"
              name="newPassword"
              rules={[
                { required: true, message: 'Please enter a new password' },
                { min: 8, message: 'Password must be at least 8 characters' },
              ]}
            >
              <Input.Password placeholder="Enter new password" />
            </Form.Item>

            <Form.Item
              label="Confirm New Password"
              name="confirmPassword"
              rules={[{ required: true, message: 'Please confirm your new password' }]}
            >
              <Input.Password placeholder="Confirm new password" />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <Space>
                <Button type="primary" htmlType="submit" loading={isSaving}>
                  Update Password
                </Button>
                <Button onClick={() => logout()} disabled={isSaving}>
                  Log out
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  );
};

export default ForcePasswordChange;
