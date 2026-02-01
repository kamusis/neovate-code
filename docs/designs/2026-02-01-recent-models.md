# Recent Used Models

## Overview

Track and display recently used models (max 5) in the model selector, showing them in a "Recent" group before provider groups.

## Changes

### 1. GlobalData (`src/globalData.ts`)

Add to `GlobalDataSchema`:
```typescript
recentModels?: string[];  // e.g., ["anthropic/claude-3", "openai/gpt-4"]
```

Add methods to `GlobalData` class:
```typescript
getRecentModels(): string[]
addRecentModel(model: string): void  // adds to front, dedupes, caps at 5
```

### 2. NodeBridge Handler

Create `src/nodeBridge/slices/globalData.ts`:
- `globalData.recentModels.get` - returns recent models list
- `globalData.recentModels.add` - adds a model to recent list

Register in `src/nodeBridge.ts`.

### 3. Session Send (`src/nodeBridge/slices/session.ts`)

In `session.send` handler, after resolving model, call handler to add model to recent list.

### 4. Model Selector (`src/slash-commands/builtin/model.tsx`)

Modify `models.list` handler in `src/nodeBridge/slices/models.ts` to include `recentModels`.

In `ModelSelect` component:
- Prepend "Recent" group before provider groups
- Only include models that exist in available models

## Data Flow

```
User sends message → session.send → save model to GlobalData
User opens /model → models.list returns recentModels → UI shows "Recent" group first
```
