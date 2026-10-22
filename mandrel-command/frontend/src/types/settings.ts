/**
 * The user's own settings, as the app holds them in memory.
 *
 * `defaultProjectId` is a UUID, not a project name (epic 41293984 §A). The previous
 * `defaultProject: string` held a NAME, so renaming a project silently broke the saved
 * default — a bug that no amount of checking fixes and that storing the id removes by
 * construction. The display name is derived from the project list at render time; it is
 * never the stored value.
 */
export interface UserSettings {
  /** The user's default project, as a UUID. `undefined` = they have set none. */
  defaultProjectId?: string;
  darkMode?: boolean;
}
