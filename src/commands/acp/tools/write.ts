/**
 * ACP Write Tool - Write files using ACP protocol
 *
 * Reuses all logic from write.shared.ts, only customizes file reading/writing method.
 *
 * Graceful Degradation:
 * - Tries ACP protocol first
 * - Falls back to fs if ACP is unavailable or fails
 */

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import fs from 'fs';
import path from 'pathe';
import { TOOL_NAMES } from '../../../constants';
import { createTool } from '../../../tool';
import {
  createWriteApprovalHandler,
  createWriteResult,
  formatContent,
  getWriteToolDescription,
  resolveWriteFilePath,
  writeToolParameters,
} from '../../../tools/write.shared';

export function createWriteTool(opts: {
  cwd: string;
  connection: AgentSideConnection;
  sessionId: string;
}) {
  return createTool({
    name: TOOL_NAMES.WRITE,
    description: getWriteToolDescription(),
    parameters: writeToolParameters,
    getDescription: ({ params, cwd }) => {
      if (!params.file_path || typeof params.file_path !== 'string') {
        return 'No file path provided';
      }
      return path.relative(cwd, params.file_path);
    },
    execute: async ({ file_path, content }) => {
      try {
        const fullFilePath = resolveWriteFilePath(file_path, opts.cwd);

        // Check if file exists (using fs for sync check)
        const oldFileExists = fs.existsSync(fullFilePath);

        // Read old content - try ACP first, fallback to fs
        let oldContent = '';
        if (oldFileExists) {
          try {
            const readResult = await opts.connection.readTextFile({
              path: fullFilePath,
              sessionId: opts.sessionId,
            });
            oldContent = readResult.content || '';
            // Success! Using ACP protocol for read
          } catch (acpReadError) {
            console.warn(
              `[ACP Write] Failed to read old content via ACP, falling back to fs: ${acpReadError instanceof Error ? acpReadError.message : 'Unknown error'}`,
            );
            try {
              oldContent = fs.readFileSync(fullFilePath, 'utf-8');
            } catch (fsReadError) {
              console.warn(
                `[ACP Write] Failed to read old content via fs, using empty: ${fsReadError instanceof Error ? fsReadError.message : 'Unknown error'}`,
              );
              oldContent = '';
            }
          }
        }

        // Create directory (using fs for sync operation)
        const dir = path.dirname(fullFilePath);
        fs.mkdirSync(dir, { recursive: true });

        // Write file - try ACP first, fallback to fs
        const formattedContent = formatContent(content);
        try {
          await opts.connection.writeTextFile({
            path: fullFilePath,
            content: formattedContent,
            sessionId: opts.sessionId,
          });
          // Success! Using ACP protocol for write
        } catch (acpWriteError) {
          // ACP write failed, fallback to fs
          console.warn(
            `[ACP Write] Failed to write via ACP, falling back to fs: ${acpWriteError instanceof Error ? acpWriteError.message : 'Unknown error'}`,
          );

          try {
            fs.writeFileSync(fullFilePath, formattedContent);
          } catch (fsWriteError) {
            // Both ACP and fs failed
            throw new Error(
              `Failed to write file via ACP and fs: ${fsWriteError instanceof Error ? fsWriteError.message : 'Unknown error'}`,
            );
          }
        }

        return createWriteResult(
          file_path,
          fullFilePath,
          opts.cwd,
          oldContent,
          oldFileExists,
        );
      } catch (e) {
        return {
          isError: true,
          llmContent: e instanceof Error ? e.message : 'Unknown error',
        };
      }
    },
    approval: createWriteApprovalHandler(),
  });
}
