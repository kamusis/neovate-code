import { GithubProvider, QwenProvider, CodexProvider } from 'oauth-providers';
import { ConfigManager } from '../../config';
import type { Context } from '../../context';
import type { MessageBus } from '../../messageBus';
import { type Provider, resolveModelWithContext } from '../../provider/model';
import { isOAuthProvider } from '../../provider/providers/oauth';

interface OAuthSession {
  provider: GithubProvider | QwenProvider | CodexProvider;
  providerId: string;
  createdAt: number;
  cleanup?: () => void;
  tokenPromise?: Promise<string>;
  resolved: boolean;
  resolvedToken?: string;
  resolvedError?: string;
}

const oauthSessions = new Map<string, OAuthSession>();

function cleanupStaleSessions(ttlMs = 300000) {
  const now = Date.now();
  for (const [id, session] of oauthSessions) {
    if (now - session.createdAt > ttlMs) {
      session.cleanup?.();
      oauthSessions.delete(id);
    }
  }
}

function generateSessionId(): string {
  return `oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function registerProvidersHandlers(
  messageBus: MessageBus,
  getContext: (cwd: string) => Promise<Context>,
) {
  messageBus.registerHandler('providers.list', async (data) => {
    const { cwd } = data;
    const context = await getContext(cwd);
    const { providers } = await resolveModelWithContext(null, context);
    return {
      success: true,
      data: {
        providers: normalizeProviders(providers, context),
      },
    };
  });

  messageBus.registerHandler('providers.login.initOAuth', async (data) => {
    const { cwd, providerId, timeout = 300000 } = data;
    cleanupStaleSessions(timeout);

    try {
      let authUrl: string;
      let userCode: string | undefined;
      let oauthProvider: GithubProvider | QwenProvider | CodexProvider;
      let cleanup: (() => void) | undefined;
      let tokenPromise: Promise<string> | undefined;

      if (providerId === 'github-copilot') {
        const githubProvider = new GithubProvider();
        const auth = await githubProvider.initAuth(timeout);
        if (!auth.verificationUri) {
          return { success: false, error: 'Failed to get authorization URL' };
        }
        authUrl = auth.verificationUri;
        userCode = auth.userCode;
        oauthProvider = githubProvider;
        tokenPromise = auth.tokenPromise;
      } else if (providerId === 'qwen') {
        const qwenProvider = new QwenProvider();
        const auth = await qwenProvider.initAuth(timeout);
        if (!auth.authUrl) {
          return { success: false, error: 'Failed to get authorization URL' };
        }
        authUrl = auth.authUrl;
        oauthProvider = qwenProvider;
        cleanup = auth.cleanup;
        tokenPromise = auth.tokenPromise;
      } else if (providerId === 'codex') {
        const codexProvider = new CodexProvider();
        const auth = await codexProvider.initAuth(timeout);
        if (!auth.authUrl) {
          return { success: false, error: 'Failed to get authorization URL' };
        }
        authUrl = auth.authUrl;
        oauthProvider = codexProvider;
        cleanup = auth.cleanup;
        tokenPromise = auth.tokenPromise;
      } else {
        return { success: false, error: 'Unsupported OAuth provider' };
      }

      const oauthSessionId = generateSessionId();
      const session: OAuthSession = {
        provider: oauthProvider,
        providerId,
        createdAt: Date.now(),
        cleanup,
        tokenPromise,
        resolved: false,
      };
      oauthSessions.set(oauthSessionId, session);

      if (tokenPromise) {
        tokenPromise
          .then((token) => {
            session.resolved = true;
            session.resolvedToken = token;
          })
          .catch((error) => {
            session.resolved = true;
            session.resolvedError = String(error);
          });
      }

      return {
        success: true,
        data: { authUrl, userCode, oauthSessionId },
      };
    } catch (error) {
      return { success: false, error: `Failed to initialize OAuth: ${error}` };
    }
  });

  messageBus.registerHandler('providers.login.pollOAuth', async (data) => {
    const { cwd, oauthSessionId } = data;
    const context = await getContext(cwd);

    const session = oauthSessions.get(oauthSessionId);
    if (!session) {
      return { success: false, error: 'OAuth session expired or invalid' };
    }

    if (!session.resolved) {
      return { success: true, data: { status: 'pending' as const } };
    }

    if (session.resolvedError) {
      const error = session.resolvedError;
      session.cleanup?.();
      oauthSessions.delete(oauthSessionId);
      return { success: true, data: { status: 'error' as const, error } };
    }

    try {
      let user: string | undefined;
      const configManager = new ConfigManager(cwd, context.productName, {});
      const token = session.resolvedToken!;

      if (session.providerId === 'github-copilot') {
        const githubProvider = session.provider as GithubProvider;
        await githubProvider.getToken(token);
        await githubProvider.refresh();
        const account = githubProvider.getState() as any;
        if (!account) {
          return {
            success: true,
            data: {
              status: 'error' as const,
              error: 'Failed to get account after authentication',
            },
          };
        }
        user = account.user?.login || account.user?.email;
        configManager.setConfig(
          true,
          `provider.github-copilot.options.apiKey`,
          JSON.stringify(account),
        );
      } else if (session.providerId === 'qwen') {
        const qwenProvider = session.provider as QwenProvider;
        await qwenProvider.getToken(token);
        const account = qwenProvider.getState() as any;
        if (!account) {
          return {
            success: true,
            data: {
              status: 'error' as const,
              error: 'Failed to get account after authentication',
            },
          };
        }
        user = account.username || account.email;
        configManager.setConfig(
          true,
          `provider.qwen.options.apiKey`,
          JSON.stringify(account),
        );
      } else if (session.providerId === 'codex') {
        const codexProvider = session.provider as CodexProvider;
        await codexProvider.getToken(token);
        const account = codexProvider.getState() as any;
        if (!account) {
          return {
            success: true,
            data: {
              status: 'error' as const,
              error: 'Failed to get account after authentication',
            },
          };
        }
        user = account.email;
        configManager.setConfig(
          true,
          `provider.codex.options.apiKey`,
          JSON.stringify(account),
        );
      }

      session.cleanup?.();
      oauthSessions.delete(oauthSessionId);

      return { success: true, data: { status: 'completed' as const, user } };
    } catch (error) {
      session.cleanup?.();
      oauthSessions.delete(oauthSessionId);
      return {
        success: true,
        data: { status: 'error' as const, error: String(error) },
      };
    }
  });

  messageBus.registerHandler('providers.login.completeOAuth', async (data) => {
    const { cwd, providerId, oauthSessionId, code } = data;
    const context = await getContext(cwd);

    const session = oauthSessions.get(oauthSessionId);
    if (!session) {
      return { success: false, error: 'OAuth session expired or invalid' };
    }

    if (session.providerId !== providerId) {
      return { success: false, error: 'Provider mismatch' };
    }

    try {
      let user: string | undefined;
      const configManager = new ConfigManager(cwd, context.productName, {});

      if (providerId === 'github-copilot') {
        const githubProvider = session.provider as GithubProvider;
        await githubProvider.getToken(code);
        await githubProvider.refresh();
        const account = githubProvider.getState() as any;
        if (!account) {
          return {
            success: false,
            error: 'Failed to get account after authentication',
          };
        }
        user = account.user?.login || account.user?.email;
        configManager.setConfig(
          true,
          `provider.github-copilot.options.apiKey`,
          JSON.stringify(account),
        );
      } else if (providerId === 'qwen') {
        const qwenProvider = session.provider as QwenProvider;
        await qwenProvider.getToken(code);
        const account = qwenProvider.getState() as any;
        if (!account) {
          return {
            success: false,
            error: 'Failed to get account after authentication',
          };
        }
        user = account.username || account.email;
        configManager.setConfig(
          true,
          `provider.qwen.options.apiKey`,
          JSON.stringify(account),
        );
      } else if (providerId === 'codex') {
        const codexProvider = session.provider as CodexProvider;
        await codexProvider.getToken(code);
        const account = codexProvider.getState() as any;
        if (!account) {
          return {
            success: false,
            error: 'Failed to get account after authentication',
          };
        }
        user = account.email;
        configManager.setConfig(
          true,
          `provider.codex.options.apiKey`,
          JSON.stringify(account),
        );
      }

      session.cleanup?.();
      oauthSessions.delete(oauthSessionId);

      return { success: true, data: { user } };
    } catch (error) {
      return { success: false, error: `Authorization failed: ${error}` };
    }
  });

  messageBus.registerHandler('providers.login.status', async (data) => {
    const { cwd, providerId } = data;
    const context = await getContext(cwd);

    const apiKey = context.config.provider?.[providerId]?.options?.apiKey;

    if (!apiKey) {
      return { success: true, data: { isLoggedIn: false } };
    }

    let user: string | undefined;
    if (isOAuthProvider(providerId)) {
      try {
        const account = JSON.parse(apiKey);
        user =
          account.user?.login ||
          account.username ||
          account.email ||
          account.user?.email;
      } catch {}
    }

    return { success: true, data: { isLoggedIn: true, user } };
  });
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '****';
  }
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

export function normalizeProviders(
  providers: Record<string, Provider>,
  context: Context,
) {
  return Object.values(providers).map((provider) => {
    const validEnvs: string[] = [];
    if (provider.env && Array.isArray(provider.env)) {
      provider.env.forEach((envVar: string) => {
        if (process.env[envVar]) {
          validEnvs.push(envVar);
        }
      });
    }
    if (provider.apiEnv && Array.isArray(provider.apiEnv)) {
      provider.apiEnv.forEach((envVar: string) => {
        if (process.env[envVar]) {
          validEnvs.push(envVar);
        }
      });
    }

    const configApiKey =
      context.config.provider?.[provider.id]?.options?.apiKey;
    const envApiKey = (() => {
      for (const envVar of provider.env || []) {
        if (process.env[envVar]) {
          return { key: process.env[envVar]!, envName: envVar };
        }
      }
      return null;
    })();

    const hasApiKey = !!(provider.options?.apiKey || configApiKey);

    let maskedApiKey: string | undefined;
    let apiKeyOrigin: 'env' | 'config' | undefined;
    let apiKeyEnvName: string | undefined;
    let oauthUser: string | undefined;

    if (envApiKey) {
      maskedApiKey = maskApiKey(envApiKey.key);
      apiKeyOrigin = 'env';
      apiKeyEnvName = envApiKey.envName;
    } else if (configApiKey) {
      apiKeyOrigin = 'config';
      if (isOAuthProvider(provider.id)) {
        try {
          const account = JSON.parse(configApiKey);
          oauthUser =
            account.user?.login ||
            account.username ||
            account.email ||
            account.user?.email;
          maskedApiKey = oauthUser ? undefined : '(OAuth token)';
        } catch {
          maskedApiKey = '(OAuth token)';
        }
      } else {
        maskedApiKey = maskApiKey(configApiKey);
      }
    }

    return {
      id: provider.id,
      name: provider.name,
      doc: provider.doc,
      env: provider.env,
      apiEnv: provider.apiEnv,
      api: provider.api,
      options: provider.options,
      source: provider.source,
      apiFormat: provider.apiFormat,
      validEnvs,
      hasApiKey,
      maskedApiKey,
      apiKeyOrigin,
      apiKeyEnvName,
      oauthUser,
    };
  });
}
