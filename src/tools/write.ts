import fs from 'fs';
import path from 'pathe';
import { TOOL_NAMES } from '../constants';
import { createTool } from '../tool';
import {
  createWriteApprovalHandler,
  createWriteResult,
  formatContent,
  getWriteToolDescription,
  resolveWriteFilePath,
  writeToolParameters,
} from './write.shared';

export function createWriteTool(opts: { cwd: string }) {
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

        // Check if file exists and read old content (using fs)
        const oldFileExists = fs.existsSync(fullFilePath);
        const oldContent = oldFileExists
          ? fs.readFileSync(fullFilePath, 'utf-8')
          : '';

        // Create directory and write file (using fs)
        const dir = path.dirname(fullFilePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullFilePath, formatContent(content));

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
