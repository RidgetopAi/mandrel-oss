export type AidisEntity = 'contexts' | 'tasks' | 'decisions' | 'projects' | 'sessions';

export interface AidisDbEvent {
  entity: AidisEntity;
  action: 'insert' | 'update' | 'delete';
  id: string;
  projectId?: string;
  at: string;
}
