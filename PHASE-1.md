# Phase 1: MCP Infrastructure & Mail System

## Overview
Build the MCP (Model Context Protocol) server infrastructure with tool registry, permission enforcement, mail communication system, and decision logging. Copy necessary tmux-web code for terminal integration.

## Goals
- MCP server with tool registry and permission system
- Mail communication tools (`mcp__mail__*`)
- Agent introspection tools (`mcp__agent__*`)
- Decision logging infrastructure (automatic and manual)
- System tools (`mcp__system__*`)
- tmux-web code integration for terminal viewing
- Mock agent testing capability

## Dependencies
- Phase 0 must be complete (database, clients, resource accessors)

## Implementation Steps

### 1. MCP Server Foundation
- [ ] Create `src/backend/routers/mcp/` directory
- [ ] Create `src/backend/routers/mcp/server.ts`:
  - [ ] Initialize MCP server
  - [ ] Create tool registry (map of tool name → handler function)
  - [ ] Create tool execution wrapper with logging
  - [ ] Export MCP server instance
- [ ] Create `src/backend/routers/mcp/types.ts`:
  - [ ] Define `McpToolContext` type (contains `agentId`)
  - [ ] Define `McpToolResponse` type (success/error format)
  - [ ] Define `McpToolHandler` type signature
  - [ ] Define tool permission configuration types

### 2. Tool Permission System
- [ ] Create `src/backend/routers/mcp/permissions.ts`:
  - [ ] Define `AGENT_TOOL_PERMISSIONS` constant:
    - [ ] ORCHESTRATOR allowed/disallowed tools
    - [ ] SUPERVISOR allowed/disallowed tools
    - [ ] WORKER allowed/disallowed tools
  - [ ] Implement `matchPattern(toolName, pattern)` - Wildcard matching
  - [ ] Implement `checkToolPermissions(agentType, toolName)`:
    - [ ] Check disallowed list first
    - [ ] Check allowed list second
    - [ ] Return permission result with error message
- [ ] Test: Write test script to verify permission checks work correctly

### 3. Tool Execution Infrastructure
- [ ] Update `src/backend/routers/mcp/server.ts`:
  - [ ] Implement `executeMcpTool(agentId, toolName, toolInput)`:
    - [ ] Fetch agent from database
    - [ ] Check tool permissions for agent type
    - [ ] Log tool invocation to DecisionLog (before execution)
    - [ ] Execute tool handler from registry
    - [ ] Log tool result to DecisionLog (after execution)
    - [ ] Handle errors and return structured error response
    - [ ] Update agent `lastHeartbeat` on successful tool call
  - [ ] Implement automatic retry logic for transient errors
  - [ ] Implement error escalation (to supervisor or human)
- [ ] Create `src/backend/routers/mcp/errors.ts`:
  - [ ] Define `CRITICAL_TOOLS` list
  - [ ] Implement `escalateToolFailure(agent, toolName, error)`
  - [ ] Implement `escalateCriticalError(agent, toolName, error)`
  - [ ] Implement `isTransientError(error)` for retry logic

### 4. Mail Tools Implementation
- [ ] Create `src/backend/routers/mcp/mail.mcp.ts`
- [ ] Implement `mcp__mail__list_inbox`:
  - [ ] Get current agent ID from context
  - [ ] Query unread mail for agent using mail accessor
  - [ ] Return formatted mail list with count
  - [ ] Log decision
- [ ] Implement `mcp__mail__read`:
  - [ ] Validate mail ID exists and belongs to agent
  - [ ] Mark mail as read using mail accessor
  - [ ] Return mail details
  - [ ] Log decision
- [ ] Implement `mcp__mail__send`:
  - [ ] Validate input (toAgentId or toHuman required)
  - [ ] Create mail record using mail accessor
  - [ ] Update sender's `lastHeartbeat`
  - [ ] Log decision
  - [ ] Fire `mail.sent` Inngest event
  - [ ] Return mail ID and timestamp
- [ ] Implement `mcp__mail__reply`:
  - [ ] Fetch original mail by ID
  - [ ] Extract recipient from original mail (sender becomes recipient)
  - [ ] Create reply mail with reference to original
  - [ ] Log decision
  - [ ] Return mail ID
- [ ] Register all mail tools in MCP tool registry
- [ ] Test: Use mock agent to send/receive mail

### 5. Agent Introspection Tools
- [ ] Create `src/backend/routers/mcp/agent.mcp.ts`
- [ ] Implement `mcp__agent__get_status`:
  - [ ] Get agent ID from context
  - [ ] Fetch agent details from database
  - [ ] Return agent status (type, state, lastHeartbeat, tmuxSession)
  - [ ] Log decision
- [ ] Implement `mcp__agent__get_task`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is a WORKER (return error otherwise)
  - [ ] Fetch task details via task accessor
  - [ ] Return task details (id, title, description, state, epicId, worktreeName, prUrl)
  - [ ] Log decision
- [ ] Implement `mcp__agent__get_epic`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR or WORKER (return error otherwise)
  - [ ] If SUPERVISOR: fetch epic from agent.epicId
  - [ ] If WORKER: fetch task → epic via relations
  - [ ] Return epic details (id, title, description, design, state, worktreeName)
  - [ ] Log decision
- [ ] Register all agent introspection tools in registry
- [ ] Test: Create mock agents and verify introspection works

### 6. System Tools Implementation
- [ ] Create `src/backend/routers/mcp/system.mcp.ts`
- [ ] Implement `mcp__system__log_decision`:
  - [ ] Get agent ID from context
  - [ ] Create decision log entry with provided title and body
  - [ ] Return log ID
- [ ] Register system tools in registry
- [ ] Test: Mock agent can manually log decisions

### 7. Decision Logging Enhancement
- [ ] Update decision log accessor:
  - [ ] Add `createAutomatic(agentId, toolName, type, data)` - For automatic MCP tool logging
  - [ ] Add `createManual(agentId, title, body)` - For manual business logic logging
  - [ ] Add `findByAgentIdRecent(agentId, limit)` - Get recent logs for specific agent
  - [ ] Add `findAllRecent(limit)` - Get recent logs across all agents
- [ ] Create helper functions for log formatting:
  - [ ] `formatToolUse(toolName, input)` - Format tool invocation log
  - [ ] `formatToolResult(toolName, output)` - Format tool result log
  - [ ] `formatToolError(toolName, error)` - Format tool error log
- [ ] Test: Verify logs are created correctly with proper formatting

### 8. tmux-web Code Integration
- [ ] Read `~/Programming/tmux-web` repository to understand structure
- [ ] Create `src/backend/clients/terminal.client.ts`:
  - [ ] Copy node-pty integration code
  - [ ] Implement `attachToTmuxSession(sessionName)` - Attach to existing tmux session
  - [ ] Implement `readSessionOutput(sessionName)` - Read session buffer
  - [ ] Implement WebSocket handler for real-time terminal updates
- [ ] Create `src/frontend/components/tmux-terminal.tsx`:
  - [ ] Copy xterm.js integration code
  - [ ] Implement terminal component with WebSocket connection
  - [ ] Add resize handling
  - [ ] Add scrollback support
- [ ] Install required dependencies:
  - [ ] `node-pty` for backend
  - [ ] `xterm` and `xterm-addon-fit` for frontend
  - [ ] WebSocket library (e.g., `ws`)
- [ ] Test: Manually attach to a tmux session and view output in browser

### 9. MCP Server Endpoint
- [ ] Update `src/backend/index.ts`:
  - [ ] Add MCP endpoint: `POST /mcp/execute`
  - [ ] Extract agent ID from request (via auth header or session)
  - [ ] Extract tool name and input from request body
  - [ ] Call `executeMcpTool(agentId, toolName, input)`
  - [ ] Return tool response as JSON
- [ ] Add error handling middleware for MCP endpoint
- [ ] Test: Send test MCP tool calls via curl or Postman

### 10. Mock Agent Testing Utilities
- [ ] Create `src/backend/testing/` directory
- [ ] Create `src/backend/testing/mock-agent.ts`:
  - [ ] `createMockAgent(type)` - Create test agent in database
  - [ ] `sendMcpTool(agentId, toolName, input)` - Send tool call as mock agent
  - [ ] `getMcpToolResponse(agentId, toolName, input)` - Get tool response
  - [ ] `cleanupMockAgent(agentId)` - Delete mock agent and related data
- [ ] Create test scenarios:
  - [ ] Mock worker sends mail to mock supervisor
  - [ ] Mock supervisor reads inbox
  - [ ] Mock worker gets task details (fail case - no task)
  - [ ] Permission denied scenarios (worker tries orchestrator tool)
- [ ] Test: Run all mock agent scenarios and verify behavior

### 11. Inngest Event Handlers (Basic)
- [ ] Create `src/backend/inngest/functions/mail-sent.ts`:
  - [ ] Handle `mail.sent` event
  - [ ] Log event to console (for now)
  - [ ] Future: Trigger notifications here
- [ ] Register mail-sent handler with Inngest client
- [ ] Update Inngest serve endpoint in backend server
- [ ] Test: Send mail via MCP tool and verify event fires

### 12. Error Handling & Validation
- [ ] Add input validation for all MCP tools:
  - [ ] Validate required fields are present
  - [ ] Validate field types match expectations
  - [ ] Validate agent permissions match tool requirements
  - [ ] Return clear error messages for invalid inputs
- [ ] Add error logging for all MCP tool failures
- [ ] Test: Send invalid inputs and verify error responses

### 13. Documentation
- [ ] Create `docs/MCP_TOOLS.md`:
  - [ ] Document all mail tools with examples
  - [ ] Document all agent introspection tools with examples
  - [ ] Document system tools with examples
  - [ ] Document tool permission system
  - [ ] Document decision logging architecture
- [ ] Update `README.md` with MCP server usage instructions
- [ ] Add code comments to all MCP tool implementations

## Smoke Test Checklist

Run these tests manually to validate Phase 1 completion:

- [ ] **MCP Server**: Server starts without errors
- [ ] **Tool Registry**: All mail/agent/system tools are registered
- [ ] **Permission System**: Worker cannot call orchestrator tools (returns error)
- [ ] **Mail Send**: Mock agent can send mail to another agent
- [ ] **Mail List**: Mock agent can list inbox and see unread mail
- [ ] **Mail Read**: Mock agent can read mail and mark as read
- [ ] **Mail Reply**: Mock agent can reply to received mail
- [ ] **Agent Status**: Mock agent can get own status
- [ ] **Task Introspection**: Mock worker with task can get task details
- [ ] **Epic Introspection**: Mock supervisor with epic can get epic details
- [ ] **Decision Logging**: All tool calls appear in DecisionLog table
- [ ] **Manual Logging**: Can use `mcp__system__log_decision` to log custom entries
- [ ] **Error Handling**: Invalid tool calls return structured error responses
- [ ] **Heartbeat Update**: Agent `lastHeartbeat` updates after successful tool call
- [ ] **Inngest Event**: `mail.sent` event fires when mail is sent
- [ ] **tmux-web Integration**: Can view tmux session output in browser component

## Success Criteria

- [ ] All smoke tests pass
- [ ] All mail tools work correctly with mock agents
- [ ] All agent introspection tools work correctly
- [ ] Permission system blocks unauthorized tool access
- [ ] Decision logs are created automatically for all tool calls
- [ ] Can view tmux session in browser using terminal component
- [ ] Inngest events fire correctly
- [ ] Error responses are consistent and informative

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 1 complete: MCP infrastructure and mail system"
git tag phase-1-complete
```

## Notes

- This phase focuses on infrastructure - no real agents yet, only mock agents for testing
- tmux-web code should be copied and adapted, not linked as a dependency
- Decision logging happens automatically for all MCP tool calls
- Mail system is the foundation for all agent-to-agent communication

## Next Phase

Phase 2 will implement the Worker agent with Claude SDK integration, using the MCP tools built in this phase.
