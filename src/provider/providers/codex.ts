import { createOpenAI } from '@ai-sdk/openai';
import assert from 'assert';
import { CodexProvider } from 'oauth-providers';
import type { Provider } from './types';

interface JwtClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
  };
}

function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    return undefined;
  }
}

function extractAccountId(accessToken: string): string | undefined {
  const claims = parseJwtClaims(accessToken);
  if (!claims) return undefined;
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

export const codexProvider: Provider = {
  id: 'codex',
  source: 'built-in',
  env: [],
  name: 'Codex',
  api: 'https://chatgpt.com/backend-api/codex',
  doc: 'https://github.com/openai/codex',
  models: {
    'gpt-5.1-codex': {},
    'gpt-5.1-codex-mini': {},
    'gpt-5.1-codex-max': {},
    'gpt-5.2': {},
    'gpt-5.2-codex': {},
  },
  async createModel(name, provider, options) {
    const apiKey = provider.options?.apiKey;
    assert(apiKey, 'Failed to get Codex token, use /login to login first');
    let account = JSON.parse(apiKey);
    const codexProvider = new CodexProvider();
    codexProvider.setState(account);
    if (codexProvider.isTokenExpired()) {
      await codexProvider.refresh();
      account = codexProvider.getState();
      provider.options = {
        ...provider.options,
        apiKey: JSON.stringify(account),
      };
      options.setGlobalConfig(
        'provider.codex.options.apiKey',
        JSON.stringify(account),
        true,
      );
    }
    const CODEX_API_ENDPOINT =
      'https://chatgpt.com/backend-api/codex/responses';
    const accountId = extractAccountId(account.access_token);

    return createOpenAI({
      apiKey: account.access_token,
      fetch: (async (url, init) => {
        const headers = new Headers(init?.headers);

        headers.delete('authorization');
        headers.delete('Authorization');
        headers.set('authorization', `Bearer ${account.access_token}`);

        if (accountId) {
          headers.set('ChatGPT-Account-Id', accountId);
        }

        const parsed = new URL(
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        );
        const targetUrl =
          parsed.pathname.includes('/v1/responses') ||
          parsed.pathname.includes('/chat/completions')
            ? new URL(CODEX_API_ENDPOINT)
            : parsed;

        let modifiedInit = init;
        if (init?.body && targetUrl.href === CODEX_API_ENDPOINT) {
          try {
            const bodyObj = JSON.parse(init.body as string);
            if (!bodyObj.instructions) {
              bodyObj.instructions =
                bodyObj.system || 'You are a helpful assistant.';
            }
            bodyObj.store = false;
            modifiedInit = { ...init, body: JSON.stringify(bodyObj) };
          } catch {}
        }

        return fetch(targetUrl, { ...modifiedInit, headers });
      }) as typeof fetch,
    })(name);
  },
};
