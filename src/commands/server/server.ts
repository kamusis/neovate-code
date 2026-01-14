import portfinder from 'portfinder';
import { WebServer } from './web-server';

const DEFAULT_PORT = 1024;
const DEFAULT_HOST = '127.0.0.1';

export async function runServer(opts: {
  cwd: string;
  contextCreateOpts: any;
  port?: number;
  host?: string;
}): Promise<() => Promise<void>> {
  const port = await portfinder.getPortPromise({
    port: opts.port ?? DEFAULT_PORT,
  });

  const server = new WebServer({
    port,
    host: opts.host ?? DEFAULT_HOST,
    contextCreateOpts: opts.contextCreateOpts,
    cwd: opts.cwd,
  });

  const shutdown = async () => {
    console.log('\n[WebServer] Shutting down...');
    await server.stop();
  };

  await server.start();

  return shutdown;
}
