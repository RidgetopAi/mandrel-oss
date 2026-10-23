/**
 * TOOL-INPUT ELEMENT LIMIT.
 *
 * The SDK 1.32 `McpServer` refuses a `tools/call` whose `arguments` contain more than
 * `maxToolInputElements` array elements + object members, before the tool runs. This server
 * builds on the low-level SDK `Server` (registerMcpHandlers.ts), which has no such option,
 * so the same count lives here and every tool-call surface calls it before dispatch:
 *   - registerMcpHandlers.ts CallTool handler — the streamable /mcp gateway AND stdio;
 *   - healthServer.ts handleMcpToolExpress     — the flat /mcp/tools/:tool surface.
 *
 * The count mirrors the SDK's `toolInputElementCount` (not exported by the SDK): iterative,
 * so a deeply nested payload cannot overflow the stack, and it stops as soon as the running
 * total passes the limit, so an oversized payload costs at most `max + 1` steps.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from '../config/mcpRequestLimitsConfig.js';

/** Count array elements + own object members in `value`, stopping once the total passes `max`. */
export function countToolInputElements(value: unknown, max: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > max) return count;
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++count > max) return count;
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  return count;
}

/**
 * Throw McpError(InvalidParams) when `args` carries more elements than `max`. -32602 is a
 * client error on every surface: JSON-RPC error on /mcp, HTTP 400 on the flat surface
 * (utils/mcpErrorStatus.ts).
 */
export function assertToolInputWithinLimit(
  toolName: string,
  args: unknown,
  max: number = MCP_MAX_TOOL_INPUT_ELEMENTS
): void {
  if (countToolInputElements(args, max) > max) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for tool ${toolName}: arguments contain more than the maximum of ${max} elements`
    );
  }
}
