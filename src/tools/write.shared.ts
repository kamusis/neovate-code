/**
 * Write Tool - Shared logic and utilities
 *
 * This file contains reusable functions for writing files,
 * allowing both fs-based and ACP-based implementations to share code.
 */

import path from 'pathe';
import { z } from 'zod';
import { TOOL_NAMES } from '../constants';
import { type ToolResult } from '../tool';
import { isPlanFile } from '../utils/planFileUtils';

// Tool parameters
export const writeToolParameters = z.object({
  file_path: z.string(),
  content: z.string(),
});

// Tool description
export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the ${TOOL_NAMES.READ} tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;
}

// Format content (ensure newline at end)
export function formatContent(content: string): string {
  if (!content.endsWith('\n')) {
    return content + '\n';
  }
  return content;
}

// Resolve file path
export function resolveWriteFilePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

// Create write result
export function createWriteResult(
  file_path: string,
  fullFilePath: string,
  cwd: string,
  oldContent: string,
  oldFileExists: boolean,
): ToolResult {
  return {
    llmContent: `File successfully written to ${file_path}`,
    returnDisplay: {
      type: 'diff_viewer',
      filePath: path.relative(cwd, fullFilePath),
      absoluteFilePath: fullFilePath,
      originalContent: oldContent,
      newContent: { inputKey: 'content' },
      writeType: oldFileExists ? 'replace' : 'add',
    },
  };
}

// Approval logic
export function createWriteApprovalHandler() {
  return {
    category: 'write' as const,
    needsApproval: async (approvalContext: any) => {
      const { params, context, approvalMode } = approvalContext;

      // Calculate plans directory path
      const plansDir = path.join(context.paths.globalConfigDir, 'plans');

      // Auto-approve for plan files
      if (isPlanFile(params.file_path, plansDir)) {
        return false;
      }

      // Otherwise use default logic: only 'default' mode needs approval
      return approvalMode === 'default';
    },
  };
}
