# Claude Code Executor Implementation Guide

A comprehensive guide for implementing a robust Claude Code CLI executor with bidirectional protocol support, process group management, and approval workflows.

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Dependencies](#2-dependencies)
3. [Type Definitions](#3-type-definitions)
4. [Command Building](#4-command-building)
5. [Process Spawning](#5-process-spawning)
6. [I/O Management](#6-io-management)
7. [Bidirectional Protocol](#7-bidirectional-protocol)
8. [Permission & Approval Handling](#8-permission--approval-handling)
9. [Hook System](#9-hook-system)
10. [Process Monitoring & Termination](#10-process-monitoring--termination)
11. [Error Handling](#11-error-handling)
12. [Session Management](#12-session-management)
13. [Complete Implementation Example](#13-complete-implementation-example)

---

## 1. Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Application                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Executor   │    │  Container   │    │ Approval Service │  │
│  │  (ClaudeCode)│    │   Service    │    │   (Optional)     │  │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘  │
│         │                   │                      │            │
│         │ spawn()           │ manage lifecycle     │ approve()  │
│         ▼                   ▼                      ▼            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    SpawnedChild                          │   │
│  │  ┌─────────────┐  ┌────────────┐  ┌─────────────────┐   │   │
│  │  │ AsyncGroup  │  │  Interrupt │  │   Exit Signal   │   │   │
│  │  │   Child     │  │   Sender   │  │   (optional)    │   │   │
│  │  └─────────────┘  └────────────┘  └─────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Claude Code CLI Process                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  stdin (piped)  ◄──────────────────────────  SDK Control Msgs   │
│                                                                  │
│  stdout (piped) ──────────────────────────►  NDJSON + Control   │
│                                                                  │
│  stderr (piped) ──────────────────────────►  Errors/Warnings    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Responsibility |
|-----------|----------------|
| **Executor** | Builds commands, spawns processes, manages protocol |
| **ProtocolPeer** | Handles bidirectional JSON communication |
| **ClaudeAgentClient** | Processes permission requests, delegates to approval service |
| **LogWriter** | Writes output to duplicated stdout pipe |
| **Container Service** | Manages process lifecycle, monitoring, termination |

### Message Flow

```
1. Application calls executor.spawn(prompt)
2. Executor builds command with --permission-prompt-tool=stdio
3. Process spawned with group_spawn() for reliable termination
4. Stdout duplicated: one pipe for protocol, one for logging
5. ProtocolPeer starts async read loop on stdout
6. Initialization sequence sent via stdin (immediately, no waiting):
   a. Initialize { hooks }
   b. SetPermissionMode { mode }
   c. User { message: prompt }
7. CLI sends system init on stdout (timing is async, may arrive before/after step 6)
8. Claude processes prompt, emits NDJSON to stdout
9. When Claude needs permission, sends ControlRequest
10. ProtocolPeer delegates to ClaudeAgentClient
11. Client consults ApprovalService (or auto-approves)
12. Response sent back via stdin
13. Process continues until Result message or interrupt
```

**Important:** Steps 6 and 7 are not synchronized. The SDK sends initialization messages immediately after spawning—there is no need to wait for the system init message from stdout. The CLI buffers stdin appropriately.

---

## 2. Dependencies

### Cargo.toml

```toml
[dependencies]
# Async runtime
tokio = { version = "1", features = ["full", "process", "sync", "io-util", "time"] }
tokio-util = { version = "0.7", features = ["io", "compat"] }

# Process group management (critical for reliable termination)
command-group = { version = "5.0", features = ["with-tokio"] }

# Pipe creation for stdout duplication
os_pipe = "1.2"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Async traits
async-trait = "0.1"
futures = "0.3"

# Error handling
thiserror = "1"

# UUID for request IDs
uuid = { version = "1", features = ["v4", "serde"] }

# Logging
tracing = "0.1"

# Shell command parsing
shlex = "1.3"

# Unix signals (Unix only)
[target.'cfg(unix)'.dependencies]
nix = { version = "0.29", features = ["signal", "process"] }
```

---

## 3. Type Definitions

### 3.1 Executor Configuration

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Main executor configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeExecutorConfig {
    /// Use claude-code-router instead of direct npx
    #[serde(default)]
    pub use_router: bool,

    /// Enable plan mode (requires approval for ExitPlanMode)
    #[serde(default)]
    pub plan_mode: bool,

    /// Enable approval service integration
    #[serde(default)]
    pub approvals_enabled: bool,

    /// Override the model (e.g., "claude-sonnet-4-20250514")
    #[serde(default)]
    pub model: Option<String>,

    /// Skip all permission checks (dangerous)
    #[serde(default)]
    pub dangerously_skip_permissions: bool,

    /// Remove ANTHROPIC_API_KEY from environment
    #[serde(default)]
    pub disable_api_key: bool,

    /// Command overrides
    #[serde(default)]
    pub cmd_overrides: CmdOverrides,
}

/// Command customization options
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CmdOverrides {
    /// Override the base command entirely
    pub base_command_override: Option<String>,

    /// Additional CLI parameters
    pub additional_params: Option<Vec<String>>,

    /// Additional environment variables
    pub env: Option<HashMap<String, String>>,
}

/// Execution environment passed to spawn
#[derive(Debug, Clone, Default)]
pub struct ExecutionEnv {
    pub vars: HashMap<String, String>,
    pub repo_context: RepoContext,
    pub commit_reminder: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RepoContext {
    pub workspace_root: std::path::PathBuf,
    pub repo_names: Vec<String>,
}

impl ExecutionEnv {
    pub fn new(repo_context: RepoContext, commit_reminder: bool) -> Self {
        Self {
            vars: HashMap::new(),
            repo_context,
            commit_reminder,
        }
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.vars.insert(key.into(), value.into());
    }

    pub fn with_overrides(mut self, overrides: &HashMap<String, String>) -> Self {
        self.vars.extend(overrides.clone());
        self
    }

    pub fn apply_to_command(&self, command: &mut tokio::process::Command) {
        for (key, value) in &self.vars {
            command.env(key, value);
        }
    }
}
```

### 3.2 Spawned Child & Signals

```rust
use command_group::AsyncGroupChild;
use tokio::sync::oneshot;

/// Result of process execution
#[derive(Debug, Clone, Copy)]
pub enum ExecutorExitResult {
    Success,
    Failure,
}

/// Signal from executor indicating it's done
pub type ExecutorExitSignal = oneshot::Receiver<ExecutorExitResult>;

/// Signal to request graceful interrupt
pub type InterruptSender = oneshot::Sender<()>;

/// Spawned process with control channels
#[derive(Debug)]
pub struct SpawnedChild {
    /// The process handle (with process group support)
    pub child: AsyncGroupChild,

    /// Executor signals completion (optional)
    pub exit_signal: Option<ExecutorExitSignal>,

    /// Send to request graceful interrupt
    pub interrupt_sender: Option<InterruptSender>,
}

impl From<AsyncGroupChild> for SpawnedChild {
    fn from(child: AsyncGroupChild) -> Self {
        Self {
            child,
            exit_signal: None,
            interrupt_sender: None,
        }
    }
}
```

### 3.3 Permission Modes & Results

```rust
/// Permission checking mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Normal permission checks
    Default,
    /// Auto-approve file edits
    AcceptEdits,
    /// Planning mode (no execution until approved)
    Plan,
    /// Skip all permission checks
    BypassPermissions,
}

/// Result of a permission check
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "behavior", rename_all = "camelCase")]
pub enum PermissionResult {
    Allow {
        #[serde(rename = "updatedInput")]
        updated_input: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none", rename = "updatedPermissions")]
        updated_permissions: Option<Vec<PermissionUpdate>>,
    },
    Deny {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

/// Permission update operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionUpdate {
    #[serde(rename = "type")]
    pub update_type: PermissionUpdateType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<PermissionUpdateDestination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<PermissionRuleValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directories: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionUpdateType {
    SetMode,
    AddRules,
    RemoveRules,
    ClearRules,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionUpdateDestination {
    Session,
    UserSettings,
    ProjectSettings,
    LocalSettings,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRuleValue {
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_content: Option<String>,
}
```

### 3.4 Protocol Messages

```rust
/// Messages received from Claude CLI stdout
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CLIMessage {
    /// Permission/hook request from CLI
    ControlRequest {
        request_id: String,
        request: ControlRequestType,
    },
    /// Response to our control request
    ControlResponse {
        response: ControlResponseType,
    },
    /// CLI cancelled a pending request (no response needed)
    /// This is sent when the CLI abandons a tool use before receiving approval,
    /// e.g., due to interrupt or internal state change. Simply remove from pending.
    ControlCancelRequest {
        request_id: String,
    },
    /// Final result message
    Result(serde_json::Value),
    /// Any other JSON message (assistant, tool_use, etc.)
    #[serde(untagged)]
    Other(serde_json::Value),
}

/// Types of control requests from CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequestType {
    /// Claude wants to use a tool
    CanUseTool {
        tool_name: String,
        input: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        permission_suggestions: Option<Vec<PermissionUpdate>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        blocked_paths: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
    },
    /// Hook callback (PreToolUse, Stop, etc.)
    HookCallback {
        callback_id: String,
        input: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
    },
}

/// Control request sent from SDK to CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SDKControlRequest {
    #[serde(rename = "type")]
    message_type: String,
    pub request_id: String,
    pub request: SDKControlRequestType,
}

impl SDKControlRequest {
    pub fn new(request: SDKControlRequestType) -> Self {
        Self {
            message_type: "control_request".to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            request,
        }
    }
}

/// Types of control requests we send to CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SDKControlRequestType {
    /// Set the permission mode
    SetPermissionMode { mode: PermissionMode },
    /// Initialize with hooks configuration
    Initialize {
        #[serde(skip_serializing_if = "Option::is_none")]
        hooks: Option<serde_json::Value>,
    },
    /// Request graceful interrupt
    Interrupt {},
}

/// Response we send back to CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlResponseMessage {
    #[serde(rename = "type")]
    message_type: String,
    pub response: ControlResponseType,
}

impl ControlResponseMessage {
    pub fn new(response: ControlResponseType) -> Self {
        Self {
            message_type: "control_response".to_string(),
            response,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlResponseType {
    Success {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        response: Option<serde_json::Value>,
    },
    Error {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// User message sent to CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    User { message: UserMessage },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    role: String,
    content: String,
}

impl Message {
    pub fn new_user(content: String) -> Self {
        Self::User {
            message: UserMessage {
                role: "user".to_string(),
                content,
            },
        }
    }
}

/// Response to initialize control request (contains useful metadata)
#[derive(Debug, Clone, Deserialize)]
pub struct InitializeResponse {
    /// Available slash commands with descriptions and argument hints
    pub commands: Vec<SlashCommand>,
    /// Current output style setting
    pub output_style: String,
    /// Available output style options
    pub available_output_styles: Vec<String>,
    /// Available model options
    pub models: Vec<ModelOption>,
    /// User account information
    pub account: AccountInfo,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    /// Hint for command arguments (can be string or array)
    #[serde(rename = "argumentHint")]
    pub argument_hint: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelOption {
    pub value: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountInfo {
    pub email: String,
    pub organization: String,
    #[serde(rename = "subscriptionType")]
    pub subscription_type: String,
}
```

### 3.5 Claude Output Messages

With `--include-partial-messages` enabled (recommended), you receive **both** incremental stream events **and** final messages. Stream events provide real-time deltas for UI updates, while final messages (Assistant, Result) provide complete content for persistence.

**Recommended Usage:**
- Use stream events for live UI updates (typing indicators, progressive rendering)
- Use final `Assistant`/`Result` messages as the authoritative source for persistence
- Both can be stored, but prefer final messages if there's any discrepancy

```rust
/// Parsed NDJSON messages from Claude CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClaudeJson {
    /// System messages for initialization and status updates
    /// Subtypes: "init", "status", "compact_boundary", "hook_started", "hook_response"
    System {
        subtype: Option<String>,
        session_id: Option<String>,
        cwd: Option<String>,
        model: Option<String>,
        // For hook_started/hook_response:
        hook_id: Option<String>,
        hook_name: Option<String>,
        hook_event: Option<String>,
        exit_code: Option<i32>,
        outcome: Option<String>,  // "success" | "error"
        stdout: Option<String>,
        stderr: Option<String>,
    },
    Assistant {
        message: ClaudeMessage,
        session_id: Option<String>,
    },
    User {
        message: ClaudeMessage,
        session_id: Option<String>,
        #[serde(rename = "isReplay")]
        is_replay: Option<bool>,  // true for slash command output
    },
    ToolUse {
        tool_name: String,
        #[serde(flatten)]
        tool_data: serde_json::Value,
        session_id: Option<String>,
    },
    ToolResult {
        result: serde_json::Value,  // Can be string or array - see parsing below
        is_error: Option<bool>,
        session_id: Option<String>,
    },
    Result {
        subtype: Option<String>,
        is_error: Option<bool>,
        duration_ms: Option<u64>,
        session_id: Option<String>,
    },
    #[serde(untagged)]
    Unknown(serde_json::Value),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeMessage {
    pub role: String,
    pub content: serde_json::Value,
}
```

### 3.6 Parsing Tool Result Content

The `content` field in `ToolResult` can be a string, array of text items, or array containing images. Handle all formats:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentItem {
    Text { text: String },
    Image { source: ImageSource },
}

#[derive(Debug, Clone, Deserialize)]
struct ImageSource {
    #[serde(rename = "type")]
    source_type: String,  // "base64"
    data: String,         // Base64-encoded image data
    media_type: String,   // "image/png", "image/jpeg", etc.
}

enum ParsedToolResult {
    Text(String),
    Image { data: Vec<u8>, media_type: String },
    Mixed(Vec<ContentItem>),
}

fn parse_tool_result_content(content: &serde_json::Value) -> ParsedToolResult {
    // Case 1: String content (most common)
    if let Some(s) = content.as_str() {
        return ParsedToolResult::Text(s.to_string());
    }

    // Case 2: Array of content items (text or images)
    if let Ok(items) = serde_json::from_value::<Vec<ContentItem>>(content.clone()) {
        // Check if it's a single image
        if items.len() == 1 {
            if let ContentItem::Image { source } = &items[0] {
                if let Ok(data) = base64::decode(&source.data) {
                    return ParsedToolResult::Image {
                        data,
                        media_type: source.media_type.clone(),
                    };
                }
            }
        }

        // Check if it's all text
        let all_text: Vec<_> = items.iter()
            .filter_map(|item| match item {
                ContentItem::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect();

        if all_text.len() == items.len() {
            return ParsedToolResult::Text(all_text.join("\n\n"));
        }

        // Mixed content
        return ParsedToolResult::Mixed(items);
    }

    // Case 3: Other JSON - serialize back to string
    ParsedToolResult::Text(content.to_string())
}
```

**Image Handling:**

When Claude reads image files (PNG, JPEG, etc.), the tool result contains base64-encoded image data:

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

Your UI should decode and render these images appropriately. Supported media types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.

String content may itself be JSON (e.g., structured tool output). Attempt to parse it if your use case requires structured data.

---

## 4. Command Building

### 4.1 Base Command

```rust
const CLAUDE_CODE_VERSION: &str = "2.1.12";
const CLAUDE_CODE_ROUTER_VERSION: &str = "1.0.66";

fn base_command(use_router: bool) -> String {
    if use_router {
        format!("npx -y @musistudio/claude-code-router@{} code", CLAUDE_CODE_ROUTER_VERSION)
    } else {
        format!("npx -y @anthropic-ai/claude-code@{}", CLAUDE_CODE_VERSION)
    }
}
```

### 4.2 Command Builder

```rust
use std::path::PathBuf;

pub struct CommandBuilder {
    base: String,
    params: Vec<String>,
}

impl CommandBuilder {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into(),
            params: Vec::new(),
        }
    }

    pub fn param(mut self, param: impl Into<String>) -> Self {
        self.params.push(param.into());
        self
    }

    pub fn params<I, S>(mut self, params: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.params.extend(params.into_iter().map(|s| s.into()));
        self
    }

    pub fn override_base(mut self, base: impl Into<String>) -> Self {
        self.base = base.into();
        self
    }

    /// Build into program path and arguments
    pub fn build(self) -> Result<(String, Vec<String>), CommandBuildError> {
        let parts: Vec<String> = shlex::split(&self.base)
            .ok_or_else(|| CommandBuildError::InvalidBase(self.base.clone()))?;

        let mut iter = parts.into_iter();
        let program = iter.next()
            .ok_or(CommandBuildError::EmptyCommand)?;

        let mut args: Vec<String> = iter.collect();
        args.extend(self.params);

        Ok((program, args))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CommandBuildError {
    #[error("Invalid base command: {0}")]
    InvalidBase(String),
    #[error("Empty command after parsing")]
    EmptyCommand,
}
```

### 4.3 Building the Full Command

```rust
impl ClaudeExecutorConfig {
    pub fn build_command(&self) -> Result<CommandBuilder, CommandBuildError> {
        let base = self.cmd_overrides.base_command_override
            .clone()
            .unwrap_or_else(|| base_command(self.use_router));

        let mut builder = CommandBuilder::new(base)
            .param("-p")  // Prompt mode
            .param("--verbose")
            .param("--output-format").param("stream-json")
            .param("--input-format").param("stream-json");

        // Enable bidirectional protocol if needed
        if self.plan_mode || self.approvals_enabled {
            builder = builder
                .param("--permission-prompt-tool").param("stdio")
                .param("--permission-mode").param("bypassPermissions");
        }

        // Model override
        if let Some(ref model) = self.model {
            builder = builder.param("--model").param(model);
        }

        // Skip permissions (dangerous)
        if self.dangerously_skip_permissions {
            builder = builder.param("--dangerously-skip-permissions");
        }

        // Additional params from overrides
        if let Some(ref additional) = self.cmd_overrides.additional_params {
            builder = builder.params(additional.clone());
        }

        Ok(builder)
    }

    pub fn permission_mode(&self) -> PermissionMode {
        if self.plan_mode {
            PermissionMode::Plan
        } else if self.approvals_enabled {
            PermissionMode::Default
        } else {
            PermissionMode::BypassPermissions
        }
    }
}
```

---

## 5. Process Spawning

### 5.1 Spawn Implementation

```rust
use command_group::AsyncCommandGroup;
use std::process::Stdio;
use std::path::Path;
use tokio::process::Command;

impl ClaudeExecutorConfig {
    pub async fn spawn(
        &self,
        working_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
        approval_service: Option<Arc<dyn ApprovalService>>,
    ) -> Result<SpawnedChild, ExecutorError> {
        // Build command
        let (program, args) = self.build_command()?.build()?;

        // Create tokio command
        let mut command = Command::new(&program);
        command
            .args(&args)
            .current_dir(working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("NPM_CONFIG_LOGLEVEL", "error");

        // Apply environment
        env.apply_to_command(&mut command);

        // Apply env overrides
        if let Some(ref overrides) = self.cmd_overrides.env {
            for (k, v) in overrides {
                command.env(k, v);
            }
        }

        // Remove API key if requested
        if self.disable_api_key {
            command.env_remove("ANTHROPIC_API_KEY");
        }

        // Spawn with process group
        let mut child = command.group_spawn()
            .map_err(|e| ExecutorError::Spawn(e.to_string()))?;

        // Extract handles
        let child_stdin = child.inner().stdin.take()
            .ok_or(ExecutorError::Spawn("Failed to get stdin".into()))?;
        let child_stdout = child.inner().stdout.take()
            .ok_or(ExecutorError::Spawn("Failed to get stdout".into()))?;

        // Create interrupt channel
        let (interrupt_tx, interrupt_rx) = tokio::sync::oneshot::channel::<()>();

        // Create stdout pipe for logging
        let log_writer = create_stdout_pipe_writer(&mut child)?;

        // Spawn protocol handler task
        let permission_mode = self.permission_mode();
        let hooks = self.build_hooks(env.commit_reminder);
        let prompt_owned = prompt.to_string();
        let repo_context = env.repo_context.clone();

        tokio::spawn(async move {
            let writer = LogWriter::new(log_writer);
            let client = ClaudeAgentClient::new(writer, approval_service, repo_context);
            let peer = ProtocolPeer::spawn(child_stdin, child_stdout, client, interrupt_rx);

            // Initialize protocol
            if let Err(e) = peer.initialize(hooks).await {
                tracing::error!("Failed to initialize protocol: {}", e);
                return;
            }

            if let Err(e) = peer.set_permission_mode(permission_mode).await {
                tracing::error!("Failed to set permission mode: {}", e);
                return;
            }

            if let Err(e) = peer.send_user_message(prompt_owned).await {
                tracing::error!("Failed to send prompt: {}", e);
            }
        });

        Ok(SpawnedChild {
            child,
            exit_signal: None,
            interrupt_sender: Some(interrupt_tx),
        })
    }
}
```

### 5.2 Follow-Up Spawning (Session Resume)

```rust
impl ClaudeExecutorConfig {
    pub async fn spawn_follow_up(
        &self,
        working_dir: &Path,
        prompt: &str,
        session_id: &str,
        env: &ExecutionEnv,
        approval_service: Option<Arc<dyn ApprovalService>>,
    ) -> Result<SpawnedChild, ExecutorError> {
        // Build base command then add resume flags
        let (program, mut args) = self.build_command()?.build()?;

        // Add session resume flags
        args.extend([
            "--fork-session".to_string(),
            "--resume".to_string(),
            session_id.to_string(),
        ]);

        // Rest of spawn logic is identical...
        // (extracted to shared spawn_internal method in practice)
    }
}
```

---

## 6. I/O Management

### 6.1 Stdout Pipe Duplication

The key insight: we need stdout for both protocol messages AND logging. We solve this by creating a pipe, replacing the child's stdout with the read end, and returning the write end for logging.

```rust
use tokio::io::AsyncWrite;
use tokio::process::ChildStdout;

/// Create a pipe writer that intercepts stdout for logging
pub fn create_stdout_pipe_writer(
    child: &mut AsyncGroupChild,
) -> Result<impl AsyncWrite, ExecutorError> {
    // Create OS pipe
    let (pipe_reader, pipe_writer) = os_pipe::pipe()
        .map_err(|e| ExecutorError::Io(e))?;

    // Replace child's stdout with our pipe reader
    child.inner().stdout = Some(wrap_fd_as_child_stdout(pipe_reader)?);

    // Return the write end as async writer
    wrap_fd_as_tokio_writer(pipe_writer)
}

#[cfg(unix)]
fn wrap_fd_as_child_stdout(
    pipe_reader: os_pipe::PipeReader,
) -> Result<ChildStdout, ExecutorError> {
    use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};

    let raw_fd = pipe_reader.into_raw_fd();
    let owned_fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
    let std_stdout = std::process::ChildStdout::from(owned_fd);
    tokio::process::ChildStdout::from_std(std_stdout)
        .map_err(ExecutorError::Io)
}

#[cfg(unix)]
fn wrap_fd_as_tokio_writer(
    pipe_writer: os_pipe::PipeWriter,
) -> Result<impl AsyncWrite, ExecutorError> {
    use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};

    let raw_fd = pipe_writer.into_raw_fd();
    let owned_fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
    let std_file = std::fs::File::from(owned_fd);
    Ok(tokio::fs::File::from_std(std_file))
}

#[cfg(windows)]
fn wrap_fd_as_child_stdout(
    pipe_reader: os_pipe::PipeReader,
) -> Result<ChildStdout, ExecutorError> {
    use std::os::windows::io::{FromRawHandle, IntoRawHandle, OwnedHandle};

    let raw_handle = pipe_reader.into_raw_handle();
    let owned_handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };
    let std_stdout = std::process::ChildStdout::from(owned_handle);
    tokio::process::ChildStdout::from_std(std_stdout)
        .map_err(ExecutorError::Io)
}

#[cfg(windows)]
fn wrap_fd_as_tokio_writer(
    pipe_writer: os_pipe::PipeWriter,
) -> Result<impl AsyncWrite, ExecutorError> {
    use std::os::windows::io::{FromRawHandle, IntoRawHandle, OwnedHandle};

    let raw_handle = pipe_writer.into_raw_handle();
    let owned_handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };
    let std_file = std::fs::File::from(owned_handle);
    Ok(tokio::fs::File::from_std(std_file))
}
```

### 6.2 Log Writer

```rust
use tokio::io::{AsyncWrite, AsyncWriteExt, BufWriter};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct LogWriter {
    writer: Arc<Mutex<BufWriter<Box<dyn AsyncWrite + Send + Unpin>>>>,
}

impl LogWriter {
    pub fn new(writer: impl AsyncWrite + Send + Unpin + 'static) -> Self {
        Self {
            writer: Arc::new(Mutex::new(BufWriter::new(Box::new(writer)))),
        }
    }

    pub async fn log_raw(&self, raw: &str) -> Result<(), ExecutorError> {
        let mut guard = self.writer.lock().await;
        guard.write_all(raw.as_bytes()).await.map_err(ExecutorError::Io)?;
        guard.write_all(b"\n").await.map_err(ExecutorError::Io)?;
        guard.flush().await.map_err(ExecutorError::Io)?;
        Ok(())
    }
}

impl Clone for LogWriter {
    fn clone(&self) -> Self {
        Self {
            writer: self.writer.clone(),
        }
    }
}
```

---

## 7. Bidirectional Protocol

### 7.1 Protocol Peer

```rust
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::oneshot;
use futures::FutureExt;

#[derive(Clone)]
pub struct ProtocolPeer {
    stdin: Arc<Mutex<ChildStdin>>,
}

impl ProtocolPeer {
    pub fn spawn(
        stdin: ChildStdin,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        interrupt_rx: oneshot::Receiver<()>,
    ) -> Self {
        let peer = Self {
            stdin: Arc::new(Mutex::new(stdin)),
        };

        // Spawn the read loop
        let reader_peer = peer.clone();
        tokio::spawn(async move {
            if let Err(e) = reader_peer.read_loop(stdout, client, interrupt_rx).await {
                tracing::error!("Protocol read loop error: {}", e);
            }
        });

        peer
    }

    async fn read_loop(
        &self,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        interrupt_rx: oneshot::Receiver<()>,
    ) -> Result<(), ExecutorError> {
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut interrupt_rx = interrupt_rx.fuse();

        loop {
            buffer.clear();

            tokio::select! {
                // Read from stdout
                result = reader.read_line(&mut buffer) => {
                    match result {
                        Ok(0) => break,  // EOF
                        Ok(_) => {
                            let line = buffer.trim();
                            if line.is_empty() {
                                continue;
                            }

                            // Log the raw message
                            client.log_message(line).await?;

                            // Parse and handle control messages
                            match serde_json::from_str::<CLIMessage>(line) {
                                Ok(CLIMessage::ControlRequest { request_id, request }) => {
                                    self.handle_control_request(&client, request_id, request).await;
                                }
                                Ok(CLIMessage::ControlCancelRequest { request_id }) => {
                                    // CLI cancelled a pending request - clean up any pending state
                                    // No response is needed or expected
                                    //
                                    // Known triggers: interrupt request, CLI internal state changes
                                    // Open question: full set of triggers is not documented
                                    //
                                    // Note: Don't rely solely on this message for cleanup - the CLI
                                    // may exit without sending cancellations for all pending requests
                                    tracing::debug!("Request {} cancelled by CLI", request_id);
                                    // TODO: Remove from pending_approvals if you're tracking them
                                }
                                Ok(CLIMessage::Result(_)) => {
                                    break;  // Execution complete
                                }
                                _ => {
                                    // Other messages (assistant, tool_use, etc.) - just logged
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!("Error reading stdout: {}", e);
                            break;
                        }
                    }
                }

                // Handle interrupt signal
                _ = &mut interrupt_rx => {
                    if let Err(e) = self.interrupt().await {
                        tracing::debug!("Failed to send interrupt: {}", e);
                    }
                    // Continue reading to capture any final output
                }
            }
        }

        Ok(())
    }

    async fn handle_control_request(
        &self,
        client: &Arc<ClaudeAgentClient>,
        request_id: String,
        request: ControlRequestType,
    ) {
        match request {
            ControlRequestType::CanUseTool {
                tool_name,
                input,
                permission_suggestions,
                tool_use_id,
                ..
            } => {
                match client.on_can_use_tool(tool_name, input, permission_suggestions, tool_use_id).await {
                    Ok(result) => {
                        if let Err(e) = self.send_response(request_id, serde_json::to_value(result).unwrap()).await {
                            tracing::error!("Failed to send permission result: {}", e);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error in on_can_use_tool: {}", e);
                        let _ = self.send_error(request_id, e.to_string()).await;
                    }
                }
            }
            ControlRequestType::HookCallback { callback_id, input, tool_use_id } => {
                match client.on_hook_callback(callback_id, input, tool_use_id).await {
                    Ok(output) => {
                        if let Err(e) = self.send_response(request_id, output).await {
                            tracing::error!("Failed to send hook result: {}", e);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error in on_hook_callback: {}", e);
                        let _ = self.send_error(request_id, e.to_string()).await;
                    }
                }
            }
        }
    }

    async fn send_json<T: serde::Serialize>(&self, message: &T) -> Result<(), ExecutorError> {
        let json = serde_json::to_string(message)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(json.as_bytes()).await.map_err(ExecutorError::Io)?;
        stdin.write_all(b"\n").await.map_err(ExecutorError::Io)?;
        stdin.flush().await.map_err(ExecutorError::Io)?;
        Ok(())
    }

    async fn send_response(&self, request_id: String, response: serde_json::Value) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Success {
            request_id,
            response: Some(response),
        })).await
    }

    async fn send_error(&self, request_id: String, error: String) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Error {
            request_id,
            error: Some(error),
        })).await
    }

    pub async fn send_user_message(&self, content: String) -> Result<(), ExecutorError> {
        self.send_json(&Message::new_user(content)).await
    }

    pub async fn initialize(&self, hooks: Option<serde_json::Value>) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Initialize { hooks })).await
    }

    // Note: The CLI responds to initialize with rich metadata including:
    // - commands: Available slash commands with descriptions
    // - models: Available model options with display names
    // - account: User email, organization, subscription type
    // - available_output_styles: List of output style options
    // See InitializeResponse struct below for full structure

    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::SetPermissionMode { mode })).await
    }

    pub async fn interrupt(&self) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Interrupt {})).await
    }
}
```

---

## 8. Permission & Approval Handling

### 8.1 Approval Service Trait

```rust
use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalStatus {
    Approved,
    Denied { reason: Option<String> },
    Pending,
    TimedOut,
}

#[async_trait]
pub trait ApprovalService: Send + Sync {
    async fn request_tool_approval(
        &self,
        tool_name: &str,
        tool_input: serde_json::Value,
        tool_use_id: &str,
    ) -> Result<ApprovalStatus, ExecutorError>;
}
```

### 8.2 Claude Agent Client

```rust
const TOOL_DENY_PREFIX: &str = "The user doesn't want to proceed with this tool use. \
    The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). \
    To tell you how to proceed, the user said: ";

pub struct ClaudeAgentClient {
    log_writer: LogWriter,
    approvals: Option<Arc<dyn ApprovalService>>,
    auto_approve: bool,
    repo_context: RepoContext,
}

impl ClaudeAgentClient {
    pub fn new(
        log_writer: LogWriter,
        approvals: Option<Arc<dyn ApprovalService>>,
        repo_context: RepoContext,
    ) -> Arc<Self> {
        let auto_approve = approvals.is_none();
        Arc::new(Self {
            log_writer,
            approvals,
            auto_approve,
            repo_context,
        })
    }

    pub async fn on_can_use_tool(
        &self,
        tool_name: String,
        input: serde_json::Value,
        _permission_suggestions: Option<Vec<PermissionUpdate>>,  // See note below
        tool_use_id: Option<String>,
    ) -> Result<PermissionResult, ExecutorError> {
        // NOTE: permission_suggestions are hints for UI display (e.g., "always allow npm install").
        // They are typically ignored by SDK implementations. If you want to support "remember this
        // choice" functionality, display the suggestion to the user and include it in
        // updatedPermissions if accepted.

        // Auto-approve if no approval service
        if self.auto_approve {
            return Ok(PermissionResult::Allow {
                updated_input: input,
                updated_permissions: None,
            });
        }

        // Need tool_use_id for approval tracking
        // The can_use_tool request arrives AFTER the tool_use content block has been streamed,
        // so the tool_use_id should always be available. If missing, log warning and auto-approve.
        let Some(id) = tool_use_id else {
            tracing::warn!("No tool_use_id for tool '{}', auto-approving", tool_name);
            return Ok(PermissionResult::Allow {
                updated_input: input,
                updated_permissions: None,
            });
        };

        // Delegate to approval service
        self.handle_approval(id, tool_name, input).await
    }

    async fn handle_approval(
        &self,
        tool_use_id: String,
        tool_name: String,
        tool_input: serde_json::Value,
    ) -> Result<PermissionResult, ExecutorError> {
        let service = self.approvals.as_ref()
            .ok_or(ExecutorError::ApprovalServiceUnavailable)?;

        let status = service.request_tool_approval(&tool_name, tool_input.clone(), &tool_use_id).await?;

        match status {
            ApprovalStatus::Approved => {
                // Special handling for ExitPlanMode: switch to bypass mode
                if tool_name == "ExitPlanMode" {
                    Ok(PermissionResult::Allow {
                        updated_input: tool_input,
                        updated_permissions: Some(vec![PermissionUpdate {
                            update_type: PermissionUpdateType::SetMode,
                            mode: Some(PermissionMode::BypassPermissions),
                            destination: Some(PermissionUpdateDestination::Session),
                            rules: None,
                            behavior: None,
                            directories: None,
                        }]),
                    })
                } else {
                    Ok(PermissionResult::Allow {
                        updated_input: tool_input,
                        updated_permissions: None,
                    })
                }
            }
            ApprovalStatus::Denied { reason } => {
                Ok(PermissionResult::Deny {
                    message: format!("{}{}", TOOL_DENY_PREFIX, reason.unwrap_or_default()),
                    interrupt: Some(false),
                })
            }
            ApprovalStatus::TimedOut => {
                Ok(PermissionResult::Deny {
                    message: "Approval request timed out".to_string(),
                    interrupt: Some(false),
                })
            }
            ApprovalStatus::Pending => {
                Ok(PermissionResult::Deny {
                    message: "Approval still pending".to_string(),
                    interrupt: Some(false),
                })
            }
        }
    }

    pub async fn on_hook_callback(
        &self,
        callback_id: String,
        input: serde_json::Value,
        _tool_use_id: Option<String>,
    ) -> Result<serde_json::Value, ExecutorError> {
        // Handle well-known callbacks
        match callback_id.as_str() {
            "AUTO_APPROVE_CALLBACK_ID" => {
                Ok(serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                        "permissionDecisionReason": "Auto-approved"
                    }
                }))
            }
            "STOP_GIT_CHECK_CALLBACK_ID" => {
                // Check for uncommitted changes
                if input.get("stop_hook_active").and_then(|v| v.as_bool()).unwrap_or(false) {
                    return Ok(serde_json::json!({"decision": "approve"}));
                }

                let has_changes = check_uncommitted_changes(&self.repo_context).await;
                if has_changes {
                    Ok(serde_json::json!({
                        "decision": "block",
                        "reason": "There are uncommitted changes. Please commit them first."
                    }))
                } else {
                    Ok(serde_json::json!({"decision": "approve"}))
                }
            }
            _ => {
                // Unknown callback - forward to permission system
                if self.auto_approve {
                    Ok(serde_json::json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "allow"
                        }
                    }))
                } else {
                    // Return "ask" to trigger CanUseTool flow
                    Ok(serde_json::json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "ask",
                            "permissionDecisionReason": "Forwarding to approval service"
                        }
                    }))
                }
            }
        }
    }

    pub async fn log_message(&self, line: &str) -> Result<(), ExecutorError> {
        self.log_writer.log_raw(line).await
    }
}

async fn check_uncommitted_changes(repo_context: &RepoContext) -> bool {
    // Implementation depends on your git integration
    // Return true if there are uncommitted changes
    false
}
```

---

## 9. Hook System

### 9.1 Building Hooks Configuration

```rust
impl ClaudeExecutorConfig {
    pub fn build_hooks(&self, commit_reminder: bool) -> Option<serde_json::Value> {
        if !self.plan_mode && !self.approvals_enabled {
            return None;
        }

        let mut hooks = serde_json::Map::new();

        // PreToolUse hooks
        let pre_tool_use_hooks = if self.plan_mode {
            // Plan mode: only ask for ExitPlanMode, auto-approve everything else
            serde_json::json!([
                {
                    "matcher": "^ExitPlanMode$",
                    "hookCallbackIds": ["tool_approval"]
                },
                {
                    "matcher": ".*",
                    "hookCallbackIds": ["AUTO_APPROVE_CALLBACK_ID"]
                }
            ])
        } else {
            // Approval mode: ask for all tools except read-only ones
            serde_json::json!([
                {
                    "matcher": "^(?!(Glob|Grep|NotebookRead|Read|Task|TodoWrite)$).*",
                    "hookCallbackIds": ["tool_approval"]
                }
            ])
        };

        hooks.insert("PreToolUse".to_string(), pre_tool_use_hooks);

        // Stop hooks (commit reminder)
        if commit_reminder {
            hooks.insert("Stop".to_string(), serde_json::json!([
                {
                    "matcher": ".*",
                    "hookCallbackIds": ["STOP_GIT_CHECK_CALLBACK_ID"]
                }
            ]));
        }

        Some(serde_json::Value::Object(hooks))
    }
}
```

### 9.2 Hook Matcher Patterns

| Pattern | Description |
|---------|-------------|
| `^ExitPlanMode$` | Exactly "ExitPlanMode" |
| `.*` | Any tool (catch-all) |
| `^(?!(Glob\|Grep\|Read)$).*` | Any tool except Glob, Grep, Read |
| `^(Bash\|Write\|Edit)$` | Only Bash, Write, or Edit |

### 9.3 Hook Callback Input Structure

When the CLI sends a `hook_callback` request, the `input` field contains rich context:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct HookCallbackInput {
    pub session_id: String,
    pub transcript_path: String,      // Path to session JSONL file
    pub cwd: String,                  // Current working directory
    pub permission_mode: String,      // Current permission mode
    pub hook_event_name: String,      // "PreToolUse" | "Stop" | etc.

    // For PreToolUse hooks:
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub tool_use_id: Option<String>,

    // For Stop hooks:
    pub stop_hook_active: Option<bool>,
}
```

**Example hook_callback request:**
```json
{
    "type": "control_request",
    "request_id": "ccbe3752-64c9-4be6-9ee8-afed89a116e4",
    "request": {
        "subtype": "hook_callback",
        "callback_id": "tool_approval",
        "input": {
            "session_id": "7f9ce4b8-b9fd-48e4-8f92-24f81d780210",
            "transcript_path": "/Users/martin/.claude/projects/.../session.jsonl",
            "cwd": "/Users/martin/Code/project",
            "permission_mode": "default",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "echo hello"},
            "tool_use_id": "toolu_01JfiC8Xktjdoe7cUucSrajd"
        },
        "tool_use_id": "toolu_01JfiC8Xktjdoe7cUucSrajd"
    }
}
```

**Note:** The `transcript_path` provides direct access to the session file, useful for debugging or reading conversation history.

### 9.4 Hook → can_use_tool Flow

When using the `"ask"` permission decision in PreToolUse hooks, the flow is:

```
1. Claude attempts to use a tool (e.g., Bash)
2. CLI matches PreToolUse hook, sends hook_callback request
3. SDK responds with: { "hookSpecificOutput": { "permissionDecision": "ask" } }
4. CLI sends can_use_tool request for the same tool
5. SDK makes final allow/deny decision via approval service
6. Tool executes (if allowed) or Claude receives denial
```

This two-step flow allows hooks to filter which tools need approval while delegating the actual decision to a separate system. The `"ask"` decision effectively says "I need more context before deciding—show me the full can_use_tool request."

---

## 10. Process Monitoring & Termination

### 10.1 Container Service

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;
use std::time::Duration;

pub struct ContainerService {
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<AsyncGroupChild>>>>>,
    interrupt_senders: Arc<RwLock<HashMap<Uuid, InterruptSender>>>,
}

impl ContainerService {
    pub fn new() -> Self {
        Self {
            child_store: Arc::new(RwLock::new(HashMap::new())),
            interrupt_senders: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn register(&self, id: Uuid, mut spawned: SpawnedChild) {
        // Store the child
        self.child_store.write().await
            .insert(id, Arc::new(RwLock::new(spawned.child)));

        // Store interrupt sender if present
        if let Some(sender) = spawned.interrupt_sender.take() {
            self.interrupt_senders.write().await.insert(id, sender);
        }
    }

    pub async fn stop(&self, id: &Uuid) -> Result<(), ExecutorError> {
        // Try graceful interrupt first
        if let Some(sender) = self.interrupt_senders.write().await.remove(id) {
            let _ = sender.send(());  // Signal interrupt

            // Wait for graceful exit (5 seconds)
            if let Some(child_lock) = self.child_store.read().await.get(id).cloned() {
                let graceful = tokio::time::timeout(
                    Duration::from_secs(5),
                    async {
                        let mut child = child_lock.write().await;
                        child.wait().await
                    }
                ).await;

                if graceful.is_ok() {
                    tracing::debug!("Process {} exited gracefully", id);
                    self.child_store.write().await.remove(id);
                    return Ok(());
                }

                tracing::debug!("Graceful shutdown timed out for {}, force killing", id);
            }
        }

        // Force kill
        if let Some(child_lock) = self.child_store.write().await.remove(id) {
            let mut child = child_lock.write().await;
            kill_process_group(&mut child).await?;
        }

        Ok(())
    }
}
```

### 10.2 Signal Escalation

```rust
#[cfg(unix)]
pub async fn kill_process_group(child: &mut AsyncGroupChild) -> Result<(), ExecutorError> {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::{getpgid, Pid};

    if let Some(pid) = child.inner().id() {
        let pgid = getpgid(Some(Pid::from_raw(pid as i32)))
            .map_err(|e| ExecutorError::Kill(e.to_string()))?;

        // Escalating signals: SIGINT → SIGTERM → SIGKILL
        for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
            tracing::info!("Sending {:?} to process group {}", sig, pgid);

            if let Err(e) = killpg(pgid, sig) {
                tracing::warn!("Failed to send {:?}: {}", sig, e);
            }

            // Wait 2 seconds for exit
            tokio::time::sleep(Duration::from_secs(2)).await;

            if child.inner().try_wait().map_err(ExecutorError::Io)?.is_some() {
                tracing::info!("Process exited after {:?}", sig);
                break;
            }
        }
    }

    // Final cleanup
    let _ = child.kill().await;
    let _ = child.wait().await;

    Ok(())
}

#[cfg(windows)]
pub async fn kill_process_group(child: &mut AsyncGroupChild) -> Result<(), ExecutorError> {
    if let Some(pid) = child.inner().id() {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])  // /T kills tree
            .output();
    }

    let _ = child.kill().await;
    let _ = child.wait().await;

    Ok(())
}
```

### 10.3 Interrupt and Pending Approvals

When sending an interrupt, be aware that:

1. The CLI **may** send `ControlCancelRequest` messages for pending approval requests, but this is not guaranteed
2. If no cancellation is received, pending requests will simply never complete—the CLI exits before processing responses
3. Your approval service **must** have timeout handling to avoid indefinite waits
4. In-flight tool executions (e.g., a running Bash command) may or may not be terminated—the CLI sends an interrupt but does not guarantee subprocess cleanup

**Recommended Interrupt Flow:**

```rust
// When interrupt is triggered
async fn handle_interrupt(&self) {
    // Step 1: Send interrupt to CLI
    self.protocol.interrupt().await?;

    // Step 2: Clean up pending approvals immediately (don't wait for ControlCancelRequest)
    // The CLI may or may not send cancellation messages
    self.pending_approvals.clear();

    // Step 3: Wait for graceful exit with timeout (recommended: 5 seconds)
    let graceful = tokio::time::timeout(
        Duration::from_secs(5),
        self.wait_for_exit()
    ).await;

    // Step 4: Force kill if still running
    if graceful.is_err() {
        self.force_kill().await?;
    }
}
```

**Note:** The interrupt is "best effort." Pending approvals may be orphaned if the CLI exits without sending explicit `ControlCancelRequest` messages. Always implement SDK-side timeout handling.

### 10.4 Exit Monitoring

```rust
impl ContainerService {
    pub fn spawn_exit_monitor(&self, id: Uuid) -> oneshot::Receiver<std::process::ExitStatus> {
        let (tx, rx) = oneshot::channel();
        let child_store = self.child_store.clone();

        tokio::spawn(async move {
            loop {
                let child_lock = {
                    let map = child_store.read().await;
                    map.get(&id).cloned()
                };

                if let Some(child_lock) = child_lock {
                    let mut child = child_lock.write().await;
                    match child.inner().try_wait() {
                        Ok(Some(status)) => {
                            let _ = tx.send(status);
                            return;
                        }
                        Ok(None) => {}  // Still running
                        Err(e) => {
                            tracing::error!("Error checking process {}: {}", id, e);
                            return;
                        }
                    }
                } else {
                    return;  // Process not found
                }

                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });

        rx
    }
}
```

---

## 11. Error Handling

### 11.1 Malformed JSON Lines

The stdout read loop should handle malformed JSON gracefully. Log the raw line before parsing, and skip parse failures rather than crashing:

```rust
// In the read loop
match serde_json::from_str::<CLIMessage>(line) {
    Ok(msg) => handle_message(msg),
    Err(e) => {
        // Log and skip - malformed lines can occur occasionally
        tracing::warn!("Failed to parse JSON: {} - line: {}", e, line);
        // Continue processing - this is not fatal
    }
}
```

### 11.2 Stderr Processing

Stderr contains errors, warnings, and debug output. It may include ANSI escape codes. Recommended handling:

```rust
use strip_ansi_escapes::strip_str;

pub async fn process_stderr(stderr: ChildStderr, log_sink: LogWriter) {
    let mut reader = BufReader::new(stderr);
    let mut buffer = String::new();

    while reader.read_line(&mut buffer).await.unwrap_or(0) > 0 {
        let clean_line = strip_str(&buffer);
        if !clean_line.trim().is_empty() {
            log_sink.log_error(&clean_line).await;
        }
        buffer.clear();
    }
}
```

Consider batching stderr lines with a time window (e.g., 2 seconds) to group related output.

### 11.3 Exit Codes

**Open Question:** The CLI does not document specific exit codes for different failure modes. Current implementations typically:
- Detect success/failure via EOF on stdout and the presence of a `Result` message
- Extract exit codes only from Bash tool results (`exitCode` field), not from the CLI process itself
- Rely on stderr content for error diagnostics rather than exit code semantics

For Bash tool results, the exit code is available in the tool_result content:
```json
{ "exitCode": 0, "output": "command output here" }
```

### 11.4 Error Types

```rust
#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("Failed to spawn process: {0}")]
    Spawn(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Command build error: {0}")]
    CommandBuild(#[from] CommandBuildError),

    #[error("Approval service unavailable")]
    ApprovalServiceUnavailable,

    #[error("Failed to kill process: {0}")]
    Kill(String),

    #[error("Executable not found: {0}")]
    ExecutableNotFound(String),
}
```

---

## 12. Session Management

### 12.1 Extracting Session ID

Extract the session ID from the **first non-System message** that contains one. Skip System messages because the session may not be fully initialized yet:

```rust
impl ClaudeJson {
    pub fn session_id(&self) -> Option<&str> {
        match self {
            // Skip System messages - session may not be initialized
            ClaudeJson::System { .. } => None,
            // Skip StreamEvent messages - use final messages instead
            ClaudeJson::StreamEvent { .. } => None,
            // Extract from these message types
            ClaudeJson::Assistant { session_id, .. } => session_id.as_deref(),
            ClaudeJson::User { session_id, .. } => session_id.as_deref(),
            ClaudeJson::ToolUse { session_id, .. } => session_id.as_deref(),
            ClaudeJson::ToolResult { session_id, .. } => session_id.as_deref(),
            ClaudeJson::Result { session_id, .. } => session_id.as_deref(),
            _ => None,
        }
    }
}

// Track extraction state - only extract once per session
let mut session_id_extracted = false;

// In your message processing loop:
if !session_id_extracted {
    if let Some(id) = msg.session_id() {
        store_session_id(id);
        session_id_extracted = true;
    }
}
```

**Important for session forking:** When using `--fork-session --resume <old-session-id>`, the **new** session ID will appear in these messages, not the original session ID you passed to the CLI. Extract once and store it for future follow-up operations.

### 12.2 Session Resume Flags

| Flag | Purpose |
|------|---------|
| `--resume <session_id>` | Continue existing session |
| `--fork-session` | Create new branch from session |
| `-c` / `--continue` | Continue most recent session |

---

## 13. Complete Implementation Example

### 13.1 Minimal Working Example

```rust
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Configure executor
    let config = ClaudeExecutorConfig {
        use_router: false,
        plan_mode: false,
        approvals_enabled: false,  // Auto-approve everything
        model: None,
        dangerously_skip_permissions: false,
        disable_api_key: false,
        cmd_overrides: CmdOverrides::default(),
    };

    // Create execution environment
    let env = ExecutionEnv::new(
        RepoContext {
            workspace_root: std::env::current_dir()?,
            repo_names: vec![],
        },
        false,  // No commit reminder
    );

    // Spawn Claude
    let spawned = config.spawn(
        Path::new("."),
        "Hello! Please list the files in the current directory.",
        &env,
        None,  // No approval service
    ).await?;

    // Wait for completion
    let status = spawned.child.wait().await?;
    println!("Exit status: {:?}", status);

    Ok(())
}
```

### 13.2 With Approval Service

```rust
use std::sync::Arc;

struct MyApprovalService;

#[async_trait]
impl ApprovalService for MyApprovalService {
    async fn request_tool_approval(
        &self,
        tool_name: &str,
        tool_input: serde_json::Value,
        tool_use_id: &str,
    ) -> Result<ApprovalStatus, ExecutorError> {
        println!("Tool '{}' wants to run with input: {}", tool_name, tool_input);
        println!("Approve? (y/n)");

        // In practice, this would be async UI interaction
        Ok(ApprovalStatus::Approved)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = ClaudeExecutorConfig {
        approvals_enabled: true,
        ..Default::default()
    };

    let approval_service: Arc<dyn ApprovalService> = Arc::new(MyApprovalService);

    let env = ExecutionEnv::default();

    let spawned = config.spawn(
        Path::new("."),
        "Please create a file called hello.txt with 'Hello World' in it.",
        &env,
        Some(approval_service),
    ).await?;

    // ... handle spawned process
    Ok(())
}
```

### 13.3 With Container Service

```rust
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let container = ContainerService::new();
    let config = ClaudeExecutorConfig::default();
    let env = ExecutionEnv::default();

    // Spawn and register
    let id = Uuid::new_v4();
    let spawned = config.spawn(Path::new("."), "Hello!", &env, None).await?;
    container.register(id, spawned).await;

    // Monitor for exit
    let exit_rx = container.spawn_exit_monitor(id);

    // Wait for either exit or timeout
    tokio::select! {
        status = exit_rx => {
            println!("Process exited: {:?}", status);
        }
        _ = tokio::time::sleep(Duration::from_secs(60)) => {
            println!("Timeout, stopping process");
            container.stop(&id).await?;
        }
    }

    Ok(())
}
```

---

## Appendix A: CLI Flags Reference

| Flag | Description |
|------|-------------|
| `-p` | Prompt mode (non-interactive) |
| `--output-format stream-json` | NDJSON output |
| `--input-format stream-json` | Accept JSON on stdin |
| `--permission-prompt-tool stdio` | Enable bidirectional protocol |
| `--permission-mode <mode>` | Set initial permission mode |
| `--verbose` | Include extra output |
| `--model <model>` | Override model |
| `--resume <session_id>` | Resume session |
| `--fork-session` | Fork when resuming |
| `-c` / `--continue` | Continue most recent |
| `--dangerously-skip-permissions` | Skip all checks |
| `--disallowedTools <tools>` | Disable specific tools |

## Appendix B: Message Type Reference

| Type | Direction | Purpose |
|------|-----------|---------|
| `system` | CLI→SDK | Init info, session ID |
| `assistant` | CLI→SDK | Claude's responses |
| `user` | CLI→SDK | Echo of user messages |
| `tool_use` | CLI→SDK | Tool invocation |
| `tool_result` | CLI→SDK | Tool output |
| `result` | CLI→SDK | Final result |
| `control_request` | CLI→SDK | Permission/hook request |
| `control_response` | SDK→CLI | Response to request |
| `user` (Message) | SDK→CLI | Send user prompt |
| `user` (synthetic) | CLI→SDK | Slash command output (has `isReplay: true`) |

## Appendix C: Slash Command Output

When the user sends a slash command (e.g., `/cost`), the CLI executes it locally and emits a synthetic `user` message:

```json
{
    "type": "user",
    "message": {
        "role": "user",
        "content": "<local-command-stdout>Command output here</local-command-stdout>"
    },
    "isReplay": true,
    "session_id": "..."
}
```

**Key Fields:**
- `isReplay: true` - Indicates this is a synthetic/replay message, not real user input
- Content wrapped in `<local-command-stdout>` tags

**Handling in UI:**
```rust
fn is_slash_command_output(msg: &ClaudeJson) -> bool {
    match msg {
        ClaudeJson::User { message, .. } => {
            // Check for isReplay flag (may need to add to struct)
            message.content.contains("<local-command-stdout>")
        }
        _ => false,
    }
}

fn extract_command_output(content: &str) -> Option<&str> {
    let start = content.find("<local-command-stdout>")?;
    let end = content.find("</local-command-stdout>")?;
    Some(&content[start + 22..end])
}
```

Render slash command output differently from normal messages (e.g., as system output in a different style).
