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
5. Schedule cleanup at the next rejection expiry, pruning payloads as they
   expire and deleting the fresh store when it was never reactivated.

This resets transcript, queue, pending requests, runtime, hydration metadata,
and ordering while retaining only the bounded recovery records. The domain
service will still delete any initial message before forwarding the option.

Both inactivity-eviction call sites will request preservation:

- lifecycle cleanup after manual stop or runtime exit;
- WebSocket cleanup after the last disconnected in-flight handler settles.

Explicit deletion and rollback callers will continue calling `clearSession`
without the option and therefore remove all state. Transient ratchet session
cleanup will perform that destructive clear immediately after its database
delete succeeds, before the shared inactive cleanup runs.

## Error Handling and Boundaries

The registry owns unref'ed expiry timers only for preserved rejection stores.
Each timer is pinned to the exact store instance it was created for. At the next
expiry it prunes expired records, schedules the next expiry when records remain,
and deletes the store only if no caller reactivated that same store. A
reactivated store keeps all newer queue/runtime state while the timer still
removes expired attachment payloads. Full session clears and `clearAllSessions`
cancel their timers.

Reconnect replay retains its existing lazy expiration guard as a second
boundary. The existing 100-record per-session cap is unchanged.

Viewer and runtime-running guards remain unchanged. Connected viewers keep the
full store, and a restarted runtime still prevents inactive eviction.

## Testing

- Registry tests prove preserving clear retains only unexpired rejections,
  resets all unrelated state, removes history-retry cooldowns, releases an
  untouched preservation-only store at expiry, and does not clear a reactivated
  store.
- Domain tests prove a failed draft survives preserving clear and is replayed
  with its text, attachments, session id, failure state, and error.
- Lifecycle tests reproduce the crash interleaving by pausing repository work,
  recording a failed message during the pause, then completing exit cleanup and
  reconnecting. They also prove manual-stop and runtime-exit ratchet deletion
  perform destructive clear after the database delete.
- WebSocket tests prove immediate and deferred inactive disconnect cleanup use
  preserving clear.
- A direct default-clear test protects destructive rejection deletion.

This is backend-only and requires no UI screenshots.
