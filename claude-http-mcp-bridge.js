#!/usr/bin/env node

/**
 * Claude Code HTTP-MCP Bridge
 *
 * Translates Claude Code's MCP stdio calls to Mandrel HTTP endpoints
 * Uses the working HTTP bridge at localhost:8080/mcp/tools/*
 *
 * Token-Optimized: 27 active Mandrel tools (70% token reduction from original 52)
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');

// Resolve base URL for Mandrel HTTP service
const BASE_URL = process.env.MANDREL_HTTP_URL || process.env.AIDIS_HTTP_URL || process.env.AIDIS_URL || 'http://localhost:8080';

// Generate unique connection ID for this bridge instance (session isolation)
const CONNECTION_ID = `bridge-${process.pid}-${Date.now().toString(36)}`;

// Sessions Foundation Phase 1 (ADDITIVE, BACKWARD-COMPATIBLE): declare this client's ACTOR
// (the human/agent principal that owns the session) via the X-Actor-ID header, sourced ONLY
// from the MANDREL_ACTOR env var. If MANDREL_ACTOR is UNSET the header is NOT sent and the
// bridge behaves EXACTLY as before (server stamps the flagged `anonymous` actor). On the
// single-tenant container the actor is ATTRIBUTION, not an authz boundary. The coordinator applies the
// live cutover deliberately (set MANDREL_ACTOR in the bridge launcher env) — this code change
// alone changes nothing until that env is set.
const ACTOR_ID = process.env.MANDREL_ACTOR && process.env.MANDREL_ACTOR.trim() !== ''
  ? process.env.MANDREL_ACTOR.trim()
  : undefined;

// PROJECT BINDING (Amp-orb eval finding W5 — client half). An
// AUTONOMOUS client declares WHICH PROJECT it is scoped to, as configuration, so it never
// auto-selects one: set MANDREL_PROJECT_ID (a project id OR name) in this bridge's launcher
// env and every call carries X-Mandrel-Project. The server then pins writes to that project
// and REFUSES (typed error naming both) any call that explicitly names a different one.
// ADDITIVE + INERT: unset → the header is not sent and the bridge behaves exactly as before.
const PROJECT_BINDING = process.env.MANDREL_PROJECT_ID && process.env.MANDREL_PROJECT_ID.trim() !== ''
  ? process.env.MANDREL_PROJECT_ID.trim()
  : undefined;

// Create MCP server
const server = new Server(
  {
    name: 'mandrel-http-bridge',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Fallback list of tools (used only if schema fetch fails)
const MANDREL_TOOLS = [
  // System Health (2 tools)
  { name: 'mandrel_ping', description: 'Test connectivity to Mandrel server' },
  { name: 'mandrel_status', description: 'Get server status and health information' },

  // Context Management (4 tools)
  { name: 'context_store', description: 'Store development context with automatic embedding' },
  { name: 'context_search', description: 'Search stored contexts using semantic similarity' },
  { name: 'context_get_recent', description: 'Get recent contexts chronologically (newest first)' },
  { name: 'context_stats', description: 'Get context statistics for a project' },

  // Project Management (6 tools)
  { name: 'project_list', description: 'List all available projects with statistics' },
  { name: 'project_create', description: 'Create a new project' },
  { name: 'project_switch', description: 'Switch to a different project (sets as current)' },
  { name: 'project_current', description: 'Get the currently active project information' },
  { name: 'project_info', description: 'Get detailed information about a specific project' },
  { name: 'project_insights', description: 'Get comprehensive project health and insights' },

  // Session Management (5 tools)
  { name: 'session_assign', description: 'Assign current session to a project' },
  { name: 'session_status', description: 'Get current session status and details' },
  { name: 'session_new', description: 'Create a new session with optional title and project assignment' },
  { name: 'session_update', description: 'Update session title and description for better organization' },
  { name: 'session_details', description: 'Get detailed session information including title, description, and metadata' },

  // Naming Registry (4 tools)
  { name: 'naming_register', description: 'Register a name to prevent conflicts' },
  { name: 'naming_check', description: 'Check for naming conflicts before using a name' },
  { name: 'naming_suggest', description: 'Get name suggestions based on description' },
  { name: 'naming_stats', description: 'Get naming statistics and convention compliance' },

  // Technical Decisions (4 tools)
  { name: 'decision_record', description: 'Record a technical decision with context' },
  { name: 'decision_search', description: 'Search technical decisions with filters' },
  { name: 'decision_update', description: 'Update decision status, outcomes, or lessons' },
  { name: 'decision_stats', description: 'Get technical decision statistics and analysis' },

  // Task Management (6 tools)
  { name: 'task_create', description: 'Create a new task for coordination' },
  { name: 'task_list', description: 'List tasks with optional filtering' },
  { name: 'task_update', description: 'Update task status and assignment' },
  { name: 'task_details', description: 'Get detailed information for a specific task' },
  { name: 'task_bulk_update', description: 'Update multiple tasks atomically with the same changes' },
  { name: 'task_progress_summary', description: 'Get task progress summary with grouping and completion percentages' },

  // Smart Search & AI (2 tools)
  { name: 'smart_search', description: 'Intelligent search across all project data' },
  { name: 'get_recommendations', description: 'Get AI-powered recommendations for development' },

  // Development Metrics (3 tools - TT009-2 Consolidated from 17 tools)
  { name: 'metrics_collect', description: 'TT009-2-1: Unified metrics collection - project, core, patterns, productivity data' },
  { name: 'metrics_analyze', description: 'TT009-2-2: Unified metrics analysis - dashboard, trends, correlations, executive summaries, aggregation' },
  { name: 'metrics_control', description: 'TT009-2-3: Unified metrics control - collection management, alerts, performance, export' },

  // Pattern Detection & Analysis (2 tools - TT009-3 Consolidated from 17 tools)
  { name: 'pattern_analyze', description: 'TT009-3-1: Unified pattern analysis - detection, analysis, tracking operations' },
  { name: 'pattern_insights', description: 'TT009-3-2: Unified pattern insights - insights, correlations, recommendations, alerts' },

  // Navigation & Help (3 tools)
  { name: 'mandrel_help', description: 'Get help and list all available Mandrel tools organized by category' },
  { name: 'mandrel_explain', description: 'Get detailed explanation and usage information for a specific Mandrel tool' },
  { name: 'mandrel_examples', description: 'Get usage examples and patterns for a specific Mandrel tool' }
];

console.error(`🎯 Bridge starting. Target: ${BASE_URL} | Connection: ${CONNECTION_ID}`);

// Cached schemas loaded from AIDIS HTTP service
let CACHED_TOOL_SCHEMAS = null; // [{ name, description, inputSchema }, ...]

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const httpModule = isHttps ? require('https') : http;

      const req = httpModule.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        timeout: options.timeout || 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Invalid JSON from ${url}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data || res.statusMessage}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (options.body) req.write(options.body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function loadToolSchemas() {
  try {
    const schemas = await fetchJson(`${BASE_URL}/mcp/tools/schemas`);
    if (schemas && schemas.success !== false && Array.isArray(schemas.tools)) {
      // Normalize to minimal shape needed by MCP: name, description, inputSchema
      CACHED_TOOL_SCHEMAS = schemas.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
      }));
      console.error(`📦 Loaded ${CACHED_TOOL_SCHEMAS.length} tool schemas from Mandrel`);
      return true;
    }
  } catch (e) {
    console.error(`⚠️  Failed to load tool schemas: ${e.message}`);
  }
  CACHED_TOOL_SCHEMAS = null;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// THREE STATES, NEVER TWO — the outcome of a bridge call (C1).
//
// A tool call has three outcomes and they have OPPOSITE remedies:
//   1. the server ran the tool          → pass its CallToolResult through untouched
//   2. the server REFUSED the call      → PERMANENT. Retrying re-sends the identical
//                                         call and is refused identically. Fix the call.
//   3. the server could not be reached  → TRANSPORT. Whether the call ran is UNKNOWN.
// Collapsing (2) onto (3) is what makes an agent retry a schema rejection in a loop;
// collapsing (3) onto (2) is what makes it give up on a blip. Each gets its own value.
//
// The same classifier exists in the riverbend repo, in runtime/bridge/
// claude-gateway-mcp-bridge.js: two separate single-file deployables, in separate repos,
// that must not drift. Each repo guards its own file behaviourally — this one by
// mcp-server/src/tests/bridgeOutcomeThreeStates.contract.test.ts, which spawns THIS script
// and reads what an MCP client receives. Nothing checks the two repos against each other;
// if you change one, change the other.
const OUTCOME = { REJECTED: 'REJECTED', UNREACHABLE: 'UNREACHABLE' };

// CONFIG, NOT MAGIC NUMBERS: which HTTP statuses mean "the server understood you and
// said no". Everything else (5xx, 0, a proxy's HTML) is treated as UNREACHABLE, because
// an unknown status must never be read as a settled refusal.
//
// 429 IS DELIBERATELY ABSENT. The REJECTED banner says "PERMANENT, DO NOT RETRY. An
// identical retry is refused identically." For a rate limit that sentence is false, and
// telling a caller not to retry something it SHOULD retry is this same state-collapse
// mirrored. /mcp/tools/* does not rate-limit today, but a fronting proxy can emit 429 and
// the bridge would then contradict the server verbatim. Falling through to UNREACHABLE
// ("check before retrying") is the honest answer until a RETRY-AFTER state exists.
const BRIDGE_REJECTED_STATUSES = new Set(
  (process.env.MANDREL_BRIDGE_REJECTED_STATUSES || '400,401,403,404,405,409,413,422')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
);

const OUTCOME_BANNER = {
  [OUTCOME.REJECTED]:
    '❌ Mandrel REJECTED this call — PERMANENT, DO NOT RETRY. The request reached the ' +
    'server and was refused (usually invalid arguments). An identical retry is refused ' +
    'identically; fix the call.',
  [OUTCOME.UNREACHABLE]:
    '⚠️ Mandrel COULD NOT BE REACHED — TRANSPORT. It is UNKNOWN whether the call ran. ' +
    'Check before retrying.'
};

/**
 * Render a server-supplied `error` field as text.
 *
 * WHY THIS IS NOT `String(err)`: the auth gate answers with a JSON-RPC frame whose
 * `error` is an OBJECT (`{code:-32001, message:"Unauthorized: invalid Bearer token."}`).
 * `new Error(thatObject).message` is the string "[object Object]" — a message-shaped
 * value carrying zero information, which reads to a caller exactly like an outage.
 * Measured against prod 2026-08-22 before this function existed.
 */
function describeServerError(err) {
  if (err === undefined || err === null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const msg = typeof err.message === 'string' ? err.message : JSON.stringify(err);
    return err.code !== undefined ? `${msg} (code ${err.code})` : msg;
  }
  return String(err);
}

/** An Error that carries WHICH of the three states it is, so the renderer need not guess. */
function bridgeFailure(outcome, detail) {
  const e = new Error(detail);
  e.outcome = outcome;
  return e;
}

/** How much of an unexpected body to quote back. Enough to identify it, not a flood. */
const BRIDGE_BODY_EXCERPT_CHARS = parseInt(process.env.MANDREL_BRIDGE_BODY_EXCERPT_CHARS || '400', 10);
const excerpt = (s) => (s || '').slice(0, BRIDGE_BODY_EXCERPT_CHARS);

// Call AIDIS HTTP bridge
function callAidisHttp(toolName, args) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ arguments: args || {} });
    const base = new URL(BASE_URL);
    const isHttps = base.protocol === 'https:';
    const httpModule = isHttps ? require('https') : http;

    const options = {
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: `/mcp/tools/${toolName}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-Connection-ID': CONNECTION_ID,  // Session isolation per bridge instance
        // Phase 1: declare the actor ONLY when MANDREL_ACTOR is set (else omit → unchanged).
        ...(ACTOR_ID ? { 'X-Actor-ID': ACTOR_ID } : {}),
        // declare the project binding ONLY when MANDREL_PROJECT_ID is set.
        ...(PROJECT_BINDING ? { 'X-Mandrel-Project': PROJECT_BINDING } : {})
      },
      timeout: 30000,
    };

    console.error(`🔄 HTTP Call: ${toolName}`);

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          // KEY ON THE PAYLOAD, NOT THE FLAG.
          // `/mcp/tools/*` answers an IN-BAND tool error with HTTP 200 and a real
          // CallToolResult under `result` — `isError:true` plus the actionable prose the
          // caller is supposed to read — and NO top-level `error`. Branching on `success`
          // therefore discarded that prose and substituted 'HTTP call failed' at exactly
          // the moment it was most needed.
          //
          // Reading `result` is also what makes this bridge correct against BOTH server
          // versions. This file runs on the control box and the server runs elsewhere, so
          // the two deploy independently and there is a window in which they disagree
          // about whether that envelope reads success:true or success:false. The payload
          // is identical either way, so keying on it removes the window.
          if (response.result !== undefined) {
            resolve(response.result);
            return;
          }
          // No payload: the server answered with an error, or with something we did not
          // expect. Either way the STATUS decides which of the two failure states it is —
          // never a single generic string for both (see OUTCOME above).
          const outcome = BRIDGE_REJECTED_STATUSES.has(res.statusCode)
            ? OUTCOME.REJECTED
            : OUTCOME.UNREACHABLE;
          const detail = describeServerError(response.error);
          reject(bridgeFailure(
            outcome,
            detail
              ? `HTTP ${res.statusCode}: ${detail}`
              // NEVER a message-less constant. If the body carried neither a result nor an
              // error we quote it, because "HTTP call failed" told the reader nothing and
              // was indistinguishable from an outage.
              : `HTTP ${res.statusCode}: response carried neither a tool result nor an error field. Body: ${excerpt(data)}`
          ));
        } catch (e) {
          reject(bridgeFailure(
            BRIDGE_REJECTED_STATUSES.has(res.statusCode) ? OUTCOME.REJECTED : OUTCOME.UNREACHABLE,
            `HTTP ${res.statusCode}: response body was not JSON: ${excerpt(data)}`
          ));
        }
      });
    });

    req.on('error', (err) => {
      reject(bridgeFailure(
        OUTCOME.UNREACHABLE,
        `transport error contacting ${BASE_URL}: ${err.code ? err.code + ' — ' : ''}${err.message}`
      ));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(bridgeFailure(
        OUTCOME.UNREACHABLE,
        `no response from ${BASE_URL} within ${options.timeout}ms`
      ));
    });

    req.write(postData);
    req.end();
  });
}

// Register tools/list handler (prefer live schemas if available)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!CACHED_TOOL_SCHEMAS) {
    await loadToolSchemas();
  }
  const tools = (CACHED_TOOL_SCHEMAS && CACHED_TOOL_SCHEMAS.length)
    ? CACHED_TOOL_SCHEMAS
    : MANDREL_TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true }
      }));
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.error(`🔧 MCP Tool Call: ${name}`);

  try {
    const result = await callAidisHttp(name, args);
    return result;
  } catch (error) {
    // An error with no declared outcome came from somewhere other than callAidisHttp;
    // the safe default is the state whose remedy is "go look", never "retry forever".
    const outcome = error && error.outcome ? error.outcome : OUTCOME.UNREACHABLE;
    console.error(`❌ Tool call ${outcome}: ${name} - ${error.message}`);

    return {
      // isError is the machine-readable half. Without it a failure renders to the MCP
      // client as a SUCCESSFUL result whose text happens to describe a failure.
      isError: true,
      content: [
        {
          type: 'text',
          text: `${OUTCOME_BANNER[outcome]}\nTool: ${name}\n${error.message}`
        }
      ]
    };
  }
});

// Start server
async function main() {
  // Best-effort load of schemas before connecting
  await loadToolSchemas();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const toolCount = (CACHED_TOOL_SCHEMAS && CACHED_TOOL_SCHEMAS.length) || MANDREL_TOOLS.length;
  console.error(`🚀 Mandrel HTTP-MCP Bridge v2.0.0 - Connected to ${BASE_URL}`);
  console.error(`📡 Available tools: ${toolCount} (schemas ${CACHED_TOOL_SCHEMAS ? 'loaded' : 'fallback'})`);
}

main().catch((error) => {
  console.error('❌ Failed to start HTTP-MCP bridge:', error);
  process.exit(1);
});
