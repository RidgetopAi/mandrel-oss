/**
 * TR003-6: Validated Project Form Component
 * Enhanced project form with real-time validation and contract enforcement
 */

import React, { useEffect } from 'react';
import { Form, Input, Button, Modal, Alert, Space, Typography } from 'antd';
import { ExclamationCircleOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useValidatedForm } from '../../hooks/useValidatedForm';
import { CreateProjectSchema, type CreateProjectData } from '../../validation/schemas';
import MandrelApiErrorBoundary from '../error/MandrelApiErrorBoundary';
import { ProjectEntity } from '../../api/generated';
import { logger } from '../../utils/logger';

const { TextArea } = Input;
const { Text } = Typography;

interface ValidatedProjectFormProps {
  visible: boolean;
  project?: ProjectEntity;
  onSubmit: (data: CreateProjectData) => Promise<void>;
  onCancel: () => void;
  loading?: boolean;
}

const ValidatedProjectForm: React.FC<ValidatedProjectFormProps> = ({
  visible,
  project,
  onSubmit,
  onCancel,
  loading = false
}) => {
  const isEditing = !!project;

  // TR003-6: Use validated form hook with real-time validation
  const { form, formState, formActions, errorHandler } = useValidatedForm({
    schema: CreateProjectSchema,
    componentName: 'ProjectForm',
    enableRealTimeValidation: true,
    debounceMs: 300,
    validateOnChange: true,
    validateOnBlur: true,
    enableServerValidation: true,
    onSubmitSuccess: async (data) => {
      try {
        await onSubmit(data);
        formActions.resetForm();
      } catch (error) {
        // Error will be handled by the error boundary
      }
    },
    onSubmitError: (error) => {
      logger.error('Project form submission error:', error);
    },
    onValidationError: (errors) => {
      logger.log('Validation errors:', errors);
    },
  });

  // Initialize form when modal opens
  useEffect(() => {
    if (visible) {
      if (project) {
        // Pre-fill form with existing project data
        const projectData = {
          name: project.name,
          description: project.description || '',
          git_repo_url: project.git_repo_url || '',
          root_directory: project.root_directory || '',
        };
        formActions.setFieldsValue(projectData);
      } else {
        // Reset form for new project with defaults
        formActions.resetForm();
      }
    }
  }, [visible, project, isEditing, formActions]);

  const handleSubmit = async () => {
    const result = await formActions.submitForm();
    if (result) {
      // Form submission was successful, modal will be closed by parent
    }
  };

  const handleCancel = () => {
    formActions.resetForm();
    onCancel();
  };

  // Get validation status for a field
  const getFieldStatus = (fieldName: keyof CreateProjectData): 'error' | 'validating' | 'success' | '' => {
    if (formState.isValidating) return 'validating';
    if (formState.errors[fieldName] || formState.serverErrors[fieldName]) return 'error';
    if (formState.hasBeenModified && formState.data[fieldName]) return 'success';
    return '';
  };

  // Get field error message
  const getFieldError = (fieldName: keyof CreateProjectData): string => {
    return formState.errors[fieldName] || formState.serverErrors[fieldName] || '';
  };

  return (
    <MandrelApiErrorBoundary
      componentName="ValidatedProjectForm"
      enableAutoRetry={false}
    >
      <Modal
        title={
          <Space>
            {isEditing ? 'Edit Project' : 'Create New Project'}
            {formState.hasBeenModified && (
              <Text type="secondary" style={{ fontSize: '12px' }}>
                (Modified)
              </Text>
            )}
          </Space>
        }
        open={visible}
        onCancel={handleCancel}
        footer={[
          <Button key="cancel" onClick={handleCancel} disabled={formState.isSubmitting}>
            Cancel
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={formState.isSubmitting || loading}
            onClick={handleSubmit}
            disabled={!formState.isValid && formState.hasBeenModified}
          >
            {isEditing ? 'Update' : 'Create'}
          </Button>
        ]}
        destroyOnClose
        width={600}
      >
        {/* Error Handler State Display */}
        {errorHandler.hasError && (
          <Alert
            type="error"
            message="Form Error"
            description={errorHandler.getErrorMessage()}
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={errorHandler.clearError}>
                Dismiss
              </Button>
            }
            closable
          />
        )}

        {/* Server Validation Errors */}
        {Object.keys(formState.serverErrors).length > 0 && (
          <Alert
            type="warning"
            message="Server Validation Issues"
            description={
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {Object.entries(formState.serverErrors).map(([field, error]) => (
                  <li key={field}>{field}: {error}</li>
                ))}
              </ul>
            }
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={formActions.clearServerErrors}>
                Dismiss
              </Button>
            }
            closable
          />
        )}

        <Form
          form={form[0]}
          layout="vertical"
          name="validatedProjectForm"
        >
          <Form.Item
            label="Project Name"
            validateStatus={getFieldStatus('name')}
            help={getFieldError('name')}
            hasFeedback
          >
            <Input
              placeholder="Enter project name"
              value={formState.data.name || ''}
              onChange={(e) => formActions.setFieldValue('name', e.target.value)}
              onBlur={() => formActions.validateField('name')}
            />
          </Form.Item>

          <Form.Item
            label="Description"
            validateStatus={getFieldStatus('description')}
            help={getFieldError('description')}
          >
            <TextArea
              placeholder="Enter project description (optional)"
              rows={3}
              value={formState.data.description || ''}
              onChange={(e) => formActions.setFieldValue('description', e.target.value)}
              onBlur={() => formActions.validateField('description')}
            />
          </Form.Item>


          <Form.Item
            label="Git Repository URL"
            validateStatus={getFieldStatus('git_repo_url')}
            help={getFieldError('git_repo_url')}
          >
            <Input
              placeholder="https://github.com/username/repo.git (optional)"
              value={formState.data.git_repo_url || ''}
              onChange={(e) => formActions.setFieldValue('git_repo_url', e.target.value)}
              onBlur={() => formActions.validateField('git_repo_url')}
            />
          </Form.Item>

          <Form.Item
            label="Root Directory"
            validateStatus={getFieldStatus('root_directory')}
            help={getFieldError('root_directory')}
          >
            <Input
              placeholder="/path/to/project/root (optional)"
              value={formState.data.root_directory || ''}
              onChange={(e) => formActions.setFieldValue('root_directory', e.target.value)}
              onBlur={() => formActions.validateField('root_directory')}
            />
          </Form.Item>
        </Form>

        {/* Validation Status Footer */}
        <div style={{
          borderTop: '1px solid #f0f0f0',
          paddingTop: 12,
          marginTop: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <Space>
            {formState.isValidating && (
              <Text type="secondary">
                <ExclamationCircleOutlined spin /> Validating...
              </Text>
            )}
            {formState.isValid && formState.hasBeenModified && !formState.isValidating && (
              <Text type="success">
                <CheckCircleOutlined /> Form is valid
              </Text>
            )}
            {!formState.isValid && formState.hasBeenModified && !formState.isValidating && (
              <Text type="danger">
                <ExclamationCircleOutlined /> Please fix validation errors
              </Text>
            )}
          </Space>

          <Text type="secondary" style={{ fontSize: '12px' }}>
            TR003-6: Real-time validation active
          </Text>
        </div>
      </Modal>
    </MandrelApiErrorBoundary>
  );
};

export default ValidatedProjectForm;