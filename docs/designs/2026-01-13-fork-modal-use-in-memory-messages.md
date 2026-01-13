# Fork Modal Use In-Memory Messages

**Date:** 2026-01-13

## Context

When using the fork feature (esc-esc to open the fork modal, select a message, press Enter to fork), the forked-away messages would still appear if the user opened the fork modal again. This was confusing because the user expected the fork operation to remove those messages from the list.

## Discussion

The root cause was identified:

1. The `ForkModal` component received `forkMessages` which was fetched from the persisted session file via `bridge.request('session.messages.list', ...)`
2. When forking, the `fork()` function only updated the **in-memory** `messages` array in the Zustand store
3. The session file was NOT updated during fork - it's only updated when a new message is actually submitted
4. When reopening the fork modal, it re-fetched from the session file, which still contained all the original messages

Two solutions were considered:

**Option 1 (Simple)**: Use the in-memory `messages` from the store directly instead of fetching from the session file. This treats fork as a "pending" operation until a new message is submitted.

**Option 2 (Persist)**: After forking, persist the filtered messages to the session file via a bridge call.

Option 1 was chosen for simplicity - the in-memory state represents the current working state, and the fork is conceptually a pending operation until the user submits a new message.

## Approach

Replace the async session file fetch with direct usage of the store's `messages` state:

1. Remove the `forkMessages` and `forkLoading` local state
2. Remove the `useEffect` that fetched from `session.messages.list`
3. Use `useAppStore((s) => s.messages)` directly
4. Pass `messages` to `ForkModal` instead of `forkMessages`
5. Remove unused `bridge`, `sessionId`, `cwd` from the destructured store values

## Architecture

The change is localized to `src/ui/App.tsx`:

```tsx
// Before: Fetched from session file
const [forkMessages, setForkMessages] = React.useState<any[]>([]);
React.useEffect(() => {
  // ... async fetch from session.messages.list
}, [forkModalVisible, bridge, cwd, sessionId]);

// After: Use in-memory messages directly
const messages = useAppStore((s) => s.messages);

// ForkModal now receives current in-memory state
<ForkModal messages={messages as any} ... />
```

This ensures the fork modal always reflects the current in-memory state, including any pending fork operations.
