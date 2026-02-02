/**
 * ACP Plugin - Override read/write tools to use ACP protocol
 *
 * This plugin replaces the default read/write tools with ACP-enabled versions
 * when running in ACP mode. It's a non-invasive way to add ACP file system support.
 *
 * Architecture:
 * - Uses plugin system's tool name override mechanism
 * - Returns tools with same names (TOOL_NAMES.READ, TOOL_NAMES.WRITE)
 * - enforce: 'post' ensures these tools execute after built-in tools
 * - Tools with same name get replaced in Tools constructor
 *
 * Graceful Degradation:
 * - ACP tools try ACP protocol first (connection.readTextFile/writeTextFile)
 * - If ACP fails or is unavailable, automatically falls back to fs module
 * - Logs warnings when fallback occurs for debugging
 * - Ensures file operations always succeed when possible
 *
 * @see src/tool.ts - Tools constructor uses tool.name as key, later tools override earlier ones
 * @see src/plugin.ts - PluginHookType.SeriesMerge concatenates all plugin results
 */

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { Plugin } from '../../plugin';
import { createReadTool } from './tools/read';
import { createWriteTool } from './tools/write';

/**
 * Create ACP file system plugin
 *
 * @param opts.connection - ACP connection instance for file operations
 * @returns Plugin that overrides read/write tools with ACP-enabled versions
 *
 * @example
 * ```typescript
 * // In ACP agent initialization
 * if (params.clientCapabilities?.fs) {
 *   const plugin = createACPPlugin({ connection });
 *   context.pluginManager.register(plugin);
 * }
 * ```
 */
export function createACPPlugin(opts: {
  connection: AgentSideConnection;
}): Plugin {
  return {
    name: 'acp',

    enforce: 'post',

    /**
     * Tool hook: Returns ACP-enabled read/write tools
     * @param toolOpts.sessionId - Session ID for this tool invocation
     * @param toolOpts.isPlan - Whether in plan mode
     * @this {Context} - Context object with cwd, productName, etc.
     * @returns Array of ACP-enabled tools that will override built-in tools
     */
    tool(toolOpts) {
      const { sessionId } = toolOpts;

      return [
        createReadTool({
          cwd: this.cwd,
          productName: this.productName,
          connection: opts.connection,
          sessionId,
        }),

        createWriteTool({
          cwd: this.cwd,
          connection: opts.connection,
          sessionId,
        }),
      ];
    },
  };
}
