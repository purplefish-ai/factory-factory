# Client State and Effects

How client components keep state in step with props and hold the latest values
for effects and handlers. The rules below are enforced by Oxlint where they can
be checked ([lint guardrails](../../lint-rules/README.md)).

## State that follows an identity

An effect that sets state from props runs after the commit, so for one commit
the screen shows the previous identity's state (and other effects in that commit
act on it). Instead:

- **Reset with `key`** when the whole subtree belongs to one identity.
  `QuestionPrompt` keys its form by request id and `PRDetailPanel` keys the
  detail by PR, so a new request or PR starts from fresh state.
- **Adjust state during render** when a remount is too costly or only part of
  the state resets: keep the identity the state belongs to and update both in
  the same render.

  ```ts
  const [stateAgentId, setStateAgentId] = useState(id);
  if (stateAgentId !== id) {
    setStateAgentId(id);
    setMode('detail');
  }
  ```

  React re-renders before committing, so no commit shows stale state. Examples:
  `useAgentsController`, `usePaletteKeyboardNavigation`, `useIssueLaunchDraft`
  in the issue launch sheet and `useRightPanelTopTab`.

- **Derive** values that are a function of props and state instead of storing
  them.

Effects remain the place for synchronising with something outside React:
subscriptions, timers, DOM measurement, network requests and toasts.
`factory/no-state-sync-effect` reports an effect with dependencies whose body
only calls state setters with values that were already known while rendering. It
ignores setters fed by a function call or a `.current` read, which may be
external, so it does not catch every case.

## Latest values in effects and handlers

`useLatestRef(value)` in `src/client/hooks/use-stable-callback.ts` returns a ref
updated in an insertion effect, before any layout effect, so effects,
subscriptions and handlers read the latest committed value without re-running.
`useStableCallback(callback)` builds on it to give a handler a permanent
identity. Biome treats both results as stable, so they stay out of dependency
arrays.

Do not write `ref.current` while rendering: a render can be discarded or
repeated. `factory/no-render-ref-write` reports such writes in a component or
hook body; writes in effects, handlers and callbacks are fine, as is lazy
initialisation (`if (ref.current === null) ref.current = …` or `??=`).

A value read while rendering cannot come from `useLatestRef`, which updates
after render. `usePersistedState` (its `getSnapshot` runs during render) and
`useWorkspaceToolExpansionState` (transcript rows call its getter while
rendering) keep a render-time write and are listed as exceptions.

`useWebSocketTransport` still updates its callback refs in a passive effect. Its
URL-change cleanup closes the previous socket before clearing it, so a socket
that reports `onclose` synchronously reaches `onDisconnected` during that
cleanup; with the passive update that is still the previous session's handler.
An earlier update sent a chat settings rollback to the newly selected session
(`use-chat-websocket.integration.test.tsx`). Revisit it with the chat session
store, which owns that handler.

Setting state after unmount is a no-op, so a "mounted" ref is only needed to
skip a real side effect, such as a toast, navigation or a parent callback. Each
remaining one says which.

## Shared behaviours

- `useDebouncedValue(value, delayMs, { immediate })` returns a value once it has
  stopped changing. `immediate` adopts the current value at once, for example a
  search cleared when its dialog closes.
- `useFollowOutput()` returns a callback ref for a scrolling log. It starts at
  the end and follows new content only while the reader is at the end; scrolling
  up stops following and scrolling back resumes it. Smooth scrolling comes from
  the element's CSS (`scroll-smooth`). The chat transcript has its own
  controller because it also restores saved positions in a virtualized list.
