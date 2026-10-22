/**
 * The project a write lands in when the database holds no user-created project.
 *
 * Single source for the name auto-created by session project resolution
 * (services/session/domain/lifecycle/projectResolution.ts, ladder step 4) and the name
 * `project_current` reports on an empty database, so the two cannot drift.
 */
export const DEFAULT_PERSONAL_PROJECT_NAME = 'Personal Project';
