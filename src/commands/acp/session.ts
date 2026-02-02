/**
 * ACP Session management - adapts Neovate session to ACP protocol
 */

import type {
  AgentSideConnection,
  PromptRequest,
  PromptResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import type { MessageBus } from '../../messageBus';
import type { NormalizedMessage } from '../../message';
import type { ApprovalCategory, ToolUse } from '../../tool';
import type { SlashCommand } from '../../slash-commands/types';
import {
  extractToolResultParts,
  fromACP,
  getDiffText,
  getResultText,
  isSlashCommand,
  mapApprovalCategory,
  parseSlashCommand,
  safeParseJson,
  toACPToolContent,
} from './utils/messageAdapter';
import { createACPPlugin } from './plugin';

/**
 * ACPSession wraps a Neovate session and handles ACP protocol events
 */
export class ACPSession {
  private pendingPrompt: AbortController | null = null;
  private readonly defaultCwd: string = process.cwd();

  constructor(
    private readonly id: string,
    private readonly messageBus: MessageBus,
    private readonly connection: AgentSideConnection,
    private readonly clientFsCapabilities?: any, // FileSystemCapability from client
  ) {}

  /**
   * Initialize session on the backend
   */
  async init() {
    await this.messageBus.request('session.initialize', {
      cwd: this.defaultCwd,
      sessionId: this.id,
    });

    this.listenChunkEvent();
    this.initPermission();

    // Initialize slash commands after a brief delay
    setTimeout(() => {
      this.initSlashCommand();
    }, 0);
  }

  /**
   * Initialize available slash commands
   */
  private async initSlashCommand() {
    try {
      const slashListRes = await this.messageBus.request('slashCommand.list', {
        cwd: this.defaultCwd,
      });

      const slashCommands: { command: SlashCommand }[] =
        slashListRes.data.slashCommands;

      // Filter to remote-compatible commands only
      const availableCommands = slashCommands
        .filter(
          (sc) =>
            sc.command.type !== 'local-jsx' && sc.command.type !== 'local',
        )
        .map((sc) => ({
          name: sc.command.name,
          description: sc.command.description,
          input: {
            hint: 'query to search for',
          },
        }));

      this.connection.sessionUpdate({
        sessionId: this.id,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands,
        },
      });
    } catch (error) {
      console.error('Failed to initialize slash commands:', error);
    }
  }

  /**
   * Initialize permission approval handler
   */
  private async initPermission() {
    this.messageBus.registerHandler(
      'toolApproval',
      async (data: { toolUse: ToolUse; category?: ApprovalCategory }) => {
        const { toolUse, category } = data;

        const permissionResponse = await this.connection.requestPermission({
          sessionId: this.id,
          toolCall: {
            toolCallId: toolUse.callId,
            kind: mapApprovalCategory(category),
          },
          options: [
            {
              kind: 'allow_once',
              name: 'Allow this change',
              optionId: 'allow',
            },
            {
              kind: 'reject_once',
              name: 'Skip this change',
              optionId: 'reject',
            },
          ],
        });

        if (permissionResponse.outcome.outcome === 'cancelled') {
          return { approved: false };
        }

        switch (permissionResponse.outcome.optionId) {
          case 'allow':
            return { approved: true };
          case 'reject':
            return { approved: false };
          default:
            throw new Error(
              `Unexpected permission outcome ${permissionResponse.outcome}`,
            );
        }
      },
    );
  }

  /**
   * Listen to chunk and message events from Neovate
   */
  private async listenChunkEvent() {
    // Listen for message events (tool results)
    this.messageBus.onEvent(
      'message',
      (data: { message: NormalizedMessage }) => {
        const { message } = data;
        const toolResultParts = extractToolResultParts(message);

        if (toolResultParts.length > 0) {
          for (const toolResult of toolResultParts) {
            // Special handling for todoWrite - map to ACP plan
            if (toolResult.name === 'todoWrite') {
              if (
                toolResult.result?.returnDisplay &&
                typeof toolResult.result.returnDisplay === 'object' &&
                toolResult.result.returnDisplay.type === 'todo_write'
              ) {
                const entries = (
                  toolResult.result.returnDisplay as any
                ).newTodos.map((item: any) => ({
                  content: item.content,
                  status: item.status,
                  priority: item.priority,
                }));

                this.connection.sessionUpdate({
                  sessionId: this.id,
                  update: {
                    sessionUpdate: 'plan',
                    entries,
                  },
                  _meta: {
                    toolCallId: toolResult.id,
                  },
                });
                continue;
              }
            }

            // Regular tool result handling
            const content = toACPToolContent(toolResult);

            this.connection.sessionUpdate({
              sessionId: this.id,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: toolResult.id || '',
                status: 'completed',
                content,
                rawInput: toolResult.input,
                rawOutput: toolResult.result,
              },
            });
          }
        }
      },
    );

    // Listen for chunk events (streaming)
    this.messageBus.onEvent(
      'chunk',
      (data: { chunk: LanguageModelV2StreamPart; requestId: string }) => {
        const { chunk } = data;

        // Handle reasoning deltas
        if (chunk.type === 'reasoning-delta') {
          this.connection.sessionUpdate({
            sessionId: this.id,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: {
                type: 'text',
                text: chunk.delta,
              },
            },
          });
        }

        // Handle tool calls
        if (chunk.type === 'tool-call') {
          // Skip todoWrite in tool call announcements
          if (chunk.toolName === 'todoWrite') {
            return;
          }

          const inputParams = safeParseJson(chunk.input);
          const update: SessionUpdate = {
            sessionUpdate: 'tool_call',
            toolCallId: chunk.toolCallId,
            title: chunk.toolName,
            status: 'pending',
          };

          // Enhance tool call display based on tool type
          if (chunk.toolName === 'bash') {
            update.title = `${inputParams?.command ?? ''}`;
            update.kind = 'execute';
          } else if (chunk.toolName === 'read') {
            update.kind = 'read';
            update.title = `read ${inputParams?.file_path ?? ''}`;
            update.locations = [{ path: inputParams?.file_path ?? '' }];
          } else if (chunk.toolName === 'fetch') {
            update.title = `fetch ${inputParams?.url ?? ''}`;
            update.kind = 'fetch';
          } else if (chunk.toolName === 'write') {
            update.title = `write ${inputParams?.file_path ?? ''}`;
            update.kind = 'edit';
          } else if (chunk.toolName === 'edit') {
            update.title = `edit ${inputParams?.file_path ?? ''}`;
            update.kind = 'edit';
          } else if (chunk.toolName === 'glob') {
            update.title = `glob ${inputParams?.pattern ?? ''}`;
            update.kind = 'search';
          } else if (chunk.toolName === 'grep') {
            update.title = `grep ${inputParams?.pattern ?? ''} ${inputParams?.search_path ?? ''}`;
            update.kind = 'search';
          }

          this.connection.sessionUpdate({
            sessionId: this.id,
            update,
          });
        }

        // Handle text deltas
        if (chunk.type === 'text-delta') {
          this.connection.sessionUpdate({
            sessionId: this.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: chunk.delta,
              },
            },
          });
        }
      },
    );
  }

  /**
   * Process prompt request from ACP client
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const { sessionId, prompt } = params;

    // Abort any pending prompt and create new abort controller
    this.pendingPrompt?.abort();
    this.pendingPrompt = new AbortController();

    try {
      // Convert ContentBlock[] to message format
      const messageText = fromACP(prompt);

      // Extract image attachments
      const imageAttachments = prompt
        .filter((block: any) => block.type === 'image')
        .map((block: any) => {
          return {
            type: 'image' as const,
            source: block.source,
            mimeType: block.mimeType,
          };
        });

      // Handle slash commands
      if (isSlashCommand(messageText)) {
        const parsed = parseSlashCommand(messageText);
        const result = await this.messageBus.request('slashCommand.get', {
          cwd: this.defaultCwd,
          command: parsed.command,
        });

        const commandEntry = result.data?.commandEntry;
        if (commandEntry) {
          const userMessage = {
            role: 'user',
            content: messageText,
          };
          const command = commandEntry.command;
          const type = command.type;
          const isPrompt = type === 'prompt';

          if (isPrompt) {
            await this.messageBus.request('session.addMessages', {
              cwd: this.defaultCwd,
              sessionId,
              messages: [userMessage],
            });

            const executeResult = await this.messageBus.request(
              'slashCommand.execute',
              {
                cwd: this.defaultCwd,
                sessionId,
                command: parsed.command,
                args: parsed.args,
              },
            );

            if (executeResult.success) {
              const messages = executeResult.data.messages;
              await this.messageBus.request('session.addMessages', {
                cwd: this.defaultCwd,
                sessionId,
                messages,
              });
            }

            // Send the message to the session
            const response = await this.messageBus.request('session.send', {
              message: messageText || null,
              cwd: this.defaultCwd,
              sessionId,
              planMode: false,
              attachments:
                imageAttachments.length > 0 ? imageAttachments : undefined,
            });

            if (response.success) {
              return { stopReason: 'end_turn' };
            }
          } else {
            throw new Error(`Unsupported slash command type: ${type}`);
          }
        }
      }

      // Regular message sending
      const response = await this.messageBus.request('session.send', {
        message: messageText || null,
        cwd: this.defaultCwd,
        sessionId,
        planMode: false,
        attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      });

      if (response.success) {
        return { stopReason: 'end_turn' };
      }

      return { stopReason: 'end_turn' };
    } catch (err) {
      // Check if this was a cancellation
      if (this.pendingPrompt?.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      throw err;
    } finally {
      this.pendingPrompt = null;
    }
  }

  /**
   * Abort any pending prompt
   */
  async abort() {
    await this.messageBus.request('session.cancel', {
      cwd: this.defaultCwd,
      sessionId: this.id,
    });
    this.pendingPrompt?.abort();
  }
}
