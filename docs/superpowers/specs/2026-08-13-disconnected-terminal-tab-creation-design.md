# Disconnected Terminal Tab Creation Design

## Problem

`TerminalPanel` creates a pending local tab before asking the terminal WebSocket to create its PTY. The terminal channel uses the `drop` queue policy, so a create request sent while disconnected is discarded and can never correlate a server terminal ID back to that tab. When the connection returns, the pending tab also makes terminal-list restoration return early, hiding every existing server terminal until the user closes the orphaned tab.

## Decision

`TerminalPanel.handleNewTab` will return immediately when `connected` is false. The guard will run before generating a request ID, recording pending correlation state, updating tabs, changing the active tab, or sending the create request. Both creation entry points—the imperative panel ref and the inline new-tab callback—already use this handler, so one boundary protects all callers.

The existing terminal-list rule will remain unchanged. It still prevents duplicate tabs during ordinary reconnects, while the creation guard ensures a disconnected click cannot introduce the invalid pending state that defeats restoration.

## Alternatives Considered

1. Queue create requests until reconnection. This conflicts with the terminal channel's deliberate `drop` policy and would require cancellation and duplicate-delivery semantics for stale UI actions.
2. Merge server terminals into any local pending tabs during restoration. This treats the orphaned state after it has already been created and cannot safely determine whether an uncorrelated pending tab represents a live request.
3. Ignore new-tab requests while disconnected. This is selected because it prevents the invalid state at its source and preserves the existing reconnect behavior.

## Tests

A focused `TerminalPanel` regression test will render the panel disconnected, invoke the public `createNewTerminal` API, and verify that no local tab or create request is produced. It will then deliver a server terminal list and verify that the existing terminal is restored, covering the user-visible failure described by issue #2158.

The existing reconnecting-banner test currently creates its initial tab while already disconnected, which relies on the bug. It will instead create a valid terminal while connected, rerender after disconnection, and continue asserting that the warning is shown for an existing terminal.

## Scope

This change does not alter WebSocket queueing, terminal-list reconciliation, reconnect controls, tab styling, or backend behavior. It adds no new visual state, so a UI screenshot would not materially demonstrate the fix.
