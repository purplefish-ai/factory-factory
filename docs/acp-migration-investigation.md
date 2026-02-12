## Investigation Summary

Investigated whether migrating factory-factory to the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/overview/introduction) would reduce maintenance and enable multi-agent support (e.g., OpenAI Codex).

## What is ACP?

ACP is a JSON-RPC 2.0 protocol over stdio that standardizes communication between **code editors** and **coding agents** — like LSP but for AI. Backed by Zed, adopted by JetBrains, with adapters for Claude Code, Codex, Gemini, and Goose.

## Current Architecture

Factory-factory uses a **custom NDJSON protocol** to communicate with the Claude CLI subprocess. This includes:
- 6 permission modes (bypassPermissions, plan, acceptEdits, etc.)
- Hook system (PreToolUse, Stop callbacks)
- Session resume/fork
- Mid-session model and thinking budget changes
- File rewind with dry-run
- Message queueing and ordered delivery
- Resource monitoring

The frontend talks to backend via WebSocket + tRPC — ACP doesn't affect this layer.

## Recommendation: Don't migrate now

### Reasons against

1. **Architectural mismatch** — ACP is designed for editor↔agent communication. Factory-factory is a web-based orchestration platform with workspaces, auto-fix, PR watching, and Kanban. Different paradigm.

2. **Feature gap is massive** — ACP is a least-common-denominator protocol. Factory-factory relies heavily on Claude-specific features (permission modes, hooks, session resume/fork, thinking budget, rewind) that ACP doesn't expose.

3. **Claude Code doesn't natively support ACP** — The [Zed adapter](https://github.com/zed-industries/claude-code-acp) wraps the Claude Agent SDK, not the CLI. There's an [open feature request](https://github.com/anthropics/claude-code/issues/6686) for native support.

4. **ACP is pre-1.0** (v0.10.x) — Spec still evolving, tracking breaking changes is a cost.

5. **Doesn't reduce the maintenance hoped for** — Still need WebSocket/tRPC for frontend. Agent subprocess protocol is only one piece. Would need ACP client implementation + capability negotiation + graceful degradation.

6. **Multi-agent is not just protocol** — Different agents have different tool sets, streaming behaviors, and session semantics. Supporting Codex requires UX work beyond protocol swaps.

### Better path forward

1. **Abstract agent interface internally** — Extract an `AgentDriver` interface from current Claude-specific code. Implement `ClaudeCliDriver` first (refactoring what exists), then add drivers for other agents later.

2. **Watch for native ACP in Claude Code** — When Anthropic ships native support, re-evaluate. The feature gap may shrink.

3. **Consider ACP as additional surface** — Factory-factory could expose an ACP server interface for editor connections (Zed/JetBrains), without replacing the core protocol.

## Key Sources

- [ACP Introduction](https://agentclientprotocol.com/overview/introduction)
- [ACP GitHub](https://github.com/agentclientprotocol/agent-client-protocol) (v0.10.8, 2k+ stars, Apache 2.0)
- [claude-code-acp adapter](https://github.com/zed-industries/claude-code-acp) (Zed's TypeScript wrapper)
- [codex-acp adapter](https://github.com/cola-io/codex-acp) (community Codex bridge)
- [Claude Code ACP feature request](https://github.com/anthropics/claude-code/issues/6686)
- [Zed ACP announcement](https://zed.dev/acp)
- [JetBrains ACP adoption](https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/)
