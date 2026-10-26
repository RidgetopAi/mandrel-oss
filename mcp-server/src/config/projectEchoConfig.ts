/**
 * PROJECT-VISIBILITY config.
 *
 * Makes the ACTIVE project visible to MCP clients so work can't silently misfile into
 * the wrong project (the root cause of a real customer incident: a client in Claude Code
 * couldn't SEE which project was active, so writes landed in the default project).
 *
 * TWO surfaces, both configured HERE (the operator's standing rule — NO HARDCODED VARIABLES; a
 * named value + one-line note + env override, never a literal buried in a route):
 *
 *   FIX #1 — the WRITE ECHO. task_create / context_store / decision_record append ONE
 *            concise line naming the RESOLVED target project ("name (id8)"). When the
 *            write went to a project the user did NOT explicitly switch to / name this
 *            session (a DEFAULT), the line carries an extra, more-noticeable hint.
 *   FIX #2 — the connect-time INITIALIZE instructions. A DYNAMIC per-connection string
 *            (the resolved active project name) when the transport can see it, else a
 *            STATIC reminder.
 *
 * The formatters here are PURE (no DB / no handler imports) so they are trivially unit-
 * testable; the resolution of name + defaulted-ness lives in utils/projectEcho.ts.
 * Mirrors the config-driven pattern in taskConfig.ts / recallConfig.ts / autoThreadConfig.ts.
 */

/** Read a boolean env var, falling back to `fallback` on missing/garbage. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

/**
 * Master switch for the write-echo line (FIX #1). Default ON — the whole point is to
 * surface a wrong-project write immediately. env: MANDREL_PROJECT_ECHO_ENABLED
 */
export const PROJECT_ECHO_ENABLED = envBool('MANDREL_PROJECT_ECHO_ENABLED', true);

/**
 * Master switch for the connect-time initialize instructions (FIX #2). Default ON.
 * env: MANDREL_PROJECT_INSTRUCTIONS_ENABLED
 */
export const PROJECT_INSTRUCTIONS_ENABLED = envBool('MANDREL_PROJECT_INSTRUCTIONS_ENABLED', true);

/**
 * How many leading hex chars of the project UUID to show as the short id. 8 matches the
 * id8 convention used everywhere else (task/decision/context short ids). env: MANDREL_PROJECT_ID8_LEN
 */
export const PROJECT_ID8_LEN = (() => {
  const raw = process.env.MANDREL_PROJECT_ID8_LEN;
  const v = raw ? Number(raw) : NaN;
  return Number.isInteger(v) && v > 0 && v <= 36 ? v : 8;
})();

/** Truncate a full project UUID to its id8 (config-driven length). */
export function toId8(projectId: string): string {
  return projectId.substring(0, PROJECT_ID8_LEN);
}

/**
 * FIX #1 — build the ONE-LINE write echo appended to a successful write payload.
 *
 * PURE. Three renderings, one per way the target was chosen:
 *
 *  - BOUND (boundOriginLabel given) → `📁 Project: 'HEx' (8c62f00d) — 🔒 bound by
 *                       x-mandrel-project header`
 *  - manual/explicit → `📁 Project: 'HEx' (8c62f00d)`
 *  - defaulted       → `📁 Project: 'HEx' (8c62f00d) — ⚠️ default project (not switched this
 *                       session); project_switch if this is wrong`
 *
 * BOUND WINS OVER `defaulted`, and the precedence is here rather than at the call site so
 * there is one answer to "what does a bound write say" (
 * no surface may tell a bound client the wrong thing about its own write). A DECLARED
 * binding is the most deliberate target there is — never a "default" — and the defaulted
 * hint points at `project_switch`, which a bound client is REJECTED for calling.
 */
export function formatWriteEcho(
  projectName: string,
  id8: string,
  defaulted: boolean,
  boundOriginLabel?: string
): string {
  // WS1 (D2): plain text — MCP payloads carry no emoji.
  const base = `Project: '${projectName}' (${id8})`;
  if (boundOriginLabel) return `${base} — ${BOUND_PROJECT_HINT} ${boundOriginLabel}`;
  return defaulted ? `${base} — ${DEFAULT_PROJECT_HINT}` : base;
}

/**
 * The extra hint appended when a write lands in a DEFAULT (not-this-session-switched)
 * project. Kept as a named constant so the wording is tunable in one place.
 */
export const DEFAULT_PROJECT_HINT =
  'default project (not switched this session); project_switch if this is wrong';

/**
 * The lead-in for the BOUND rendering; the surface's own label (`x-mandrel-project header`
 * / `MANDREL_PROJECT_ID env var`) is appended, so the client is told not just THAT it is
 * bound but WHERE to change it. Named constant for the same reason as the hint above.
 */
export const BOUND_PROJECT_HINT = 'bound by';

/**
 * FIX #2 — the connect-time initialize instructions.
 *
 * THREE forms, because "use project_switch to change" is FALSE for a bound client — a bound
 * `project_switch` to a different project is REJECTED (ProjectBindingMismatchError). an earlier Task
 * made the first half of that sentence true for a bound client (it is finally told
 * its BOUND project); this finishes the sentence so the second half is true too.
 *
 *  - BOUND (boundOriginLabel given): names the project AND the surface that bound it, and
 *    tells the client to change the BINDING rather than to call a tool that will fail.
 *  - DYNAMIC (projectName only): byte-identical to before — the human/unbound path.
 *  - STATIC (neither): a project-agnostic reminder. It still has to be true for a bound
 *    client, because the stdio Server emits STATIC unconditionally and a stdio client binds
 *    itself with the MANDREL_PROJECT_ID env var — so it carries the same caveat, in brief.
 *
 * All three are pure string builders.
 */
export function formatInstructions(
  projectName?: string | null,
  boundOriginLabel?: string
): string {
  if (projectName && projectName.trim() !== '') {
    if (boundOriginLabel) {
      return (
        `Active Mandrel project: ${projectName} (BOUND by ${boundOriginLabel}). ` +
        `Mandrel scopes all writes (tasks, contexts, decisions) to this ACTIVE project. ` +
        `This connection is bound: project_switch to a different project is REJECTED — ` +
        `change the binding in your client config to work in another project.`
      );
    }
    return (
      `Active Mandrel project: ${projectName}. ` +
      `Mandrel scopes all writes (tasks, contexts, decisions) to this ACTIVE project. ` +
      `Confirm it's correct before creating tasks/contexts/decisions; use project_switch to change.`
    );
  }
  return (
    `Mandrel scopes all writes to your ACTIVE project. ` +
    `On session start, confirm your active project (project_current) and project_switch if a ` +
    `different project was intended, before creating tasks/contexts/decisions ` +
    `(${BOUND_CLIENT_CAVEAT}).`
  );
}

/**
 * The STATIC form's bound-client caveat. A bound client cannot project_switch, so the static
 * reminder would otherwise send it at a call that hard-fails. Named + tunable in one place;
 * the binding surfaces it names come from projectBindingConfig's own constants at the call
 * site of that config, so the wording here stays deliberately generic.
 */
export const BOUND_CLIENT_CAVEAT =
  'if your client declares a project binding, project_switch is rejected — change the binding instead';
