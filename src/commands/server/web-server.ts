import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import type { ContextCreateOpts } from '../../context';
import { NodeBridge } from '../../nodeBridge';
import { WebSocketTransport } from './websocketTransport';

const BASE_API_PREFIX = '/api';

interface WebServerOptions {
  port: number;
  host?: string;
  contextCreateOpts: ContextCreateOpts;
  cwd: string;
}

class WebServer {
  private app: FastifyInstance;
  private wss!: WebSocketServer;
  private clients = new Map<
    string,
    { transport: WebSocketTransport; bridge: NodeBridge }
  >();
  private port: number;
  private host: string;
  private contextCreateOpts: ContextCreateOpts;
  private isWssRunning = false;
  private cwd: string;

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.host = options.host || 'localhost';
    this.contextCreateOpts = options.contextCreateOpts || {};
    this.cwd = options.cwd;
    // Initialize Fastify app
    this.app = fastify({
      logger: false,
      bodyLimit: 100 * 1024 * 1024, // 100MB limit for handling large images and files
    }).withTypeProvider<TypeBoxTypeProvider>();
  }

  private async registerPlugins() {
    // No plugins needed
  }

  private async setupRoutes() {
    // Health check endpoint
    this.app.get('/health', async (_request, reply) => {
      return reply.send({
        status: 'ok',
        clients: this.clients.size,
        timestamp: new Date().toISOString(),
      });
    });

    // Client info endpoint
    this.app.get('/clients', async (_request, reply) => {
      const clientInfo = Array.from(this.clients.entries()).map(
        ([id, client]) => ({
          id,
          connected: client.transport.isConnected(),
          state: client.transport.getState(),
        }),
      );
      return reply.send(clientInfo);
    });

    // files
    await this.app.register(import('./routes/files'), {
      prefix: BASE_API_PREFIX,
      ...this.contextCreateOpts,
    });

    // session
    await this.app.register(import('./routes/session'), {
      prefix: BASE_API_PREFIX,
      ...this.contextCreateOpts,
      cwd: this.cwd,
    });

    // folders
    await this.app.register(import('./routes/folders'), {
      prefix: BASE_API_PREFIX,
      ...this.contextCreateOpts,
      cwd: this.cwd,
    });

    // project
    await this.app.register(import('./routes/project'), {
      prefix: BASE_API_PREFIX,
      ...this.contextCreateOpts,
      cwd: this.cwd,
    });
  }

  private setupWebSocket() {
    // Initialize WebSocket server
    this.wss = new WebSocketServer({
      server: this.app.server,
      path: '/ws',
    });
    this.isWssRunning = true;

    this.wss.on('connection', (ws, _req) => {
      const clientId = this.generateClientId();
      console.log(`[WebServer] New client connected: ${clientId}`);

      // Create WebSocket transport
      const transport = new WebSocketTransport(ws);

      // Create NodeBridge instance for this client
      const bridge = new NodeBridge({
        contextCreateOpts: this.contextCreateOpts,
      });

      // Connect transport to bridge's message bus
      bridge.messageBus.setTransport(transport);

      // Store client
      this.clients.set(clientId, { transport, bridge });

      // Handle transport events
      transport.onError((error) => {
        console.error(`[WebServer] Client ${clientId} error:`, error);
      });

      transport.onClose(() => {
        console.log(`[WebServer] Client ${clientId} disconnected`);
        this.clients.delete(clientId);
      });

      // Send welcome message
      bridge.messageBus
        .emitEvent('connected', {
          clientId,
          timestamp: new Date().toISOString(),
          message: 'Welcome to Neovate WebSocket Server',
        })
        .catch(console.error);
    });

    this.wss.on('error', (error) => {
      console.error('[WebServer] WebSocket server error:', error);
    });
  }

  private generateClientId(): string {
    return `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async start(): Promise<void> {
    try {
      // Setup routes and WebSocket first
      await this.registerPlugins();
      await this.setupRoutes();
      this.setupWebSocket();

      // Start Fastify server
      await this.app.listen({
        port: this.port,
        host: this.host,
      });

      console.log(
        `[WebServer] Server running at http://${this.host}:${this.port}`,
      );
      console.log(
        `[WebServer] WebSocket endpoint: ws://${this.host}:${this.port}/ws`,
      );
    } catch (err) {
      console.error('[WebServer] Failed to start server:', err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    try {
      // Close all client connections
      for (const [clientId, { transport }] of this.clients) {
        console.log(`[WebServer] Closing client ${clientId}`);
        try {
          await transport.close();
        } catch (err) {
          console.warn(`[WebServer] Failed to close client ${clientId}:`, err);
        }
      }
      this.clients.clear();

      // Close WebSocket server
      if (this.wss && this.isWssRunning) {
        await new Promise<void>((resolve, reject) => {
          this.wss.close((err) => {
            this.isWssRunning = false;
            if (err && err.message !== 'The server is not running') {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }

      // Close Fastify server
      await this.app.close();
      console.log('[WebServer] Server stopped');
    } catch (err) {
      console.error('[WebServer] Error stopping server:', err);
      throw err;
    }
  }

  getClients() {
    return this.clients;
  }
}

// Export the WebServer class
export { WebServer };
