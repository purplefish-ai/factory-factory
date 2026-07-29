# Failed Dispatch Rejection Retention Design

## Goal

Keep a failed dispatch's recovery payload available for its existing 60-second
reconnect window when an inactive session store is evicted after a runtime crash
or WebSocket disconnect.

## Root Cause

Runtime exit removes the live ACP handle before the asynchronous lifecycle exit
handler finishes, so inactivity checks correctly observe that the session is no
longer running. While that handler is awaiting repository work, the ACP
connection can reject an in-flight prompt and `failMessage` records the failed
draft in `recentRejections`. The lifecycle handler then fully clears the store.

A disconnected WebSocket has a parallel loss path. It defers inactive cleanup
until its in-flight message handler settles. The failed dispatch records its
rejection as that handler settles, and the deferred cleanup then fully clears the
same store.

## Design

Add an opt-in `preserveRejections` option to session-store clearing. The default
remains a destructive clear for session deletion, rollback, and explicit
orchestration cleanup.

When preservation is requested, the registry will:

1. Select only rejection records whose `expiresAt` is later than `Date.now()`.
2. Clear the history-retry cooldown and delete the existing session store.
3. Recreate a fresh default store only when an unexpired rejection exists.
4. Restore those rejection records into the fresh store.

This resets transcript, queue, pending requests, runtime, hydration metadata,
and ordering while retaining only the bounded recovery records. The domain
service will still delete any initial message before forwarding the option.

Both inactivity-eviction call sites will request preservation:

- lifecycle cleanup after manual stop or runtime exit;
- WebSocket cleanup after the last disconnected in-flight handler settles.

Explicit deletion and rollback callers will continue calling `clearSession`
without the option and therefore remove all state.

## Error Handling and Boundaries

No new asynchronous cleanup or timers are introduced. Expiration remains lazy,
matching current behavior: recording a rejection removes expired entries and
reconnect replay skips expired entries. The existing 100-record per-session cap
is unchanged.

Viewer and runtime-running guards remain unchanged. Connected viewers keep the
full store, and a restarted runtime still prevents inactive eviction.

## Testing

- Registry tests prove preserving clear retains only unexpired rejections,
  resets all unrelated state, and still removes history-retry cooldowns.
- Domain tests prove a failed draft survives preserving clear and is replayed
  with its text, attachments, session id, failure state, and error.
- Lifecycle tests reproduce the crash interleaving by pausing repository work,
  recording a failed message during the pause, then completing exit cleanup and
  reconnecting.
- WebSocket tests prove immediate and deferred inactive disconnect cleanup use
  preserving clear.
- Existing default-clear tests protect destructive deletion semantics.

This is backend-only and requires no UI screenshots.
