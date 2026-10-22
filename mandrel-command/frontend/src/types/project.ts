import type { ProjectEntity, ProjectStats as GeneratedProjectStats } from '../api/generated';

export type Project = ProjectEntity;
export type ProjectStats = GeneratedProjectStats;

export interface ProjectInsights {
  insights: string;
  generatedAt: string;
  projectId: string;
}
