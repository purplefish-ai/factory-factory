# Claude Code CLI Execution Model

This document describes process lifecycle management patterns for applications that wrap the Claude Code CLI. Based on analysis of two production implementations: **opcode** (Tauri/Rust desktop app) and **vibe-kanban** (Rust server with bidirectional protocol).

## Table of Contents

1. [Process Spawning](#1-process-spawning)
2. [Process Handle Management](#2-process-handle-management)
3. [I/O Management](#3-io-management)
4. [Process Monitoring](#4-process-monitoring)
5. [Termination Strategies](#5-termination-strategies)
6. [Error Recovery](#6-error-recovery)
7. [Concurrency](#7-concurrency)
8. [Resource Cleanup](#8-resource-cleanup)
9. [Bidirectional Protocol Extensions](#9-bidirectional-protocol-extensions)
10. [Architecture Comparison](#10-architecture-comparison)

---

## 1. Process Spawning

### 1.1 Binary Discovery

Before spawning, locate the Claude CLI binary. Common search paths:

```
Priority Order:
1. User-configured path (stored in database/config)
2. `which claude` / `where claude` (system PATH)
3. NVM installations: ~/.nvm/versions/node/*/bin/claude
4. Homebrew: /opt/homebrew/bin/claude, /usr/local/bin/claude
5. Local installations: ~/.local/bin/claude
6. NPM global: npm root -g + /claude
```

**Version Selection**: When multiple installations exist, select the highest semantic version.

### 1.2 Command Construction

**Direct Binary Invocation** (opcode):
```rust
let mut cmd = Command::new("/path/to/claude");
cmd.arg("-p").arg(&prompt)
   .arg("--output-format").arg("stream-json")
   .arg("--verbose")
   .arg("--model").arg(&model);
```

**NPX with Pinned Versions** (vibe-kanban):
```rust
// Pinned version ensures reproducibility
let base = "npx -y @anthropic-ai/claude-code@2.1.12";

// Or with router for custom routing
let base = "npx -y @musistudio/claude-code-router@1.0.66 code";
```

### 1.3 Environment Variables

**Essential Variables to Pass Through**:
```rust
// System essentials
PATH, HOME, USER, SHELL, LANG, LC_*

// Node.js support
NODE_PATH, NVM_DIR, NVM_BIN

// Package managers
HOMEBREW_PREFIX

// Network configuration
HTTP_PROXY, HTTPS_PROXY, NO_PROXY

// API keys
ANTHROPIC_API_KEY  // Can be removed for certain modes
```

**Application-Specific Variables**:
```rust
// vibe-kanban injects context
VK_PROJECT_NAME, VK_PROJECT_ID
VK_TASK_ID, VK_WORKSPACE_ID, VK_WORKSPACE_BRANCH

// Suppress npm noise
NPM_CONFIG_LOGLEVEL=error
```

**Environment Override Precedence** (vibe-kanban):
```rust
// Profile-based environment overrides
pub fn with_profile(self, cmd: &CmdOverrides) -> Self {
    if let Some(ref profile_env) = cmd.env {
        self.with_overrides(profile_env)  // Merge profile vars
    } else {
        self
    }
}

// Apply to command
env.clone()
    .with_profile(&self.cmd)    // Apply profile overrides
    .apply_to_command(&mut command);
```

Precedence order: Base environment → Profile overrides → Command-specific overrides

### 1.4 Stdio Configuration

**Read-Only Mode** (no bidirectional protocol):
```rust
cmd.stdin(Stdio::null())      // No input needed
   .stdout(Stdio::piped())    // Capture output
   .stderr(Stdio::piped());   // Capture errors
```

**Bidirectional Protocol Mode**:
```rust
cmd.stdin(Stdio::piped())     // Send messages/responses
   .stdout(Stdio::piped())    // Read NDJSON + control requests
   .stderr(Stdio::piped());   // Capture errors separately
```

### 1.5 Process Group Management (vibe-kanban only)

For reliable termination of process trees, spawn in a new process group:

```rust
// Using command-group crate (AsyncCommandGroup trait)
use command_group::AsyncCommandGroup;

let mut child = command.group_spawn()?;  // Creates new process group

// Enables killing entire process tree via killpg()
// (Claude may spawn subprocesses like node, bash, etc.)
```

**Note**: opcode uses standard `Command::spawn()` without process groups. Termination relies on direct PID-based killing.

### 1.6 Kill-on-Drop Safety (vibe-kanban only)

```rust
command.kill_on_drop(true);  // Auto-terminate if handle dropped
```

This prevents orphan processes when the parent crashes or panics.

**Note**: opcode does not set `kill_on_drop`. It relies on explicit cleanup via the ProcessRegistry and system kill commands as fallback.

---

## 2. Process Handle Management

### 2.1 Storage Patterns

**Centralized Registry** (recommended for multiple processes):
```rust
pub struct ProcessRegistry {
    // Map execution ID to process handle
    processes: Arc<Mutex<HashMap<i64, ProcessHandle>>>,
}

pub struct ProcessHandle {
    pub info: ProcessInfo,                    // Metadata (pid, name, etc.)
    pub child: Arc<Mutex<Option<Child>>>,     // The actual process
    pub live_output: Arc<Mutex<String>>,      // Output buffer
}
```

**UUID-Keyed Maps** (vibe-kanban pattern):
```rust
pub struct LocalContainerService {
    // Process handles
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<AsyncGroupChild>>>>>,

    // Interrupt channels (one per process)
    interrupt_senders: Arc<RwLock<HashMap<Uuid, InterruptSender>>>,

    // Message/log buffers
    msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
}
```

### 2.2 Handle Lifecycle

```
┌─────────────────┐
│  Process Spawn  │
└────────┬────────┘
         │
         ├─→ Extract PID from child
         ├─→ Wrap in Arc<Mutex<>> or Arc<RwLock<>>
         ├─→ Store in registry with unique ID
         ├─→ Extract stdin/stdout handles
         │
┌────────▼────────┐
│  Active Phase   │
└────────┬────────┘
         │
         ├─→ Process handle available for status checks
         ├─→ Can send interrupt signals
         ├─→ Can forcefully kill
         │
┌────────▼─────────────┐
│  Termination Phase   │
└────────┬─────────────┘
         │
         ├─→ Set child to None (clears handle)
         ├─→ Remove from registry
         ├─→ Arc drops → resources freed
```

### 2.3 Accessing Handles Safely

```rust
// Pattern: Clone Arc, release lock, then operate
pub async fn is_process_running(&self, run_id: i64) -> Result<bool, String> {
    let child_arc = {
        let processes = self.processes.lock()?;
        processes.get(&run_id)?.child.clone()
    };
    // Lock released here

    let mut child = child_arc.lock()?;
    match child.as_mut()?.try_wait() {
        Ok(Some(_)) => Ok(false),  // Exited
        Ok(None) => Ok(true),       // Running
        Err(_) => Ok(false),        // Error = assume dead
    }
}
```

---

## 3. I/O Management

### 3.1 Async Buffered Reading

```rust
use tokio::io::{AsyncBufReadExt, BufReader};

let stdout = child.stdout.take()?;
let mut reader = BufReader::new(stdout);
let mut buffer = String::new();

loop {
    buffer.clear();
    match reader.read_line(&mut buffer).await {
        Ok(0) => break,  // EOF
        Ok(_) => {
            let line = buffer.trim();
            if !line.is_empty() {
                process_line(line).await;
            }
        }
        Err(e) => {
            log::error!("Read error: {}", e);
            break;
        }
    }
}
```

### 3.2 Concurrent Stdout/Stderr Reading

```rust
let stdout_task = tokio::spawn(async move {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        // Process stdout line
        app.emit(&format!("output:{}", run_id), &line);
    }
});

let stderr_task = tokio::spawn(async move {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        // Process stderr line (usually errors/warnings)
        log::error!("stderr: {}", line);
    }
});

// Wait for both to complete
let _ = tokio::join!(stdout_task, stderr_task);
```

### 3.3 Stdin Writing (Bidirectional Protocol)

```rust
pub struct ProtocolPeer {
    stdin: Arc<Mutex<ChildStdin>>,
}

impl ProtocolPeer {
    async fn send_json<T: Serialize>(&self, message: &T) -> Result<()> {
        let json = serde_json::to_string(message)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(json.as_bytes()).await?;
        stdin.write_all(b"\n").await?;  // NDJSON requires newline
        stdin.flush().await?;
        Ok(())
    }
}
```

### 3.4 Interruptible Read Loop

Use `tokio::select!` to handle both reading and interrupt signals:

```rust
async fn read_loop(
    &self,
    stdout: ChildStdout,
    mut interrupt_rx: oneshot::Receiver<()>,
) -> Result<()> {
    let mut reader = BufReader::new(stdout);
    let mut buffer = String::new();
    let mut interrupt_rx = interrupt_rx.fuse();  // Makes it reusable in select!

    loop {
        buffer.clear();
        tokio::select! {
            // Normal read path
            result = reader.read_line(&mut buffer) => {
                match result {
                    Ok(0) => break,  // EOF
                    Ok(_) => self.process_line(&buffer).await?,
                    Err(e) => return Err(e.into()),
                }
            }
            // Interrupt signal received
            _ = &mut interrupt_rx => {
                self.send_interrupt_command().await?;
                // Continue loop to read any final output
            }
        }
    }
    Ok(())
}
```

### 3.5 Output Buffering

For UI display or logging, maintain a live buffer:

```rust
pub struct ProcessHandle {
    pub live_output: Arc<Mutex<String>>,
}

impl ProcessRegistry {
    pub fn append_output(&self, run_id: i64, line: &str) -> Result<()> {
        let processes = self.processes.lock()?;
        if let Some(handle) = processes.get(&run_id) {
            let mut output = handle.live_output.lock()?;
            output.push_str(line);
            output.push('\n');
        }
        Ok(())
    }
}
```

---

## 4. Process Monitoring

### 4.1 Startup Timeout

Detect stuck processes that fail to produce output:

```rust
const STARTUP_TIMEOUT_MS: u64 = 30_000;  // 30 seconds

let first_output = Arc::new(AtomicBool::new(false));
let first_output_clone = first_output.clone();

// In reader task:
// first_output_clone.store(true, Ordering::Relaxed);

// Monitor task:
tokio::spawn(async move {
    for i in 0..300 {  // 300 * 100ms = 30s
        if first_output.load(Ordering::Relaxed) {
            log::info!("Output detected after {}ms", i * 100);
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    log::warn!("Timeout: no output after 30 seconds");
    kill_process(pid);
});
```

### 4.2 Polling-Based Status Check

```rust
pub fn spawn_exit_watcher(child_store: Arc<...>, exec_id: Uuid) -> oneshot::Receiver<ExitStatus> {
    let (tx, rx) = oneshot::channel();

    tokio::spawn(async move {
        loop {
            let child_lock = child_store.read().await.get(&exec_id).cloned();

            if let Some(child_lock) = child_lock {
                let mut child = child_lock.write().await;
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = tx.send(Ok(status));
                        return;
                    }
                    Ok(None) => {}  // Still running
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                }
            } else {
                let _ = tx.send(Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Process handle missing"
                )));
                return;
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });

    rx
}
```

### 4.3 Dual-Signal Exit Monitoring

Monitor for both OS-level exit and application-level completion:

```rust
tokio::select! {
    // Executor signals it's done (graceful completion)
    exit_result = &mut executor_exit_signal => {
        // Kill process group, use executor's status
        kill_process_group(&mut child).await?;
        handle_exit(exit_result);
    }
    // OS signals process exited
    exit_status = &mut os_exit_watcher => {
        // Process died (maybe crashed)
        handle_exit(exit_status);
    }
}
```

---

## 5. Termination Strategies

### 5.1 Graceful Shutdown Sequences

The two implementations use different termination strategies:

**vibe-kanban (Full Bidirectional Protocol)**:
```
┌───────────────────────────────────────┐
│  1. Send Protocol Interrupt Command   │
│     via stdin (SDKControlRequest)     │
└─────────────────┬─────────────────────┘
                  │
                  ▼ Wait 5 seconds for graceful exit
┌───────────────────────────────────────┐
│  2. Send SIGINT to process group      │
│     (allows cleanup handlers)         │
└─────────────────┬─────────────────────┘
                  │
                  ▼ Wait 2 seconds
┌───────────────────────────────────────┐
│  3. Send SIGTERM to process group     │
│     (standard termination request)    │
└─────────────────┬─────────────────────┘
                  │
                  ▼ Wait 2 seconds
┌───────────────────────────────────────┐
│  4. Send SIGKILL to process group     │
│     (force kill, cannot be caught)    │
└───────────────────────────────────────┘
```

**opcode (Read-Only Mode)**:
```
┌───────────────────────────────────────┐
│  1. Try Child::start_kill() handle    │
│     (tokio process kill)              │
└─────────────────┬─────────────────────┘
                  │
                  ▼ If failed, use system command
┌───────────────────────────────────────┐
│  2. Send SIGTERM via kill command     │
│     kill -TERM <pid>                  │
└─────────────────┬─────────────────────┘
                  │
                  ▼ Wait 2 seconds
┌───────────────────────────────────────┐
│  3. Check if still running (kill -0)  │
│     If yes, send SIGKILL              │
└─────────────────┬─────────────────────┘
                  │
                  ▼ Wait up to 5 seconds total
┌───────────────────────────────────────┐
│  4. Remove from ProcessRegistry       │
└───────────────────────────────────────┘
```

**Key Difference**: opcode skips SIGINT (goes straight to SIGTERM), while vibe-kanban uses the full SIGINT → SIGTERM → SIGKILL escalation on process groups.

### 5.2 Protocol-Level Interrupt

For bidirectional protocol, send interrupt command via stdin:

```rust
pub async fn interrupt(&self) -> Result<()> {
    self.send_json(&SDKControlRequest::new(
        SDKControlRequestType::Interrupt {}
    )).await
}
```

This allows Claude to save state and exit cleanly.

### 5.3 Signal Escalation (Unix)

```rust
use nix::sys::signal::{killpg, Signal};
use nix::unistd::{getpgid, Pid};

pub async fn kill_process_group(child: &mut AsyncGroupChild) -> Result<()> {
    let pid = child.inner().id().ok_or("No PID")?;
    let pgid = getpgid(Some(Pid::from_raw(pid as i32)))?;

    // Escalating signals
    for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
        log::info!("Sending {:?} to process group {}", sig, pgid);

        if let Err(e) = killpg(pgid, sig) {
            log::warn!("Signal failed: {}", e);
        }

        // Wait for exit
        tokio::time::sleep(Duration::from_secs(2)).await;

        if child.inner().try_wait()?.is_some() {
            log::info!("Process exited after {:?}", sig);
            break;
        }
    }

    // Final cleanup
    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(())
}
```

### 5.4 Windows Termination

```rust
#[cfg(windows)]
fn kill_by_pid(pid: u32) -> Result<()> {
    std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()?;
    Ok(())
}
```

### 5.5 Fallback Kill Methods

If direct handle kill fails, use system commands:

```rust
async fn kill_with_fallback(child: &mut Child, pid: u32) -> Result<()> {
    // Method 1: tokio Child::kill()
    if child.kill().await.is_ok() {
        return Ok(());
    }

    // Method 2: System kill command
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .output()?;
    }

    Ok(())
}
```

---

## 6. Error Recovery

### 6.1 Orphan Process Cleanup (Startup)

On application startup, clean up processes from previous crashes:

```rust
async fn cleanup_orphan_executions(&self) -> Result<()> {
    // Query database for executions marked as "running"
    let orphans = ExecutionProcess::find_running(&db).await?;

    for process in orphans {
        log::info!("Found orphaned execution: {}", process.id);

        // Mark as failed in database
        ExecutionProcess::update_status(
            &db,
            process.id,
            ExecutionStatus::Failed,
        ).await?;

        // Try to kill if PID still exists
        if let Some(pid) = process.pid {
            let _ = kill_by_pid(pid);
        }
    }

    Ok(())
}
```

### 6.2 Spawn Timeout

Protect against hangs during process creation:

```rust
let spawned = tokio::time::timeout(
    Duration::from_secs(30),
    executor.spawn(&working_dir, &prompt, &env),
)
.await
.map_err(|_| Error::SpawnTimeout("Process took >30s to start"))??;
```

### 6.3 Database State Synchronization

Always update database when process state changes:

```rust
// On spawn success
ExecutionProcess::create(&db, ExecutionStatus::Running, pid).await?;

// On normal completion
ExecutionProcess::update_completion(&db, id, status, exit_code).await?;

// On error/crash
ExecutionProcess::update_status(&db, id, ExecutionStatus::Failed).await?;

// On user cancellation
ExecutionProcess::update_status(&db, id, ExecutionStatus::Cancelled).await?;
```

---

## 7. Concurrency

### 7.1 Multiple Process Support

Both implementations support multiple concurrent Claude processes:

```rust
// Each execution gets unique ID
pub async fn spawn_execution(&self, config: ExecutionConfig) -> Result<ExecutionId> {
    let id = Uuid::new_v4();  // or auto-increment i64

    let child = self.spawn_claude(&config).await?;

    // Store in concurrent map
    self.child_store.write().await.insert(id, Arc::new(RwLock::new(child)));

    Ok(id)
}
```

### 7.2 Event Isolation

Namespace events by execution ID:

```rust
// Emit to specific execution
app.emit(&format!("output:{}", execution_id), &line);
app.emit(&format!("error:{}", execution_id), &error);
app.emit(&format!("complete:{}", execution_id), &result);

// Optional: also emit generic event for global listeners
app.emit("output", &OutputEvent { id: execution_id, line });
```

**Event Timing (opcode)**: When emitting multiple related events, add small delays for UI consistency:
```rust
// Emit cancellation, wait, then emit completion
app.emit(&format!("claude-cancelled:{}", session_id), true);
tokio::time::sleep(Duration::from_millis(100)).await;  // 100ms delay
app.emit(&format!("claude-complete:{}", session_id), false);
```

### 7.3 Lock Ordering

Prevent deadlocks with consistent lock ordering:

```rust
// GOOD: Clone Arc, release lock, then operate
let child_arc = {
    let map = self.child_store.read().await;
    map.get(&id).cloned()
};
// Map lock released
if let Some(child) = child_arc {
    let mut child = child.write().await;
    // Now safe to do blocking operations
}

// BAD: Holding map lock while doing child operations
let map = self.child_store.read().await;
if let Some(child) = map.get(&id) {
    let mut child = child.write().await;  // Deadlock risk!
}
```

---

## 8. Resource Cleanup

### 8.1 Cleanup Sequence

```
┌─────────────────────────────────────┐
│  1. Signal process to terminate     │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  2. Wait for I/O tasks to complete  │
│     (stdout_task, stderr_task)      │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  3. Remove from process registry    │
│     (HashMap::remove)               │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  4. Arc<Child> drops → handle freed │
│     (stdin/stdout/stderr close)     │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  5. Update database status          │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  6. Emit completion events          │
└─────────────────────────────────────┘
```

### 8.2 Explicit Resource Release

```rust
// Release database connections before async operations
let data = {
    let conn = db.lock()?;
    let result = conn.query(...)?;
    drop(conn);  // Explicit release
    result
};

// Release statement handles
drop(stmt);
drop(conn);
```

### 8.3 Periodic Cleanup

Run cleanup tasks periodically:

```rust
pub fn spawn_periodic_cleanup(&self) {
    let service = self.clone();

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1800));  // 30 min

        loop {
            interval.tick().await;
            log::info!("Running periodic cleanup...");

            if let Err(e) = service.cleanup_expired_resources().await {
                log::error!("Cleanup failed: {}", e);
            }
        }
    });
}
```

### 8.4 Message Store Cleanup

```rust
// Mark message store as finished
if let Some(store) = self.msg_stores.write().await.remove(&execution_id) {
    store.push_finished();  // Signals no more messages coming
}
```

**Arc Reference Counting Cleanup** (vibe-kanban):
```rust
if let Some(msg_arc) = msg_stores.write().await.remove(&exec_id) {
    msg_arc.push_finished();

    // Wait for message propagation before cleanup
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Verify no other references remain
    match Arc::try_unwrap(msg_arc) {
        Ok(inner) => drop(inner),  // Safe cleanup
        Err(arc) => {
            tracing::error!(
                "Still {} strong Arcs to MsgStore for {}",
                Arc::strong_count(&arc),
                exec_id
            );
        }
    }
}
```

The 50ms delay ensures any in-flight message forwarding completes before attempting cleanup.

---

## 9. Bidirectional Protocol Extensions

These features are specific to **vibe-kanban**'s bidirectional protocol implementation.

### 9.1 Stdout Duplication (stdout_dup.rs)

When using bidirectional protocol, stdout serves dual purposes: reading Claude's NDJSON output AND forwarding to a log writer. The `stdout_dup` module provides utilities to manage this:

```rust
// Create a pipe writer that intercepts stdout
pub fn create_stdout_pipe_writer(
    child: &mut AsyncGroupChild,
) -> Result<impl AsyncWrite, ExecutorError> {
    // Create replacement pipe
    let (pipe_reader, pipe_writer) = os_pipe::pipe()?;

    // Replace child's stdout with new pipe reader
    child.inner().stdout = Some(wrap_fd_as_child_stdout(pipe_reader)?);

    // Return writer for log forwarding
    wrap_fd_as_tokio_writer(pipe_writer)
}
```

**Usage in spawn_internal**:
```rust
// Before spawning protocol peer, create log writer pipe
let new_stdout = create_stdout_pipe_writer(&mut child)?;
let log_writer = LogWriter::new(new_stdout);

// Now protocol peer reads from child.stdout (the new pipe)
// while log_writer receives forwarded output
```

**Available Functions**:
- `duplicate_stdout()` - Creates bidirectional stream copy
- `tee_stdout_with_appender()` - Mirrors stdout and allows injection
- `create_stdout_pipe_writer()` - Creates fresh pipe for logging
- `spawn_local_output_process()` - Helper process for stdout routing

### 9.2 Hook/Callback System

Hooks allow customizing Claude's behavior at various lifecycle points:

**Hook Configuration**:
```rust
fn get_hooks(&self, mode: PermissionMode) -> Option<serde_json::Value> {
    let mut hooks = serde_json::Map::new();

    // PreToolUse hook with regex matcher
    hooks.insert(
        "PreToolUse".to_string(),
        serde_json::json!([{
            // Match all tools except read-only ones
            "matcher": "^(?!(Glob|Grep|NotebookRead|Read|Task|TodoWrite)$).*",
            "hookCallbackIds": ["tool_approval"],
        }]),
    );

    Some(serde_json::Value::Object(hooks))
}
```

**Well-Known Callback IDs**:
```rust
// Auto-approve tools without user interaction
pub const AUTO_APPROVE_CALLBACK_ID: &str = "AUTO_APPROVE_CALLBACK_ID";

// Check for uncommitted git changes before stopping
pub const STOP_GIT_CHECK_CALLBACK_ID: &str = "STOP_GIT_CHECK_CALLBACK_ID";
```

**Hook Callback Handling**:
```rust
pub async fn on_hook_callback(
    &self,
    callback_id: String,
    input: serde_json::Value,
    _tool_use_id: Option<String>,
) -> Result<serde_json::Value, ExecutorError> {
    match callback_id.as_str() {
        STOP_GIT_CHECK_CALLBACK_ID => {
            // Check for uncommitted changes
            let status = check_uncommitted_changes(&repo_paths).await;
            if status.is_empty() {
                Ok(serde_json::json!({"decision": "approve"}))
            } else {
                Ok(serde_json::json!({
                    "decision": "block",
                    "reason": format!("Uncommitted changes: {}", status)
                }))
            }
        }
        AUTO_APPROVE_CALLBACK_ID => {
            Ok(serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow"
                }
            }))
        }
        _ => {
            // Forward to permission system
            Ok(serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask"  // Triggers CanUseTool request
                }
            }))
        }
    }
}
```

### 9.3 Approval Service Integration

For human-in-the-loop workflows, integrate an approval service:

**Approval Service Trait**:
```rust
#[async_trait]
pub trait ExecutorApprovalService: Send + Sync {
    async fn request_tool_approval(
        &self,
        tool_name: &str,
        tool_input: serde_json::Value,
        tool_use_id: &str,
    ) -> Result<ApprovalStatus, ExecutorApprovalError>;
}
```

**Permission Flow**:
```rust
pub async fn on_can_use_tool(
    &self,
    tool_name: String,
    input: serde_json::Value,
    permission_suggestions: Option<Vec<PermissionUpdate>>,
    tool_use_id: Option<String>,
) -> Result<PermissionResult, ExecutorError> {
    if self.auto_approve {
        // No approval service - auto-approve everything
        return Ok(PermissionResult::Allow {
            updated_input: input,
            updated_permissions: None,
        });
    }

    if let Some(id) = tool_use_id {
        // Delegate to approval service
        self.handle_approval(id, tool_name, input).await
    } else {
        // No tool_use_id - auto-approve (edge case)
        Ok(PermissionResult::Allow { ... })
    }
}
```

**Permission Modes**:
```rust
pub enum PermissionMode {
    Default,           // Normal permission checks
    AcceptEdits,       // Auto-approve file edits
    Plan,              // Planning mode (no execution)
    BypassPermissions, // Skip all permission checks
}
```

**Special Case - ExitPlanMode**:
When user approves `ExitPlanMode` tool, automatically switch to `BypassPermissions`:
```rust
if tool_name == "ExitPlanMode" {
    Ok(PermissionResult::Allow {
        updated_input: input,
        updated_permissions: Some(vec![PermissionUpdate {
            update_type: PermissionUpdateType::SetMode,
            mode: Some(PermissionMode::BypassPermissions),
            destination: Some(PermissionUpdateDestination::Session),
            ..Default::default()
        }]),
    })
}
```

### 9.4 Protocol Initialization Sequence

The full initialization sequence for bidirectional protocol:

```rust
tokio::spawn(async move {
    // 1. Create log writer from duplicated stdout
    let log_writer = LogWriter::new(new_stdout);

    // 2. Create client with approval service
    let client = ClaudeAgentClient::new(
        log_writer,
        approvals_clone,  // Option<Arc<dyn ExecutorApprovalService>>
        repo_context,
    );

    // 3. Spawn protocol peer (starts read loop)
    let protocol_peer = ProtocolPeer::spawn(
        child_stdin,
        child_stdout,
        client,
        interrupt_rx,
    );

    // 4. Initialize control protocol
    protocol_peer.initialize(hooks).await?;

    // 5. Set permission mode
    protocol_peer.set_permission_mode(permission_mode).await?;

    // 6. Send user prompt
    protocol_peer.send_user_message(prompt).await?;
});
```

---

## 10. Architecture Comparison

| Aspect | opcode | vibe-kanban |
|--------|--------|-------------|
| **Runtime** | Tauri (desktop) | Tokio (server) |
| **Binary Discovery** | Multi-path search (NVM, Homebrew, PATH) | NPX with pinned versions |
| **Process Storage** | `HashMap<i64, ProcessHandle>` | `HashMap<Uuid, Arc<RwLock<Child>>>` |
| **Locking** | `Arc<Mutex<>>` | `Arc<RwLock<>>` |
| **Stdin Mode** | `null` (no input) | `piped` (bidirectional) |
| **Protocol** | Read-only NDJSON | Full bidirectional control |
| **Process Groups** | No (direct PID kill) | Yes (`group_spawn()`) |
| **Kill-on-Drop** | No (explicit cleanup) | Yes |
| **Interrupt** | OS signals only | Protocol command + signals |
| **Monitoring** | AtomicBool for first output | Polling + dual-signal |
| **Timeout** | 30s startup, 5s shutdown | 30s spawn, 5s graceful |
| **Kill Strategy** | SIGTERM → SIGKILL | SIGINT → SIGTERM → SIGKILL |
| **Stdout Handling** | Direct piped read | Duplicated (stdout_dup) |
| **Approval System** | None | ExecutorApprovalService trait |
| **Hook Support** | None | PreToolUse, Stop hooks |
| **Event System** | Tauri events (100ms delays) | Internal channels |
| **Persistence** | SQLite | PostgreSQL |

### Key Differences

**opcode** is optimized for:
- Desktop application lifecycle
- Simple read-only streaming
- User-visible progress updates
- Manual binary management
- Direct process termination (no process groups)

**vibe-kanban** is optimized for:
- Server-side automation
- Bidirectional protocol control
- Fine-grained permission management
- Human-in-the-loop approval workflows
- Reproducible deployments (pinned versions)
- Process tree termination via groups

### Common Patterns

Both implementations share:
- Async buffered I/O reading
- Graceful shutdown with timeout fallback
- Concurrent process support via HashMap
- Database state persistence
- Startup timeout detection (30s)
- Fallback kill via system commands

---

## Appendix A: Essential Imports (Rust)

```rust
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, RwLock, oneshot},
    time::{timeout, Duration},
};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::Arc,
};

// For process groups (Unix)
use nix::sys::signal::{killpg, Signal};
use nix::unistd::{getpgid, Pid};

// For process groups (cross-platform)
use async_process::Command;  // or command-group crate
```

## Appendix B: Minimal Working Example

```rust
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};
use std::process::Stdio;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut child = Command::new("claude")
        .args(["-p", "Hello", "--output-format", "stream-json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout).lines();

    while let Some(line) = reader.next_line().await? {
        println!("Received: {}", line);

        // Parse NDJSON
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            if json.get("type").and_then(|t| t.as_str()) == Some("result") {
                println!("Execution complete!");
                break;
            }
        }
    }

    // Wait for process to exit
    let status = child.wait().await?;
    println!("Exit status: {}", status);

    Ok(())
}
```
