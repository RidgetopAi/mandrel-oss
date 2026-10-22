// useSettings is now backed by a shared SettingsContext so that the default
// project is a single source of truth across the app (Settings page +
// ProjectContext) and is seeded from the backend's primary project on auth.
// This file is kept as a thin re-export to avoid churning existing imports.
export { useSettings, useSettings as default } from '../contexts/SettingsContext';
