/**
 * Neovate ACP Agent implementation
 */

import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type FileSystemCapability,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ModelInfo,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionModelState,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import createDebug from 'debug';
import { Context } from '../../context';
import { MessageBus, DirectTransport } from '../../messageBus';
import { NodeBridge } from '../../nodeBridge';
import type { ACPContextCreateOpts } from './types';
import { ACPSession } from './session';
import { createACPPlugin } from './plugin';

const debug = createDebug('neovate:acp:agent');

function log(message: string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  process.stderr.write(`[${timestamp}] [ACP:Agent] ${message}
`);
  if (args.length > 0) {
    process.stderr.write(`${JSON.stringify(args, null, 2)}
`);
  }
}

/**
 * NeovateACPAgent implements the ACP Agent interface
 * Directly calls Neovate Context/Session APIs in-process
 */
export class NeovateACPAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions: Map<string, ACPSession> = new Map();
  private messageBus?: MessageBus;
  private nodeBridge?: NodeBridge;
  private context?: Context;
  private defaultCwd: string;
  private contextCreateOpts: ACPContextCreateOpts;
  private clientFsCapabilities?: FileSystemCapability; // FileSystemCapability from client

  constructor(
    connection: AgentSideConnection,
    contextCreateOpts: ACPContextCreateOpts,
  ) {
    this.connection = connection;
    this.contextCreateOpts = contextCreateOpts;
    this.defaultCwd = contextCreateOpts.cwd || process.cwd();
  }

  /**
   * Initialize the agent and create Context
   */
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    log('Initializing ACP agent');
    debug('Initialize params: %O', params);

    // Check client capabilities for file system support
    if (params.clientCapabilities?.fs) {
      log(
        'Client supports file system capabilities:',
        params.clientCapabilities.fs,
      );
      this.clientFsCapabilities = params.clientCapabilities.fs;
    }
    // Create context with ACP plugin if file system is supported
    log('Creating Neovate context');
    const plugins = [...(this.contextCreateOpts.plugins || [])];

    // Add ACP file system plugin if capabilities are available
    if (this.clientFsCapabilities) {
      log('Adding ACP file system plugin');
      const acpPlugin = createACPPlugin({
        connection: this.connection,
      });
      plugins.push(acpPlugin);
    }

    // Create MessageBus for event-driven architecture
    log('Creating NodeBridge and MessageBus');
    const nodeBridge = new NodeBridge({
      contextCreateOpts: {
        ...this.contextCreateOpts,
        cwd: this.defaultCwd,
        plugins,
      },
    });

    const [clientTransport, nodeTransport] = DirectTransport.createPair();
    const messageBus = new MessageBus();
    messageBus.setTransport(clientTransport);
    nodeBridge.messageBus.setTransport(nodeTransport);

    this.messageBus = messageBus;
    this.nodeBridge = nodeBridge;

    log('Agent initialized successfully');
    return {
      protocolVersion: PROTOCOL_VERSION, // ACP protocol version (will be proper type after SDK install)
      agentCapabilities: {},
    };
  }

  /**
   * Get available models that can be used
   */
  private async getCanUseModels(): Promise<SessionModelState | undefined> {
    if (!this.messageBus) {
      return undefined;
    }

    try {
      const providersRes = await this.messageBus.request('providers.list', {
        cwd: this.defaultCwd,
      });
      const providersData = providersRes.data.providers as any[];

      // Filter to only show providers that have API keys configured
      const configuredProviders = providersData.filter(
        (provider) => provider.hasApiKey,
      );

      if (configuredProviders.length === 0) {
        return undefined;
      }

      const modelState = await this.messageBus.request('models.list', {
        cwd: this.defaultCwd,
      });

      const filteredModels = modelState.data.groupedModels.filter(
        (provider: any) =>
          configuredProviders.some((item) => item.id === provider.providerId),
      );

      const availableModels: ModelInfo[] = filteredModels
        .map((provider: any) => provider.models)
        .flat()
        .map((item: any) => ({
          modelId: item.value,
          name: item.name,
        }));

      return {
        availableModels,
        currentModelId: `${modelState.data.currentModel.provider.id}/${modelState.data.currentModelInfo?.modelId ?? ''}`,
      };
    } catch (error) {
      console.error('Failed to get available models:', error);
      return undefined;
    }
  }

  /**
   * Create a new session
   */
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!this.messageBus) {
      throw new Error('Agent not initialized');
    }

    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    log('Creating new session:', sessionId);
    debug('Session params: %O', params);

    const models = await this.getCanUseModels();
    const acpSession = new ACPSession(
      sessionId,
      this.messageBus,
      this.connection,
      this.clientFsCapabilities, // Pass fs capabilities
    );

    this.sessions.set(sessionId, acpSession);
    await acpSession.init();

    log('Session created successfully:', sessionId);
    return {
      sessionId,
      models: models || undefined,
    };
  }

  /**
   * Load an existing session
   */
  loadSession?(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    throw new Error('Method not implemented.');
  }

  /**
   * Fork an existing session
   */
  unstable_forkSession?(
    params: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    throw new Error('Method not implemented.');
  }

  /**
   * List all sessions
   */
  unstable_listSessions?(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    throw new Error('Method not implemented.');
  }

  /**
   * Resume a session
   */
  unstable_resumeSession?(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    throw new Error('Method not implemented.');
  }

  /**
   * Set session mode
   */
  async setSessionMode?(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    throw new Error('Method not implemented.');
  }

  /**
   * Set session model
   */
  async unstable_setSessionModel?(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    if (!this.messageBus) {
      throw new Error('Agent not initialized');
    }

    await this.messageBus.request('config.set', {
      cwd: this.defaultCwd,
      key: 'model',
      value: params.modelId,
      isGlobal: true,
    });

    await this.messageBus.request('project.clearContext', {});
  }

  /**
   * Set session config option
   */
  unstable_setSessionConfigOption?(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    throw new Error('Method not implemented.');
  }

  /**
   * Authenticate
   */
  authenticate(
    params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void> {
    throw new Error('Method not implemented.');
  }

  /**
   * Send a prompt to a session
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const { sessionId } = params;

    log('Received prompt for session:', sessionId);
    debug('Prompt params: %O', params);

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const result = await session.prompt(params);
    log(
      'Prompt completed for session:',
      sessionId,
      'result:',
      result.stopReason,
    );
    return result;
  }

  /**
   * Cancel a running prompt
   */
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    await session.abort();
  }

  /**
   * Extension method handler
   */
  extMethod?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw new Error('Method not implemented.');
  }

  /**
   * Extension notification handler
   */
  extNotification?(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    throw new Error('Method not implemented.');
  }
}
