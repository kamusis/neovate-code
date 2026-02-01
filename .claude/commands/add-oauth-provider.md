---
name: Add OAuth Provider
description: Create a new OAuth provider with login and related logic
---

Add a new OAuth provider named $ARGUMENTS following the patterns in:

1. **Provider definition** (`src/provider/providers/<provider>.ts`):
   - Create provider with `id`, `name`, `doc`, `models`
   - Add `createModel` function for OAuth token handling:
     - Parse apiKey as JSON to get account state
     - Use provider class from `oauth-providers` for token refresh
     - Save refreshed token back to global config
     - Create OpenAI-compatible client with Bearer token auth
   - Reference: @src/provider/providers/qwen.ts

2. **Export provider** (`src/provider/providers/index.ts`):
   - Add export statement
   - Add import statement  
   - Add to `providers` map

3. **Register OAuth provider** (`src/provider/providers/oauth.ts`):
   - Add provider id to `OAUTH_PROVIDERS` array

4. **OAuth handlers** (`src/nodeBridge/slices/providers.ts`):
   - Import provider class from `oauth-providers`
   - Update `OAuthSession.provider` type union
   - Add case in `providers.login.initOAuth` handler
   - Add case in `providers.login.pollOAuth` handler
   - Add case in `providers.login.completeOAuth` handler

5. **NodeBridge types** (`src/nodeBridge.types.ts`):
   - Add provider id to `ProvidersLoginInitOAuthInput.providerId` union type
   - Add provider id to `ProvidersLoginCompleteOAuthInput.providerId` union type

6. **Login UI** (`src/slash-commands/builtin/login.tsx`):
   - Add provider-specific title and waiting message in OAuth UI section

Run typecheck after implementation.
