## Agent Configuration & Project Guide

---

## IMMEDIATE ESSENTIALS

### System Status

**Mandrel exposes TWO tool surfaces. Which one you see depends on how you connect.**

- **Gateway surface** — `discover` plus action-discriminated gateways (`context`, `task`,
  `decision`, `project`, `session`, `graph`) and the flat specials
  (`recall_thread`, `smart_search`, `get_recommendations`). This is the default
  `tools/list` on the MCP streamable endpoint (`POST /mcp`). You call it as
  `context({action: 'store', ...})`.
- **Flat surface** — the original one-endpoint-per-tool API at `/mcp/tools/{tool}`. Still
  fully live; the curl examples below use it.

**Never hand-copy a tool COUNT into a document.** It drifts every time a tool ships, and a
stale count reads as authoritative. `src/config/opRegistry.ts` is the single source and the
catalog is derived from it live. Ask the running server instead:

- gateway → `discover({action: 'catalog'})` (returns `totalActions`)
- flat → `mandrel_help` (returns the count and the per-category breakdown)

### Navigation Tools - START HERE

Three tools discover everything else. Use them before writing a call, not after it fails.

| Gateway surface | Flat surface | What it gives you |
|---|---|---|
| `discover({action:'catalog'})` | `mandrel_help` | Every tool/action, by category |
| `discover({action:'explain', tool, op})` | `mandrel_explain <tool>` | The full contract + exact param names |
| `discover({action:'examples', tool})` | `mandrel_examples <tool>` | Worked usage patterns |
| `discover({action:'contract'})` | `mandrel_contract` | What to RECORD, when, and how to say how you know |

Params are validated strictly — an undeclared param is REJECTED — so read `explain` rather
than guessing a signature from another surface.

### HTTP Bridge Connection

The flat per-tool API is served over HTTP on the MCP server's port (8080 by default).

- **Endpoint**: `POST http://<host>:8080/mcp/tools/{toolName}`
- **Body**: the tool's params WRAPPED in `arguments` — `{"arguments": {...}}`. An unwrapped
  body fails validation with a confusing "required" error.
- **⚠️ AUTH IS REQUIRED AND FAILS CLOSED.** `/mcp/tools/*` is mounted behind the bearer
  guard (`src/middleware/bearerAuth.ts`), so every call needs
  `Authorization: Bearer <MCP_AUTH_TOKEN>` — including from localhost. If `MCP_AUTH_TOKEN`
  is unset the guard rejects everything rather than opening the door.
- **A WRITE additionally needs `X-Actor-ID`** when the server runs with
  `MANDREL_SESSION_REQUIRE_ACTOR=true` (the production default). Reads do not. The value
  just identifies the writer (`coordinator`, `builder`); it is not a secret.
- **Say which PROJECT you mean.** Pass `projectId` on the call, or bind the client with
  `X-Mandrel-Project: <project>`. A caller that names neither shares one ambient
  last-writer-wins slot with every other unidentified caller, and an unidentified write is
  rejected outright.

**Quick test** (source the token; never inline it into a script or a transcript):

```bash
TOKEN=$(grep ^MCP_AUTH_TOKEN /path/to/secrets.env | cut -d= -f2-)

curl -s -X POST http://localhost:8080/mcp/tools/mandrel_ping \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {}}'

# A WRITE: the actor header and an explicit project.
curl -s -X POST http://localhost:8080/mcp/tools/context_store \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Actor-ID: my-agent" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"content": "...", "type": "completion", "projectId": "my-project"}}'
```

### Session Startup Workflow

1. `project_current` - confirm which project your writes will land in; `project_switch` if
   it is the wrong one (or set the client's project binding, which cannot be moved).
2. `discover({action:'catalog'})` / `mandrel_help` - see what this server actually exposes.
3. `discover({action:'explain', ...})` / `mandrel_explain <tool>` - read the contract of the
   tools you are about to call.
4. `mandrel_ping` - only if something looks wrong; it is a connectivity check, not a ritual.

### Current Architecture

- **Backend**: Node.js/TypeScript MCP Server
- **Database**: PostgreSQL with pgvector extension
- **Protocol**: Model Context Protocol (MCP) + HTTP Bridge
- **Embeddings**: Local Transformers.js (zero cost)
- **Access**: Dual protocol support (MCP STDIO + HTTP)

---

## ESSENTIAL REFERENCE

### Project Management

- **Switch projects**: `project_switch <name>`
- **Current project**: `project_current`
- **List projects**: `project_list`

### Session Management

Sessions auto-manage via the SessionTracker service — you do not have to open one. There
ARE session tools for reading and pinning attribution (`session_status`, `session_list`,
`session_get`, `session_pin`, `session_start`, `session_end`); read their contracts with
`explain` rather than from this list.

**REST API (8 endpoints - for Mandrel Command UI):**

- `POST /api/v2/sessions/:id/activities` - Record session activity
- `GET /api/v2/sessions/:id/activities` - Get activity timeline
- `POST /api/v2/sessions/:id/files` - Record file modifications
- `GET /api/v2/sessions/:id/files` - Get modified files
- `POST /api/v2/sessions/:id/productivity` - Calculate productivity score
- `GET /api/v2/sessions` - List sessions (with filters/pagination)
- `GET /api/v2/sessions/stats` - Aggregate statistics
- `GET /api/v2/sessions/compare` - Compare two sessions

**Automation:** Session activities are auto-tracked when you use context_store, task_create or decision_record.

### Context Management

- **Store context**: `context_store(content, type, tags?)`
  - **Valid types** (the enum in `src/middleware/validation.ts` — anything else is
    rejected): code, decision, error, discussion, planning, completion, milestone,
    reflections, handoff, lessons, note
  - Use `note` for a generic capture that fits no other type. There is no `fact` type
    and it is deliberately not aliased — a `fact` store is rejected with a hint naming `note`
  - Use `completion` for finished features/fixes
  - Use `milestone` for major achievements
  - Use `handoff` for the session resume point. A handoff is TRUNK material by type: it is
    never filed as a member of whatever branch happened to be open when you wrote it.
- **Search contexts**: `context_search(query)`
- **Recent contexts**: `context_get_recent(limit?)`
- **Say how you know**: put an author-declared status in `metadata.capture` —
  `{"status": "verified", "evidence": "<command> -> <its output>"}`, or `"believed"`
  (reasoned, not measured) or `"refuted"` (measured, and false). Omit the block entirely to
  say nothing; *absent* is its own state and writing it as a value is rejected, as is a
  `verified` with no evidence. Do not copy the vocabulary into your own instructions — ask
  for it: `discover({action:'contract'})` / `mandrel_contract`. Background:
  `docs/guides/agent-capture-contract.md`.

### The tool inventory is NOT written here

It used to be. A hand-copied list of ~36 tool names sat here on a page whose own header
says never hand-copy a tool COUNT — and it had already drifted, omitting 32 of the 68
registered ops (measured, the reviewer). Deleted rather than extended: the
registry is the catalog, and a second copy of it can only ever be a slower way to be wrong.

Ask the running server: `discover({action:'catalog'})` on the gateway surface, or
`mandrel_help` on the flat one. For one op's exact contract, `discover({action:'explain'})`.

---

## **THE FOREVER WORKFLOW - NEVER DEVIATE**

### **Core Principles (ABSOLUTE)**

1. **Systematic Investigation First** - Deploy investigation subagent, find root causes
2. **No Guessing or Assumptions** - Evidence-based analysis with code locations
3. **Review Findings Together** - Partner validates investigation before implementation
4. **Surgical Implementation** - Deploy implementation subagent with specific requirements
5. **Production Quality** - TypeScript, build validation, comprehensive testing

### **Partnership Protocol (MANDATORY)**

- **Tone**: Professional, systematic, no rushing whatsoever
- **Rigid Focus**: One issue at a time, complete resolution before moving on
- **No Cutting Corners**: Full investigation → evidence → review → targeted fix
- **Mandrel Task Tracking**: Create tasks, update status, track systematically
- **Context Storage**: Store learning contexts and handoffs for continuity

### **Investigation Standards (NEVER COMPROMISE)**

- **Trace complete code paths** - from user action to root cause
- **Find exact file locations and line numbers** - specific evidence required
- **Identify precise timing/logic issues** - understand WHY it's failing
- **Provide actionable solutions** - clear path to implementation
- **No shortcuts** - thorough analysis every single time

### **Implementation Quality (PRODUCTION READY)**

- **TypeScript compilation passes** - no type errors tolerated
- **Build validation successful** - production-ready code only
- **Backward compatibility maintained** - never break existing functionality
- **Performance optimized** - React best practices, efficient patterns
- **Clean, maintainable code** - proper patterns, clear documentation

---

## TECHNICAL REFERENCE

### Database Configuration

- **Database**: mandrel
- **Port**: 5432
- **Default User**: mandrel (configurable via `DATABASE_USER` or `MANDREL_DATABASE_USER`)
- **Connection**: `postgresql://localhost:5432/mandrel`
- **Test**: `psql -d mandrel -c "SELECT current_database();"`

### Environment Variable Priority

All config supports a fallback chain:
1. `MANDREL_*` (preferred)
2. `AIDIS_*` (deprecated, shows warning)
3. Legacy names (e.g., `DATABASE_*`)

### Development Commands

Run these from `mcp-server/`:

```bash
npm install                    # Install dependencies
npm run dev                    # Start the MCP server (tsx watch src/main.ts)
npm run build                  # tsc -> dist/
npm run lint                   # ESLint check
npm run type-check             # TypeScript check (tsc -p tsconfig.typecheck.json)
npm test                       # vitest (needs a migrated test DB — see below)
npm run db:migrate             # Apply database/migrations against DATABASE_*
```

### The gate

`bash scripts/oss-gate.sh` is the single gate, locally and in `.github/workflows/ci.yml`.
Its exit code is the verdict (0 GREEN, 1 RED, 2 COULD-NOT-MEASURE). Every stage runs with
an empty inherited environment, and every `scripts/test/*.test.sh` must pass with a
throwaway `HOME` — a test may not depend on the invoking user's environment.

### Test database — ONE command for a CORRECT throwaway DB

> **Footgun (read this before you `createdb` for tests):** a throwaway Postgres is
> only correct if it has the required extensions. Tests use `similarity()` (pg_trgm)
> and uuid functions (uuid-ossp); a plain `createdb` + `migrate.ts` **skips the
> extensions** and those tests fail with confusing "function does not exist" errors.
> Do NOT hand-roll provisioning — use the helper, which does the FULL correct
> sequence (create role/db → run `00-extensions.sql` → `migrate.ts`), idempotently:

```bash
# Provision a correct, migrated throwaway DB (name MUST be ci_*-prefixed):
bash scripts/provision-test-db.sh ci_mytest_$$

# Point your tests at it (the helper prints the DB env on success):
eval "$(bash scripts/provision-test-db.sh ci_mytest_$$ --print-env)"
#   exports DATABASE_NAME / DATABASE_USER / DATABASE_PASSWORD / DATABASE_HOST / DATABASE_PORT
#   The emitted password is DETERMINISTIC per dbname (set TEST_DB_PASS to pin one) and
#   --print-env ENSURES the role exists + matches it, so the printed creds ALWAYS
#   authenticate — even on a re-run / a second call. (--print-env does NOT migrate;
#   it only guarantees authenticating creds + extensions. Run the bare command above
#   first, or pass the same name without --print-env, if you need the schema migrated.)

# Tear it down (drops the ci_* DB + its derived ci_role_* role):
bash scripts/drop-test-db.sh ci_mytest_$$
#   (equivalent: scripts/provision-test-db.sh ci_mytest_$$ --drop)
```

- Database-backed suites use this same helper — single source, so CI and ad-hoc DBs
  can't drift. Host/port/super-user are env-configurable (`TEST_DB_HOST`,
  `TEST_DB_PORT`, `PG_SUPERCMD`) with sane defaults (`localhost:5432`,
  `sudo -u postgres`).
- The helper REFUSES any name that isn't `ci_*`-prefixed — it can never touch
  `mandrel` or a real DB.

### Process Management Scripts

```bash
./start-mandrel.sh              # Start server
./stop-mandrel.sh               # Stop server
./restart-mandrel.sh            # Restart server
./status-mandrel.sh             # Check status
```

### Key Tool Parameters

```typescript
// Navigation (NEW!)
mandrel_help()
mandrel_explain(toolName: string)
mandrel_examples(toolName: string)

// System Health
mandrel_ping(message?: string)
mandrel_status()

// Context Management
context_store(content: string, type: string, tags?: string[])
context_search(query: string, limit?: number, type?: string)
context_get_recent(limit?: number, projectId?: string)

// Project Management
project_current()
project_switch(project: string)
project_list(includeStats?: boolean)

// Essential Parameters Only - Use mandrel_explain for complete reference
```

### Reference Guides

- **Comprehensive MCP Guide**: `docs/guides/MANDREL_MCP_SERVER_REFERENCE_GUIDE.md`
- **Tool Parameters**: Use `mandrel_explain <toolname>` for current info
- **Examples**: Use `mandrel_examples <toolname>` for usage patterns

### Common Mandrel Parameter Patterns

- **Arrays**: Pass as actual arrays, not strings: `["tag1", "tag2"]`
- **Always check examples first**: Use `mandrel_examples <tool>` before implementation
- **Required vs optional**: Use `mandrel_explain <tool>` to see what's actually required

### Mandrel Tool Troubleshooting

- **Validation errors**: Usually mean wrong parameter type or format
- **When in doubt**: Check examples first, explain second, implement third
- **Array parameters**: Must be actual JSON arrays, not quoted strings

---

**Last Updated**: 2026-08-21
**Tools**: TWO surfaces (gateway + flat per-tool). Ask the server for the count —
`discover({action:'catalog'})` or `mandrel_help`. Never hand-copy it into a doc.
**REST API**: 8 session analytics endpoints at /api/v2/sessions/* (for Mandrel Command UI)
**Auth**: `/mcp/tools/*` is bearer-guarded and FAILS CLOSED; writes also need `X-Actor-ID`.
