import { navigationHandler } from '../handlers/navigation.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import { logger } from '../utils/logger.js';
import { MANDREL_VERSION } from '../version.js';
import { declaredLimbsFlagSummary } from '../config/declaredLimbsConfig.js';
import { threadTerminalityFlagSummary } from '../config/threadTerminalityConfig.js';
import { taskEdgeMintFlagSummary } from '../config/tagEdgeConfig.js';
import { liveFeatureFlags } from '../config/liveFeatureFlags.js';
import { callerEcho, orderPingText } from '../services/callerEcho.js';
import type { RouteContext } from './index.js';

/**
 * System & Navigation Routes
 * Handles: ping, status, help, explain, examples
 */
class SystemRoutes {
  /**
   * Handle ping tool - simple connectivity test
   */
  async handlePing(args: { message?: string }, context?: RouteContext): Promise<McpResponse> {
    try {
      const message = args.message || 'Hello Mandrel!';
      const timestamp = new Date().toISOString();

      logger.info(`🏓 Ping received: "${message}" at ${timestamp}`);

      // WHY A CONNECTIVITY TEST ANSWERS "WHO AM I". A customer could not
      // tell whether their X-Actor-ID was landing, so "I configured it" and "it works" were
      // indistinguishable to them — measured on a live tenant: 454 writes on the anonymous
      // fallback, still arriving, while the customer believed he was set up. Ping is the
      // first call anyone makes and the ONLY identity-bearing surface reachable from the
      // gateway tool list (via discover({action:'ping'}), which delegates here with this
      // same context). The echo is the shared one from services/callerEcho.ts — the same
      // derivation session_status reports, never a second answer.
      const caller = callerEcho(context);

      // ORDER MATTERS — see orderPingText. An undeclared caller gets the warning FIRST,
      // because the client that needed it summarised away everything after the headline.
      // A declared caller's text is byte-identical to before.
      return {
        content: [{
          type: 'text',
          text: orderPingText(
            `🏓 Mandrel Pong! Message: "${message}" | Time: ${timestamp} | Status: Operational`,
            caller
          ),
        }],
        structuredContent: {
          ok: true,
          message,
          timestamp,
          status: 'operational',
          caller,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'mandrel_ping');
    }
  }

  /**
   * Handle status tool - detailed server information
   */
  async handleStatus(): Promise<McpResponse> {
    try {
      logger.info('🎯 Status request received');
      const uptime = process.uptime();
      const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;
      // Version comes from the SINGLE source of truth (mcp-server/package.json via
      // ../version.js) — the SAME number reported by `initialize` and the health
      // endpoints. Surfacing it here closes the last gap where status showed none.
      return {
        content: [{
          type: 'text',
          text: `🎯 Mandrel Server Status Report\n\n` +
                `Version: ${MANDREL_VERSION}\n` +
                `Status: Operational\n` +
                `Uptime: ${uptimeStr}\n` +
                `Process: ${process.pid}\n` +
                // Call the builder rather than re-authoring the string. The VALUE could not
                // disagree either way (both read the same config field), but an inlined copy
                // drifts the moment someone edits the summary and expects status text to follow.
                declaredLimbsFlagSummary() + `\n` +
                threadTerminalityFlagSummary() + `\n` +
                taskEdgeMintFlagSummary()
        }],
        structuredContent: {
          ok: true,
          version: MANDREL_VERSION,
          status: 'operational',
          uptimeSeconds: Math.floor(uptime),
          pid: process.pid,
          // FLAG READ-BACK. A flag whose "off" is indistinguishable from
          // "broken" is not a flag: declared_limbs stays NULL both when the derivation is
          // switched off and when it errors, so the data cannot answer "is it on?".
          // statusShape is `.passthrough()`, so this is additive and breaks no caller.
          //
          // Built by config/liveFeatureFlags.ts, NOT inlined — the aidis://status MCP
          // resource answers the same question from the same builder. an earlier Task:
          // that resource used to answer it from the deleted JSON FeatureFlagStore, i.e.
          // from a permanently-empty map, so the two surfaces contradicted each other.
          featureFlags: liveFeatureFlags(),
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'mandrel_status');
    }
  }

  /**
   * Handle help tool - display categorized list of all Mandrel tools
   */
  async handleHelp(): Promise<McpResponse> {
    try {
      logger.info('🔧 Mandrel help request received');
      return await navigationHandler.getHelp();
    } catch (error) {
      return formatMcpError(error as Error, 'mandrel_help');
    }
  }

  /**
   * Handle explain tool - get detailed help for a specific tool
   */
  async handleExplain(args: { toolName: string }): Promise<McpResponse> {
    try {
      logger.info('🔧 Mandrel explain request received for tool', { metadata: { toolName: args.toolName } });
      return await navigationHandler.explainTool(args);
    } catch (error) {
      return formatMcpError(error as Error, 'mandrel_explain');
    }
  }

  /**
   * Handle examples tool - get usage examples for a specific tool
   */
  async handleExamples(args: { toolName: string }): Promise<McpResponse> {
    try {
      logger.info('🔧 Mandrel examples request received for tool', { metadata: { toolName: args.toolName } });
      return await navigationHandler.getExamples(args);
    } catch (error) {
      return formatMcpError(error as Error, 'mandrel_examples');
    }
  }

  /**
   * THE AGENT CAPTURE CONTRACT (P4 L1) — `discover({action:'contract'})` and
   * the flat `mandrel_contract`. Both doors land here, so there is exactly one renderer.
   */
  async handleCaptureContract(): Promise<McpResponse> {
    try {
      logger.info('🔧 Mandrel capture-contract request received');
      return await navigationHandler.getCaptureContract();
    } catch (error) {
      return formatMcpError(error as Error, 'mandrel_contract');
    }
  }
}

export const systemRoutes = new SystemRoutes();