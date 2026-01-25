# Claude Code CLI: Complete Technical Reference

## Table of Contents
1. [Streaming JSON Protocol](#1-streaming-json-protocol)
2. [The ClaudeJson Data Model](#2-the-claudejson-data-model)
3. [The STDIO Permission Prompt Tool](#3-the-stdio-permission-prompt-tool-bidirectional-control)
4. [Session Management](#4-session-management)
5. [Complete CLI Flag Reference](#5-complete-cli-flag-reference)
6. [Subagent Tracking (Task Tool)](#6-subagent-tracking-task-tool)
7. [Slash Command Discovery](#7-slash-command-discovery)
8. [CLI Variants and Versioning](#8-cli-variants-and-versioning)
9. [Implementation Notes](#9-implementation-notes)

---

## 1. Streaming JSON Protocol

### Overview

The Claude Code CLI outputs **NDJSON** (Newline-Delimited JSON) when invoked with `--output-format stream-json`. Each line is a complete, self-contained JSON object representing a discrete event in the conversation.

### Basic Invocation

```bash
# Minimal streaming mode
claude -p "your prompt" --output-format stream-json

# Full streaming with partial messages
claude -p "your prompt" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages

# Interactive mode with bidirectional control
claude -p "your prompt" \
  --output-format stream-json \
  --input-format stream-json \
  --permission-prompt-tool stdio \
  --include-partial-messages \
  --verbose
```

### Line-by-Line Processing

```rust
// Rust example
let stdout = child.stdout.take().unwrap();
let reader = BufReader::new(stdout);
let mut lines = reader.lines();

while let Some(line) = lines.next_line().await? {
    let msg: ClaudeJson = serde_json::from_str(&line)?;
    // Process message
}
```

```typescript
// TypeScript example
for await (const line of readline.createInterface({ input: child.stdout })) {
    const msg = JSON.parse(line) as ClaudeJson;
    // Process message
}
```

---

## 2. The ClaudeJson Data Model

The `ClaudeJson` enum represents all possible message types from the CLI. Messages are discriminated by the `type` field.

### Message Type Hierarchy

```
ClaudeJson
├── System        - Initialization, status updates, configuration
├── Assistant     - Model responses with content array
├── User          - User messages (including synthetic ones)
├── ToolUse       - Standalone tool invocation (legacy)
├── ToolResult    - Tool execution result (legacy)
├── StreamEvent   - Real-time streaming deltas
├── Result        - Final conversation result with usage stats
├── ControlRequest   - Permission/hook requests (bidirectional mode)
├── ControlResponse  - Responses to control requests
├── ControlCancelRequest - CLI cancelled a pending request (no response needed)
└── Unknown       - Catch-all for unrecognized messages
```

### 2.1 System Message

Emitted at initialization and for status updates.

```typescript
interface SystemMessage {
    type: "system";
    subtype?: "init" | "status" | "compact_boundary" | string;
    session_id?: string;
    cwd?: string;
    tools?: ToolDefinition[];      // Available tools with schemas
    model?: string;
    apiKeySource?: string;         // "ANTHROPIC_API_KEY" | "oauth" | etc.
    status?: string;               // Status text for "status" subtype
    slash_commands?: string[];     // Available slash commands
    plugins?: Array<{ name: string; path: string }>;
}
```

**System Message Subtypes:**

| Subtype | Description |
|---------|-------------|
| `init` | Initial session setup with tools, model, cwd |
| `status` | Status update during execution (contains `status` field) |
| `compact_boundary` | Marks boundary in compacted conversation history |
| `hook_started` | A hook has begun execution (contains `hook_id`, `hook_name`, `hook_event`) |
| `hook_response` | A hook has completed (contains `exit_code`, `outcome`, `stdout`, `stderr`) |

**Hook System Messages:**

When hooks are configured, the CLI emits `hook_started` and `hook_response` messages:

```json
{
    "type": "system",
    "subtype": "hook_started",
    "hook_id": "6bbbd76a-f466-4642-bb3d-089159e3450b",
    "hook_name": "SessionStart:startup",
    "hook_event": "SessionStart",
    "uuid": "eeb7eff9-a923-4ce7-8e70-fd2d58324ca3",
    "session_id": "2b54dedb-3316-4520-bc86-4a0f7b2d0551"
}
```

```json
{
    "type": "system",
    "subtype": "hook_response",
    "hook_id": "6bbbd76a-f466-4642-bb3d-089159e3450b",
    "hook_name": "SessionStart:startup",
    "hook_event": "SessionStart",
    "output": "",
    "stdout": "",
    "stderr": "",
    "exit_code": 0,
    "outcome": "success",
    "uuid": "ee04e17c-0e03-4fc6-8835-27613b2bfcd7",
    "session_id": "2b54dedb-3316-4520-bc86-4a0f7b2d0551"
}

**Example:**
```json
{
    "type": "system",
    "subtype": "init",
    "session_id": "abc12345-1234-5678-9abc-def012345678",
    "cwd": "/Users/martin/Code/project",
    "model": "claude-sonnet-4-20250514",
    "tools": [...],
    "slash_commands": ["/help", "/clear", "/commit"],
    "plugins": [{"name": "beads", "path": "/path/to/plugin"}]
}
```

### 2.2 Assistant Message

Contains the model's response with structured content.

```typescript
interface AssistantMessage {
    type: "assistant";
    session_id?: string;
    message: ClaudeMessage;
}

interface ClaudeMessage {
    id?: string;              // Message ID (e.g., "msg_01ABC...")
    type?: string;            // Usually "message"
    role: "assistant" | "user";
    model?: string;           // Model that generated this
    content: ClaudeContentItem[] | string;
    stop_reason?: string;     // "end_turn" | "tool_use" | etc.
}
```

**Example:**
```json
{
    "type": "assistant",
    "session_id": "abc12345",
    "message": {
        "id": "msg_01XYZ",
        "role": "assistant",
        "model": "claude-sonnet-4-20250514",
        "content": [
            {"type": "text", "text": "I'll help you with that."},
            {
                "type": "tool_use",
                "id": "toolu_01ABC",
                "name": "Read",
                "input": {"file_path": "/path/to/file.ts"}
            }
        ],
        "stop_reason": "tool_use"
    }
}
```

### 2.3 Content Items

The `content` array in messages contains these item types:

```typescript
type ClaudeContentItem =
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: object }
    | { type: "tool_result"; tool_use_id: string; content: ToolResultContent; is_error?: boolean };

// tool_result content can be a string, array of text items, or array with images
type ToolResultContent =
    | string                                    // Plain text or JSON string
    | Array<TextItem | ImageItem>;              // Array of content blocks

type TextItem = { type: "text"; text: string };

type ImageItem = {
    type: "image";
    source: {
        type: "base64";
        data: string;           // Base64-encoded image data
        media_type: string;     // e.g., "image/png", "image/jpeg"
    };
};
```

**Tool Result Content Handling:**

The `content` field in `tool_result` can appear in two formats:

1. **String format** (most common):
   ```json
   { "type": "tool_result", "tool_use_id": "toolu_01ABC", "content": "File contents here..." }
   ```

2. **Array format** (for multi-part results):
   ```json
   { "type": "tool_result", "tool_use_id": "toolu_01ABC", "content": [{"type": "text", "text": "Part 1"}, {"type": "text", "text": "Part 2"}] }
   ```

When parsing, check if `content` is a string or array. For array format, concatenate the text fields (e.g., with `\n\n`). String content may itself be JSON—attempt to parse it if your use case requires structured data.

**Image Content Handling:**

When Claude reads image files (PNG, JPEG, etc.) using the Read tool, the tool_result content includes base64-encoded image data:

```json
{
    "type": "tool_result",
    "tool_use_id": "toolu_01ABC",
    "content": [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "data": "iVBORw0KGgoAAAANSUhEUgAA...",
                "media_type": "image/png"
            }
        }
    ]
}
```

Your UI should:
1. Detect when `content` is an array containing `type: "image"` items
2. Decode the base64 `data` field
3. Render the image using the specified `media_type`

Supported media types include: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.

### 2.4 User Message

User messages, including synthetic ones injected by the system.

```typescript
interface UserMessage {
    type: "user";
    session_id?: string;
    isSynthetic?: boolean;  // true for system-injected messages
    message: ClaudeMessage;
}
```

### 2.5 Stream Events

Real-time streaming with `--include-partial-messages`.

**Important:** When `--include-partial-messages` is enabled, you receive **both** stream events (incremental deltas) **and** final `assistant`/`result` messages. Stream events provide real-time updates as content is generated, while the final messages provide the complete content.

**Recommended Handling:**
- **Stream events**: Use for live UI updates (typing indicators, progressive text display)
- **Final messages**: Use as the authoritative source for persistence and validation

Both can be processed and stored, but if there's any discrepancy, prefer the final `assistant` message content over reconstructed stream event content.

```typescript
interface StreamEventMessage {
    type: "stream_event";
    session_id?: string;
    parent_tool_use_id?: string;  // Set when streaming inside a subagent
    uuid?: string;                // Message UUID for rollback
    event: ClaudeStreamEvent;
}

type ClaudeStreamEvent =
    | { type: "message_start"; message: ClaudeMessage }
    | { type: "content_block_start"; index: number; content_block: ClaudeContentItem }
    | { type: "content_block_delta"; index: number; delta: ContentBlockDelta }
    | { type: "content_block_stop"; index: number }
    | { type: "message_delta"; delta?: MessageDelta; usage?: ClaudeUsage }
    | { type: "message_stop" };

type ContentBlockDelta =
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; thinking: string };

interface MessageDelta {
    stop_reason?: string;
    stop_sequence?: string;
}
```

**Streaming Flow:**
```
message_start
├── content_block_start (index: 0, type: "text")
│   ├── content_block_delta (text_delta: "Hello")
│   ├── content_block_delta (text_delta: " world")
│   └── content_block_stop (index: 0)
├── content_block_start (index: 1, type: "tool_use")
│   └── content_block_stop (index: 1)
├── message_delta (usage: {...})
└── message_stop
```

### 2.6 Result Message

Final message with execution stats:

```typescript
interface ResultMessage {
    type: "result";
    subtype?: "success" | "error";
    session_id?: string;        // Also accepts: sessionId
    isError?: boolean;          // Also accepts: is_error
    durationMs?: number;        // Also accepts: duration_ms
    numTurns?: number;          // Also accepts: num_turns
    result?: any;               // Final text result
    error?: string;             // Error message if failed
    usage?: ClaudeUsage;
    modelUsage?: Record<string, { contextWindow?: number }>;  // Also accepts: model_usage
}

interface ClaudeUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
}
```

**Note:** Field names support both camelCase and snake_case for SDK compatibility (e.g., `isError` and `is_error` are equivalent).

**Example:**
```json
{
    "type": "result",
    "subtype": "success",
    "session_id": "abc12345",
    "durationMs": 15234,
    "numTurns": 5,
    "result": "I've completed the task.",
    "usage": {
        "input_tokens": 12500,
        "output_tokens": 3200,
        "cache_read_input_tokens": 8000
    },
    "modelUsage": {
        "claude-sonnet-4-20250514": {"contextWindow": 200000}
    }
}
```

### 2.7 Tool Data Structures

Complete tool definitions:

```typescript
type ClaudeToolData =
    // File Operations
    | { name: "Read"; input: { file_path: string; offset?: number; limit?: number } }
    | { name: "Write"; input: { file_path: string; content: string } }
    | { name: "Edit"; input: { file_path: string; old_string?: string; new_string?: string; replace_all?: boolean } }
    | { name: "MultiEdit"; input: { file_path: string; edits: Array<{ old_string?: string; new_string?: string }> } }
    | { name: "UndoEdit"; input: { path?: string; steps?: number } }
    | { name: "NotebookEdit"; input: { notebook_path: string; new_source: string; edit_mode: string; cell_id?: string } }

    // Search & Navigation
    | { name: "Glob"; input: { pattern: string; path?: string; limit?: number } }
    | { name: "Grep"; input: { pattern: string; path?: string; output_mode?: string } }
    | { name: "LS"; input: { path: string } }
    | { name: "CodebaseSearchAgent"; input: { query?: string; path?: string; include?: string[]; exclude?: string[]; limit?: number } }

    // Execution
    | { name: "Bash"; input: { command: string; description?: string; timeout?: number } }
    | { name: "Task"; input: { subagent_type?: string; description?: string; prompt?: string } }

    // Web
    | { name: "WebFetch"; input: { url: string; prompt?: string } }
    | { name: "WebSearch"; input: { query: string; num_results?: number } }

    // Task Management
    | { name: "TodoWrite"; input: { todos: Array<{ content: string; status: string; priority?: string }> } }
    | { name: "TodoRead"; input: {} }

    // Planning & Interaction
    | { name: "ExitPlanMode"; input: { plan: string } }
    | { name: "AskUserQuestion"; input: { questions: Question[] } }

    // Utilities (may vary by environment)
    | { name: "Oracle"; input: { task?: string; files?: string[]; context?: string } }
    | { name: "Mermaid"; input: { code: string } }

    // MCP tools use the pattern: mcp__<server>__<tool>
    | { name: string; input: Record<string, unknown> };
```

**Note:** Tool availability may vary between Claude Code versions and environments. The `Oracle`, `Mermaid`, and `CodebaseSearchAgent` tools are extensions that may not be present in all installations.

---

## 3. The STDIO Permission Prompt Tool (Bidirectional Control)

The most powerful feature for programmatic control. Enable with:

```bash
claude -p "prompt" \
    --output-format stream-json \
    --input-format stream-json \
    --permission-prompt-tool stdio \
    --include-partial-messages
```

### 3.1 Protocol Overview

This creates a **bidirectional JSON-line protocol**:

- **stdout** (CLI → SDK): Normal streaming messages + control requests
- **stdin** (SDK → CLI): Control responses + user messages + SDK commands

**Initialization Timing:** The SDK can send messages to stdin immediately after spawning the process—there is no need to wait for the `system` init message from stdout. The CLI buffers stdin and processes messages as they arrive. The typical sequence is:

1. SDK spawns CLI process
2. SDK immediately sends: `initialize` → `set_permission_mode` → `user` message
3. CLI asynchronously sends `system` init on stdout (timing varies)
4. CLI processes the user message and begins streaming responses

The `system` init and SDK messages are not synchronized; they arrive independently on their respective pipes.

### 3.2 Permission Modes

```typescript
type PermissionMode =
    | "default"           // Ask permission for each tool
    | "acceptEdits"       // Auto-accept file edits
    | "plan"              // Planning mode - manual review before execution
    | "bypassPermissions" // Auto-approve everything
```

### 3.3 Tools Without Permission Prompts

In `default` mode, the following read-only tools are **auto-approved** and will NOT trigger `can_use_tool` requests:

| Tool | Description |
|------|-------------|
| `Glob` | File pattern matching |
| `Grep` | Content search |
| `Read` | File reading |
| `NotebookRead` | Reading Jupyter notebooks |
| `Task` | Subagent creation |
| `TodoWrite` | Todo list updates |
| `TodoRead` | Todo list reading |

All other tools (especially `Bash`, `Write`, `Edit`, `WebFetch`) will trigger permission requests in `default` mode.

### 3.4 SDK → CLI Messages

#### Initialize (Required First Message)

```typescript
interface InitializeRequest {
    type: "control_request";
    request_id: string;  // UUID
    request: {
        subtype: "initialize";
        hooks?: {
            PreToolUse?: Array<{
                matcher?: string;           // Regex pattern for tool names
                hookCallbackIds: string[];  // Callback identifiers
            }>;
            Stop?: Array<{
                hookCallbackIds: string[];
            }>;
        };
    };
}
```

**Example with Plan Mode Hooks:**
```json
{
    "type": "control_request",
    "request_id": "550e8400-e29b-41d4-a716-446655440000",
    "request": {
        "subtype": "initialize",
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "^ExitPlanMode$",
                    "hookCallbackIds": ["tool_approval"]
                },
                {
                    "matcher": "^(?!ExitPlanMode$).*",
                    "hookCallbackIds": ["AUTO_APPROVE_CALLBACK_ID"]
                }
            ],
            "Stop": [
                {"hookCallbackIds": ["STOP_GIT_CHECK_CALLBACK_ID"]}
            ]
        }
    }
}
```

**Initialize Response:**

The CLI responds to `initialize` with a success message containing useful metadata:

```json
{
    "type": "control_response",
    "response": {
        "subtype": "success",
        "request_id": "init-001",
        "response": {
            "commands": [
                {
                    "name": "compact",
                    "description": "Clear conversation history but keep a summary in context.",
                    "argumentHint": "<optional custom summarization instructions>"
                }
            ],
            "output_style": "default",
            "available_output_styles": ["default", "Explanatory", "Learning"],
            "models": [
                {
                    "value": "default",
                    "displayName": "Default (recommended)",
                    "description": "Opus 4.5 · Most capable for complex work"
                },
                {
                    "value": "sonnet",
                    "displayName": "Sonnet",
                    "description": "Sonnet 4.5 · Best for everyday tasks"
                }
            ],
            "account": {
                "email": "user@example.com",
                "organization": "User's Organization",
                "subscriptionType": "Claude Max"
            }
        }
    }
}
```

| Field | Description |
|-------|-------------|
| `commands` | Available slash commands with descriptions and argument hints |
| `output_style` | Current output style setting |
| `available_output_styles` | List of available output styles |
| `models` | Available model options with display names and descriptions |
| `account` | User account information (email, organization, subscription) |

#### Set Permission Mode

```typescript
interface SetPermissionModeRequest {
    type: "control_request";
    request_id: string;
    request: {
        subtype: "set_permission_mode";
        mode: PermissionMode;
    };
}
```

#### Send User Message

```typescript
interface UserMessageRequest {
    type: "user";
    message: {
        role: "user";
        content: string;
    };
}
```

#### Interrupt

```typescript
interface InterruptRequest {
    type: "control_request";
    request_id: string;
    request: {
        subtype: "interrupt";
    };
}
```

### 3.5 CLI → SDK Control Requests

#### CanUseTool Request

When the CLI needs permission to execute a tool:

```typescript
interface CanUseToolRequest {
    type: "control_request";
    request_id: string;
    request: {
        subtype: "can_use_tool";
        tool_name: string;
        input: Record<string, unknown>;
        tool_use_id?: string;              // IMPORTANT: Links to the tool_use content block
        permission_suggestions?: PermissionUpdate[];
        blocked_paths?: string;
    };
}

interface PermissionUpdate {
    type: "setMode" | "addRules" | "removeRules" | "clearRules";
    mode?: PermissionMode;
    destination?: "session" | "userSettings" | "projectSettings" | "localSettings";
    rules?: Array<{ tool_name: string; rule_content?: string }>;
    behavior?: string;
    directories?: string[];
}
```

**About `permission_suggestions`:**

The `permission_suggestions` field provides hints from the CLI about how the user might want to update their permission settings (e.g., "always allow npm install commands"). These are **suggestions for UI display only**—the SDK is not required to persist them.

**Open Question:** The intended workflow for `permission_suggestions` is not fully documented. Current implementations typically ignore this field. If you want to support "remember this choice" functionality, you would:
1. Display the suggestion to the user alongside the approval prompt
2. If the user accepts, include the suggestion in `updatedPermissions` in your allow response
3. The CLI will persist the rule to the specified `destination`

```typescript
```

**Important:** The `tool_use_id` field connects this permission request to the specific `tool_use` content block in the assistant's message. Use this to:
- Match approval responses to specific tool invocations
- Track which tools have been approved/denied
- Build UI that shows pending approvals

**Timing Guarantee:** The `can_use_tool` request arrives **after** the corresponding `tool_use` content block has been streamed via `content_block_start`. This means your SDK can safely look up the tool_use details by ID when the permission request arrives. If `tool_use_id` is not present (rare/legacy), consider auto-approving or logging a warning.

**Example:**
```json
{
    "type": "control_request",
    "request_id": "request-123",
    "request": {
        "subtype": "can_use_tool",
        "tool_name": "Bash",
        "input": {
            "command": "npm install lodash",
            "description": "Install lodash package"
        },
        "tool_use_id": "toolu_01ABC",
        "permission_suggestions": [
            {
                "type": "addRules",
                "toolName": "Bash",
                "ruleContent": "npm install *",
                "behavior": "allow",
                "destination": "localSettings"
            }
        ]
    }
}
```

#### HookCallback Request

For PreToolUse and Stop hooks:

```typescript
interface HookCallbackRequest {
    type: "control_request";
    request_id: string;
    request: {
        subtype: "hook_callback";
        callback_id: string;
        input: HookCallbackInput;
        tool_use_id?: string;
    };
}

interface HookCallbackInput {
    session_id: string;
    transcript_path: string;      // Path to session JSONL file
    cwd: string;                  // Current working directory
    permission_mode: string;      // Current permission mode
    hook_event_name: string;      // "PreToolUse" | "Stop" | etc.
    tool_name?: string;           // For PreToolUse hooks
    tool_input?: Record<string, unknown>;  // For PreToolUse hooks
    tool_use_id?: string;         // For PreToolUse hooks
    stop_hook_active?: boolean;   // For Stop hooks
}
```

**Example (PreToolUse hook):**
```json
{
    "type": "control_request",
    "request_id": "ccbe3752-64c9-4be6-9ee8-afed89a116e4",
    "request": {
        "subtype": "hook_callback",
        "callback_id": "tool_approval",
        "input": {
            "session_id": "7f9ce4b8-b9fd-48e4-8f92-24f81d780210",
            "transcript_path": "/Users/martin/.claude/projects/-Users-martin-Code-project/7f9ce4b8.jsonl",
            "cwd": "/Users/martin/Code/project",
            "permission_mode": "default",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {
                "command": "echo hello",
                "description": "Print hello to the terminal"
            },
            "tool_use_id": "toolu_01JfiC8Xktjdoe7cUucSrajd"
        },
        "tool_use_id": "toolu_01JfiC8Xktjdoe7cUucSrajd"
    }
}
```

**Note:** The `transcript_path` field provides the full path to the session's JSONL file, which can be useful for reading conversation history or debugging.

**Example (Stop hook for git check):**
```json
{
    "type": "control_request",
    "request_id": "request-456",
    "request": {
        "subtype": "hook_callback",
        "callback_id": "STOP_GIT_CHECK_CALLBACK_ID",
        "input": {
            "session_id": "abc123",
            "transcript_path": "/path/to/session.jsonl",
            "cwd": "/project",
            "permission_mode": "default",
            "hook_event_name": "Stop",
            "stop_hook_active": false
        }
    }
}
```

### 3.6 SDK → CLI Control Responses

#### Allow Tool Execution

```typescript
interface AllowResponse {
    type: "control_response";
    response: {
        subtype: "success";
        request_id: string;
        response: {
            behavior: "allow";
            updatedInput?: Record<string, unknown>;  // Modified tool input
            updatedPermissions?: PermissionUpdate[];
        };
    };
}
```

**Example (allow and switch to bypass mode):**
```json
{
    "type": "control_response",
    "response": {
        "subtype": "success",
        "request_id": "request-123",
        "response": {
            "behavior": "allow",
            "updatedInput": {"command": "npm install lodash"},
            "updatedPermissions": [
                {
                    "type": "setMode",
                    "mode": "bypassPermissions",
                    "destination": "session"
                }
            ]
        }
    }
}
```

#### Deny Tool Execution

```typescript
interface DenyResponse {
    type: "control_response";
    response: {
        subtype: "success";
        request_id: string;
        response: {
            behavior: "deny";
            message: string;
            interrupt?: boolean;
        };
    };
}
```

**Example:**
```json
{
    "type": "control_response",
    "response": {
        "subtype": "success",
        "request_id": "request-123",
        "response": {
            "behavior": "deny",
            "message": "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said: This command is too dangerous.",
            "interrupt": false
        }
    }
}
```

#### Hook Callback Responses

**IMPORTANT:** PreToolUse and Stop hooks use **different response formats**.

**PreToolUse Hook Response:**

Uses `hookSpecificOutput` with permission decision:

```typescript
interface PreToolUseHookResponse {
    hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "allow" | "deny" | "ask";  // "ask" forwards to can_use_tool
        permissionDecisionReason?: string;
    };
}
```

```json
{
    "type": "control_response",
    "response": {
        "subtype": "success",
        "request_id": "request-456",
        "response": {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Auto-approved by SDK"
            }
        }
    }
}
```

**Stop Hook Response:**

Uses `decision`/`reason` fields (completely different format):

```typescript
interface StopHookResponse {
    decision: "approve" | "block";
    reason?: string;  // Required when decision is "block"
}
```

```json
{
    "type": "control_response",
    "response": {
        "subtype": "success",
        "request_id": "request-789",
        "response": {
            "decision": "block",
            "reason": "There are uncommitted changes. Please stage and commit them now."
        }
    }
}
```

**Note:** The `"ask"` permission decision in PreToolUse hooks causes the CLI to send a subsequent `can_use_tool` control request, allowing you to inspect the tool input before making a final allow/deny decision.

**Hook → can_use_tool Flow:**
```
1. Claude attempts to use a tool
2. CLI checks PreToolUse hooks, finds a match
3. CLI sends hook_callback request to SDK
4. SDK responds with permissionDecision: "ask"
5. CLI sends can_use_tool request to SDK
6. SDK makes final allow/deny decision
7. Tool executes (if allowed) or Claude receives denial message
```

This two-step flow allows hooks to filter which tools need approval while delegating the actual approval decision to a separate system.

### 3.7 Complete Bidirectional Flow Example

```
SDK                                      CLI
 │                                        │
 ├──── initialize (with hooks) ─────────►│
 │                                        │
 ├──── set_permission_mode(plan) ───────►│
 │                                        │
 ├──── user message ("Fix the bug") ────►│
 │                                        │
 │◄──── system (init) ───────────────────┤
 │◄──── stream_event (message_start) ────┤
 │◄──── stream_event (text_delta) ───────┤
 │◄──── stream_event (tool_use: Read) ───┤
 │                                        │
 │◄──── hook_callback (PreToolUse) ──────┤
 ├──── response (allow) ────────────────►│
 │                                        │
 │◄──── assistant (with tool_use) ───────┤
 │◄──── user (tool_result) ──────────────┤
 │                                        │
 │◄──── can_use_tool (Bash: npm test) ───┤
 ├──── response (deny: "too risky") ────►│
 │                                        │
 │◄──── stream_event (error handling) ───┤
 │◄──── result (success) ────────────────┤
 │                                        │
```

### 3.8 Message Queuing Behavior

**Important:** User messages sent while Claude is actively responding are **queued by the CLI**, not rejected. The queued message will be executed automatically after the current execution completes.

This means:
- The SDK can accept user input at any time without blocking
- Queued messages execute in order after the current turn finishes
- Use the `interrupt` control request if you need to cancel the current execution before sending a new message

**Note:** Message queuing is handled internally by the CLI and is transparent to the SDK. There is no acknowledgment protocol—the SDK simply writes messages to stdin, and the CLI buffers them. The SDK does not need to implement its own queuing logic.

**Open Question:** There is no documented limit on the number of queued messages, nor is there feedback if a message was queued vs. processed immediately.

---

## 4. Session Management

### 4.1 Session ID Lifecycle

Sessions are identified by UUIDs and stored as JSONL files:

```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

**Session ID Extraction:**
- **Skip `system` messages** for session ID extraction—the session may not be initialized yet, and `system` messages may not contain a valid session_id
- Extract from the **first** `assistant`, `user`, `tool_use`, `tool_result`, or `result` message that contains a `session_id` field
- When forking a session with `--fork-session --resume`, the **new** session ID appears in these messages, not the original session ID you passed to `--resume`
- Extract only once per session—after the first valid session_id is received, ignore subsequent values

```typescript
function extractSessionId(msg: ClaudeJson): string | undefined {
    // Explicitly skip system and stream_event messages
    if (msg.type === "system" || msg.type === "stream_event") {
        return undefined;  // Session not yet available in these message types
    }
    return msg.session_id;
}
```

### 4.2 Session Operations

#### Continue Most Recent Session (`-c`)

```bash
claude -c -p "follow-up question" --output-format stream-json
```

Continues the most recent session in the current directory.

#### Resume Specific Session (`--resume`)

```bash
claude --resume "abc12345-1234-5678-9abc-def012345678" \
    -p "continue from where we left off" \
    --output-format stream-json
```

#### Fork Session (`--fork-session --resume`)

Creates a new branch from an existing session:

```bash
claude --fork-session --resume "abc12345" \
    -p "try a different approach" \
    --output-format stream-json
```

**Important:** The new session ID is **not immediately available** when forking. The original session ID is passed to the CLI, but the new forked session ID arrives asynchronously in:
- The `system` message with `subtype: "init"`
- Subsequent `assistant`, `user`, or `result` messages via the `session_id` field

Your SDK should update its session tracking when it receives the new ID.

### 4.3 Message UUID for Rollback

When using the SDK, `stream_event` messages with `type: "assistant"` include a `uuid` field:

```json
{
    "type": "stream_event",
    "session_id": "abc12345",
    "uuid": "msg_01XYZ789",
    "event": {
        "type": "message_start",
        "message": {...}
    }
}
```

This UUID can be used with the SDK's `resumeSessionAt` option to rollback to a specific message point.

### 4.4 Session JSONL Format

Each session file contains one JSON object per line:

```jsonl
{"type":"system","subtype":"init","session_id":"abc123","cwd":"/project","timestamp":"2025-01-25T10:00:00Z"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"session_id":"abc123"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]},"session_id":"abc123"}
{"type":"result","subtype":"success","session_id":"abc123","durationMs":1234}
```

### 4.5 Graceful Shutdown

To gracefully terminate a CLI session:

1. **Send an interrupt control request:**
```json
{
    "type": "control_request",
    "request_id": "interrupt-001",
    "request": {
        "subtype": "interrupt"
    }
}
```

2. **Wait for graceful exit** (recommended: 5 seconds timeout)

3. **Force kill if necessary** - send SIGKILL to the process if it doesn't exit within the timeout

```typescript
// Example graceful shutdown sequence
async function shutdownCli(process: ChildProcess, protocol: Protocol) {
    // Step 1: Send interrupt
    await protocol.sendInterrupt();

    // Step 2: Wait for graceful exit (5 second timeout)
    const exitPromise = new Promise(resolve => process.on('exit', resolve));
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 5000));

    const result = await Promise.race([exitPromise, timeoutPromise]);

    // Step 3: Force kill if still running
    if (process.exitCode === null) {
        process.kill('SIGKILL');
    }
}
```

**Note:** The CLI does NOT have a heartbeat mechanism. Monitor the process via:
- Process exit status polling (recommended: every 250ms)
- EOF detection on stdout
- IO error handling on read operations

**Interrupt and Pending Approvals:** When you send an `interrupt` control request, the CLI will attempt to stop gracefully. However, the CLI may send `control_cancel_request` messages for any pending approval requests. Your SDK should handle these cancellations and clean up any pending approval state. If you don't receive explicit cancellations, pending approval requests will simply never receive tool results—the CLI will exit before processing them.

---

## 5. Complete CLI Flag Reference

### Core Flags

| Flag | Type | Description |
|------|------|-------------|
| `-p <prompt>` | String | User prompt (required in print mode) |
| `-c` | Boolean | Continue most recent session |
| `--resume <id>` | String | Resume specific session by ID |
| `--fork-session` | Boolean | Fork from resumed session |
| `--model <model>` | String | Model override (e.g., "opus", "sonnet") |
| `--system-prompt <text>` | String | Custom system prompt |

### Output Control

| Flag | Type | Description |
|------|------|-------------|
| `--output-format stream-json` | Enum | Enable NDJSON streaming output |
| `--verbose` | Boolean | Include verbose logging |
| `--include-partial-messages` | Boolean | Stream content deltas |

### Input Control

| Flag | Type | Description |
|------|------|-------------|
| `--input-format stream-json` | Enum | Accept JSON on stdin |
| `--permission-prompt-tool stdio` | String | Route permission prompts to stdin/stdout |

### Permission Control

| Flag | Type | Description |
|------|------|-------------|
| `--permission-mode <mode>` | Enum | Initial mode: default, acceptEdits, plan, bypassPermissions |
| `--dangerously-skip-permissions` | Boolean | Auto-approve all tools |
| `--disallowedTools <tool>` | String | Disable specific tools (e.g., `AskUserQuestion`) |

### Limits

| Flag | Type | Description |
|------|------|-------------|
| `--max-turns <n>` | Number | Maximum conversation turns |

### Typical Invocation Patterns

**Autonomous Mode (no interaction):**
```bash
claude -p "task" \
    --output-format stream-json \
    --verbose \
    --dangerously-skip-permissions
```

**Plan Mode (review before execution):**
```bash
claude -p "task" \
    --output-format stream-json \
    --input-format stream-json \
    --permission-prompt-tool stdio \
    --permission-mode plan \
    --include-partial-messages
```

**Approval Mode (approve each dangerous tool):**
```bash
claude -p "task" \
    --output-format stream-json \
    --input-format stream-json \
    --permission-prompt-tool stdio \
    --permission-mode default \
    --include-partial-messages
```

**Session Follow-up:**
```bash
claude --fork-session --resume "$SESSION_ID" \
    -p "continue" \
    --output-format stream-json \
    --input-format stream-json \
    --permission-prompt-tool stdio
```

---

## 6. Subagent Tracking (Task Tool)

When Claude dispatches a subagent using the `Task` tool, the streaming events include a `parent_tool_use_id` field that links the subagent's output back to the parent task.

### 6.1 Task Tool Structure

```typescript
interface TaskToolInput {
    // Core fields (always present)
    subagent_type?: string;   // e.g., "Explore", "Plan", "Bash", "general-purpose"
    description?: string;     // Short description (3-5 words)
    prompt?: string;          // Detailed task prompt

    // Extended fields (may vary by CLI version)
    model?: string;           // Optional model override ("sonnet", "opus", "haiku")
    max_turns?: number;       // Maximum API round-trips
    run_in_background?: boolean;
    resume?: string;          // Agent ID to resume previous execution
}
```

**Note:** The core fields (`subagent_type`, `description`, `prompt`) are universally supported. Extended fields like `model`, `max_turns`, `run_in_background`, and `resume` may not be available in all CLI versions or implementations.

**Example Task tool_use:**
```json
{
    "type": "tool_use",
    "id": "toolu_01TASK123",
    "name": "Task",
    "input": {
        "subagent_type": "Explore",
        "description": "Find auth handlers",
        "prompt": "Search the codebase for authentication handling code..."
    }
}
```

### 6.2 Subagent Stream Events

Stream events from subagents include the `parent_tool_use_id` linking back to the Task:

```json
{
    "type": "stream_event",
    "session_id": "main-session-id",
    "parent_tool_use_id": "toolu_01TASK123",
    "event": {
        "type": "content_block_start",
        "index": 0,
        "content_block": {"type": "text", "text": ""}
    }
}
```

```json
{
    "type": "stream_event",
    "parent_tool_use_id": "toolu_01TASK123",
    "event": {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": "Searching for auth handlers..."}
    }
}
```

### 6.3 Nested Tool Calls (Composite IDs)

When a subagent uses tools (e.g., Explore agent calling Read), those tool calls can be tracked using composite IDs:

```typescript
// Helper to create composite toolCallId: "parentId:childId" or just "childId"
const makeCompositeId = (originalId: string, parentId: string | null): string => {
    if (parentId) return `${parentId}:${originalId}`
    return originalId
}

// Example: "toolu_01TASK123:toolu_01READ456"
```

**Note:** The `parent_tool_use_id` field from the CLI is a **flat reference to the immediate parent only**—it does not chain (no grandparent references). For nested subagents (e.g., a Task agent that spawns another Task agent), each level only knows its direct parent.

**Nested Subagent Example:**
```
Main Agent
└── Task (toolu_01PARENT) spawns Explore agent
    └── Task (toolu_01CHILD) spawns another agent
        └── Read (toolu_01GRANDCHILD)
```

In this case, the Read tool's stream events will have `parent_tool_use_id: "toolu_01CHILD"`, NOT a chain like `"toolu_01PARENT:toolu_01CHILD"`. The SDK must construct composite IDs if the UI needs full ancestry tracking.

**Nested tool call example:**
```json
{
    "type": "stream_event",
    "parent_tool_use_id": "toolu_01TASK123",
    "event": {
        "type": "content_block_start",
        "index": 1,
        "content_block": {
            "type": "tool_use",
            "id": "toolu_01READ456",
            "name": "Read"
        }
    }
}
```

The UI can track this as `toolu_01TASK123:toolu_01READ456` to show the Read call nested under the Task.

### 6.4 Token Usage Attribution

When `parent_tool_use_id` is present, token usage from `message_delta` events should NOT be counted toward the main conversation's context usage - it belongs to the subagent:

```typescript
// From vibe-kanban's implementation
ClaudeJson::StreamEvent { event, parent_tool_use_id, .. } => {
    if let ClaudeStreamEvent::MessageDelta { usage, .. } = event {
        // Only count tokens for main conversation, not subagents
        if parent_tool_use_id.is_none() {
            if let Some(usage) = usage {
                self.context_tokens_used = calculate_tokens(usage);
            }
        }
    }
}
```

### 6.5 Subagent Result

The subagent's final result appears as a `tool_result` in a user message:

```json
{
    "type": "user",
    "session_id": "main-session-id",
    "message": {
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "tool_use_id": "toolu_01TASK123",
                "content": "Subagent completed. Found 15 files matching pattern...",
                "is_error": false
            }
        ]
    }
}
```

### 6.6 Subagent Types

Common subagent types used with the Task tool:

| Type | Description |
|------|-------------|
| `Explore` | Fast codebase exploration - file search, grep, reading |
| `Plan` | Software architect for designing implementation plans |
| `Bash` | Command execution specialist |
| `general-purpose` | Full-featured agent for complex multi-step tasks |

### 6.7 Background Agents

When `run_in_background: true`, the Task returns immediately with an output file path:

```json
{
    "type": "tool_result",
    "tool_use_id": "toolu_01TASK123",
    "content": {
        "status": "running",
        "output_file": "/tmp/agent-output-abc123.txt",
        "message": "Agent running in background. Check output_file for results."
    }
}
```

The main conversation can continue while the background agent works. Use Read tool or Bash with `tail -f` to monitor progress.

### 6.8 Resuming Agents

Agents can be resumed using the `resume` parameter:

```json
{
    "name": "Task",
    "input": {
        "resume": "agent-id-from-previous-run",
        "prompt": "Continue from where you left off"
    }
}
```

The agent continues with its full previous context preserved.

---

## 7. Slash Command Discovery

The CLI supports dynamic discovery of available slash commands.

### 7.1 Discovery Invocation

To discover available slash commands, invoke the CLI with a single `/` character and limit to 1 turn:

```bash
claude -p "/" \
    --verbose \
    --output-format stream-json \
    --max-turns 1
```

### 7.2 Discovery Response

The system init message includes available slash commands:

```json
{
    "type": "system",
    "subtype": "init",
    "slash_commands": [
        "/help",
        "/clear",
        "/compact",
        "/commit",
        "/review-pr",
        "/beads:create",
        "/beads:list"
    ],
    "plugins": [
        {"name": "beads", "path": "/Users/martin/.claude/plugins/beads"}
    ]
}
```

### 7.3 Slash Command Execution

When a user sends a slash command as a message (e.g., `/cost`), the CLI handles it locally and injects the result as a synthetic `user` message:

```json
{
    "type": "user",
    "message": {
        "role": "user",
        "content": "<local-command-stdout>Command output here</local-command-stdout>"
    },
    "session_id": "0c576519-3887-4794-9bdf-84d298b8b806",
    "isReplay": true
}
```

**Key Fields:**
- `isReplay: true` indicates this is a synthetic message injected by the CLI, not a real user message
- The command output is wrapped in `<local-command-stdout>` tags
- Slash commands do NOT go through Claude's tool system—they execute locally

**UI Handling:**
1. Detect messages with `isReplay: true`
2. Parse the `<local-command-stdout>` content for display
3. Consider rendering these differently from normal user messages (e.g., as system output)

### 7.4 Caching Recommendations

Slash command discovery requires spawning a CLI process. Cache the results and refresh:
- On session start
- When plugin configuration changes
- Periodically (e.g., every 5 minutes)

---

## 8. CLI Variants and Versioning

### 8.1 Standard CLI

```bash
npx -y @anthropic-ai/claude-code@<version>
```

Or if installed globally:
```bash
claude
```

### 8.2 Claude Code Router (Optional)

Some environments use a router variant that provides additional features:

```bash
npx -y @musistudio/claude-code-router@<version> code
```

The router provides the same streaming protocol but may route requests through different backends.

### 8.3 Version Checking

```bash
claude --version
```

---

## 9. Implementation Notes

This section covers practical details discovered from real-world SDK implementations.

### 9.1 Error Handling & Recovery

#### Early Process Failure Detection

The CLI can fail to start for various reasons:
- `npx` not found or npm not installed
- Invalid package version specified
- Authentication failure (invalid API key, OAuth issues)
- Network issues preventing package download

**Detection:** Failures are typically caught when:
1. `spawn()` fails immediately (returns error)
2. stdout/stdin handles cannot be acquired
3. Process exits immediately with EOF on stdout

**Recommendation:** Use `kill_on_drop(true)` (or equivalent) and detect failures by checking if stdout/stdin handles are available immediately after spawn. Check stderr for diagnostic messages on early exit.

**Open Question:** The CLI does not document specific exit codes for different failure modes. Rely on stderr content and EOF detection rather than exit code semantics.

#### Process Crash Detection

The CLI can terminate unexpectedly during execution. Detect this via:
- **EOF on stdout** - the readline stream ends
- **Process exit polling** - check `process.exitCode` periodically (recommended: every 250ms)
- **IO errors** - catch and handle read errors on stdout

```typescript
// Example crash detection
reader.on('close', () => {
    if (process.exitCode !== 0) {
        handleCrash(process.exitCode);
    }
});

// Periodic exit polling
const pollInterval = setInterval(() => {
    if (process.exitCode !== null) {
        clearInterval(pollInterval);
        handleExit(process.exitCode);
    }
}, 250);
```

#### JSON Parse Errors

Malformed JSON lines can occasionally occur. The recommended approach is to **log and skip** them rather than treating them as fatal errors:

```typescript
for await (const line of reader) {
    // Always log the raw line first (useful for debugging)
    logRawOutput(line);

    try {
        const msg = JSON.parse(line) as ClaudeJson;
        handleMessage(msg);
    } catch (e) {
        // Skip malformed lines - they may be debug output or partial writes
        console.warn('Failed to parse JSON line:', line, e);
    }
}
```

This approach ensures that occasional malformed output (e.g., from debug logging or race conditions) doesn't crash your SDK while still capturing the raw output for debugging.

#### Stderr Handling

The CLI writes to stderr for errors, warnings, and some debug output. Stderr may contain ANSI escape codes for terminal formatting. Recommended handling:

```typescript
// Strip ANSI codes and log stderr as error/warning messages
const stderrReader = readline.createInterface({ input: child.stderr });
for await (const line of stderrReader) {
    const cleanLine = stripAnsiCodes(line);
    if (cleanLine.trim()) {
        logError(cleanLine);
    }
}
```

Stderr output is informational—it should be logged but doesn't require programmatic responses. Consider batching stderr lines with a short time window (e.g., 2 seconds) to group related output together.

#### Error Message Formats

Errors can appear in multiple forms:
- **Result message with error:** `{ type: "result", subtype: "error", error: "..." }`
- **Result with isError flag:** `{ type: "result", isError: true, error: "..." }`
- **Mid-stream errors:** JSON parse failures on individual lines

### 9.2 Control Request Timeouts

**Critical:** The CLI does NOT timeout while waiting for control responses. Your SDK must implement its own timeout handling.

```typescript
interface PendingApproval {
    requestId: string;
    timeoutAt: Date;
    resolve: (response: ControlResponse) => void;
    reject: (error: Error) => void;
}

// Track pending approvals with timeout
const pendingApprovals = new Map<string, PendingApproval>();

async function waitForApproval(requestId: string, timeoutMs: number): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
        const timeoutAt = new Date(Date.now() + timeoutMs);

        pendingApprovals.set(requestId, { requestId, timeoutAt, resolve, reject });

        // Set up timeout
        setTimeout(() => {
            const pending = pendingApprovals.get(requestId);
            if (pending) {
                pendingApprovals.delete(requestId);
                reject(new Error('Approval timeout'));
            }
        }, timeoutMs);
    });
}
```

### 9.3 Multiple Pending Requests

In theory, multiple `can_use_tool` requests could be pending simultaneously if Claude invokes multiple tools in a single response. Track them independently by `request_id`. However, in practice, the CLI typically waits for each approval before sending the next request, so a serial processing approach (handling one request at a time) works reliably:

```typescript
// Use a Map to track multiple pending approvals
const pendingApprovals = new Map<string, PendingApproval>();

// Each request has a unique ID
function handleCanUseTool(request: CanUseToolRequest) {
    pendingApprovals.set(request.request_id, {
        toolName: request.request.tool_name,
        input: request.request.input,
        toolUseId: request.request.tool_use_id,
    });

    // Show approval UI for this specific request
    showApprovalUI(request.request_id);
}
```

### 9.4 CLI Readiness

There is **no explicit ready signal** from the CLI. Send the `initialize` message immediately after spawning the process:

```typescript
const process = spawn('claude', args);

// Don't wait for any ready signal - send immediately
await sendInitialize(process.stdin, {
    hooks: { /* ... */ }
});

// Then send the user message
await sendUserMessage(process.stdin, prompt);
```

### 9.5 Unknown Request IDs

If you send a `control_response` with an unknown `request_id`, it will be **silently ignored** by the CLI. Ensure your SDK tracks request IDs properly.

### 9.6 ControlCancelRequest Handling

The CLI may send a `control_cancel_request` message when it decides to abandon a pending tool use before receiving your response:

```json
{
    "type": "control_cancel_request",
    "request_id": "request-123"
}
```

**Known Triggers:**
- SDK sends an `interrupt` control request
- CLI encounters an internal error or state change

**Open Question:** The complete set of triggers for `control_cancel_request` is not fully documented. Context overflow, Claude changing its mind mid-response, or other internal CLI states may also trigger this message.

**No response is required.** Your SDK should:
1. Remove the request from any pending approval tracking
2. Cancel any UI prompts waiting for user input
3. Continue processing other messages normally

If you've already sent a response for a cancelled request, it will be silently ignored.

**Note:** If the CLI exits without sending explicit `control_cancel_request` messages (e.g., after an interrupt), pending approval requests will simply never receive responses. Your SDK should implement timeout handling for pending approvals rather than relying solely on cancellation messages.

### 9.7 Message Ordering

Message order is **guaranteed**. The CLI writes messages sequentially to stdout, and your line-by-line reader will receive them in order. The expected streaming sequence is:

```
message_start
├── content_block_start (index: 0)
│   ├── content_block_delta (multiple)
│   └── content_block_stop (index: 0)
├── content_block_start (index: 1)
│   └── content_block_stop (index: 1)
├── message_delta (with usage)
└── message_stop
```

### 9.8 Buffer and Size Limits

There are **no documented size limits** for stdin messages. The CLI uses standard line-buffered I/O. However, extremely large messages (e.g., multi-megabyte tool results) may cause performance issues. Consider chunking large content.

### 9.9 AskUserQuestion Handling

If your UI needs to handle `AskUserQuestion` tool calls, you have two options:

1. **Disable it** with `--disallowedTools=AskUserQuestion` and handle user interaction through the approval system
2. **Allow it** and implement the full flow as described below

Most SDK implementations disable `AskUserQuestion` and use the bidirectional control protocol for all user interaction.

**Full AskUserQuestion Flow (if enabled):**

`AskUserQuestion` appears as a normal `tool_use` content block in an `assistant` message:

```json
{
    "type": "assistant",
    "message": {
        "role": "assistant",
        "content": [
            {
                "type": "tool_use",
                "id": "toolu_01Gw5AXQp4WDshZrzQ4eWdKf",
                "name": "AskUserQuestion",
                "input": {
                    "questions": [
                        {
                            "question": "What is your favorite color?",
                            "header": "Color",
                            "options": [
                                {"label": "Red", "description": "A warm, vibrant color"},
                                {"label": "Blue", "description": "A cool, calming color"},
                                {"label": "Green", "description": "A natural, refreshing color"}
                            ],
                            "multiSelect": false
                        }
                    ]
                }
            }
        ]
    }
}
```

**Input Schema:**
```typescript
interface AskUserQuestionInput {
    questions: Array<{
        question: string;        // The question text
        header: string;          // Short label (max 12 chars)
        options: Array<{
            label: string;       // Option display text (1-5 words)
            description: string; // Explanation of the option
        }>;
        multiSelect: boolean;    // Allow multiple selections
    }>;
}
```

**Responding to AskUserQuestion:**

The user's response must be sent as a `user` message containing a `tool_result`:

```json
{
    "type": "user",
    "message": {
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "tool_use_id": "toolu_01Gw5AXQp4WDshZrzQ4eWdKf",
                "content": "{\"answers\":{\"0\":\"Blue\"}}"
            }
        ]
    }
}
```

The `content` is a JSON string with an `answers` object mapping question indices to selected option labels. For `multiSelect: true`, provide an array of labels.

**Note:** Without bidirectional mode (`--permission-prompt-tool stdio`), `AskUserQuestion` will fail with an error because there's no way to collect the user's response.

---

This documentation provides a complete reference for programmatically controlling the Claude Code CLI, including the full streaming protocol, bidirectional control, session management, subagent tracking, slash command discovery, and practical implementation guidance.
