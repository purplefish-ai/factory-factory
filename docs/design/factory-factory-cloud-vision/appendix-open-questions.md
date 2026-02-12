# Appendix: Open Questions

## How does Claude CLI work?

**Where are the Claude API docs?**

The Claude CLI doesn't have separate API documentation because it IS a command-line program that wraps the Anthropic Claude API. You can see the available options with `claude --help`. The CLI is installed at `~/.local/bin/claude` and provides various flags for controlling behavior.

**How does it stream text?**

Claude CLI uses a **streaming JSON protocol** for communication:
- Uses `--output-format stream-json` and `--input-format stream-json` flags
- Communicates via stdin/stdout using newline-delimited JSON messages
- Each message is a JSON object with a `type` field (e.g., `assistant`, `user`, `result`, `stream_event`, `system`)
- Factory Factory spawns Claude CLI as a subprocess and uses `ClaudeProtocolIO` to parse the stdout stream

From `src/backend/domains/session/claude/process.ts`:
```typescript
const childProcess = spawn('claude', args, {
  cwd: options.workingDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  // ...
});
const protocol = new ClaudeProtocolIO(childProcess.stdin, childProcess.stdout);
```

**Does the Claude CLI have a server, or do multiple CLIs call a single local server?**

**No local server.** Each `claude` CLI invocation is a **standalone process** that makes direct API calls to the Anthropic Claude API in the cloud. When FF spawns multiple workspaces, each gets its own independent `claude` subprocess.

From the code:
- `ClaudeProcess.spawn()` uses Node's `spawn('claude', args, ...)` to create a new process
- Each process has its own `claudeSessionId` (stored in `~/.claude/projects/<hash>/`)
- Each process maintains its own conversation history in a JSONL file

**Is the CLI backed by the Claude API in the cloud?**

**Yes.** The Claude CLI is a wrapper around the Anthropic Claude API (claude.ai). The "session identity" exists in two places:
1. **Local**: `claudeSessionId` - A hash that identifies the conversation history stored in `~/.claude/projects/<hash>/conversation.jsonl`
2. **Cloud**: The actual Claude conversation state is managed by Anthropic's API. The CLI sends messages to the API and receives streaming responses.

**Why do we have a Claude "server" at all (referring to FF's backend)?**

Factory Factory's backend server (`src/backend/server.ts`) is **not a Claude API server** - it's a coordination layer that:
1. **Manages multiple Claude CLI subprocesses** (one per workspace/session)
2. **Provides a WebSocket API** for the frontend to interact with these processes
3. **Stores workspace metadata** in a SQLite database (Prisma)
4. **Forwards Claude CLI events** to connected frontend clients via WebSocket
5. **Manages the ratchet system** for auto-fixing PRs

The architecture is:
```
Frontend (Browser)
  ↕ WebSocket
FF Backend (Express + tRPC)
  ↕ stdin/stdout (JSON protocol)
Claude CLI subprocess
  ↕ HTTPS (Claude API)
Anthropic Cloud (claude.ai)
```

So FF's backend is a **process manager and message relay**, not a Claude API server.

## The Streaming JSON Protocol Details

The protocol is a **bidirectional NDJSON (Newline-Delimited JSON)** protocol over stdin/stdout:

**Communication Format:**
- Each line is a complete JSON object
- Lines are separated by `\n`
- Messages are validated against Zod schemas for type safety

**Message Flow:**

**SDK → CLI (via stdin):**
```json
{"type":"control_request","request_id":"uuid","request":{"subtype":"initialize","hooks":{...}}}
{"type":"user","message":{"role":"user","content":"Hello"}}
{"type":"control_response","response":{"subtype":"success","request_id":"uuid","response":{...}}}
```

**CLI → SDK (via stdout):**
```json
{"type":"system","subtype":"init","message":"Claude Code CLI initialized"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]},"session_id":"abc123"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1",...}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let"}}}
{"type":"result","session_id":"abc123","result":"completed"}
{"type":"control_request","request_id":"uuid","request":{"subtype":"bash_tool_use",...}}
```

**Key Message Types:**

1. **`control_request`** (SDK → CLI): Initialize, set model, set permissions, interrupt, rewind files
2. **`control_response`** (SDK → CLI): Response to CLI's control requests (e.g., permission approval)
3. **`user`** (SDK → CLI): User messages with text or images
4. **`assistant`** (CLI → SDK): Claude's complete responses
5. **`stream_event`** (CLI → SDK): Real-time streaming chunks (text deltas, tool use, thinking)
6. **`system`** (CLI → SDK): Status messages (init, status, compact_boundary, hooks)
7. **`result`** (CLI → SDK): Conversation turn completion
8. **`keep_alive`** (CLI → SDK): Heartbeat to keep connection alive
9. **`tool_progress`** (CLI → SDK): Progress updates during tool execution
10. **`tool_use_summary`** (CLI → SDK): Summary after tool completes

**Request/Response Correlation:**
- SDK messages with `request_id` expect responses (tracked in `pendingRequests` Map)
- Responses include the same `request_id` for correlation
- Timeouts (default 60s) prevent hanging on unresponsive CLI

**Backpressure Handling:**
- If stdin buffer fills, protocol waits for `drain` event before continuing
- Prevents memory exhaustion under high message volume

**Error Handling:**
- Invalid JSON → skip line, emit error event
- Schema validation failures → log and skip
- Messages over max length (1MB) → reject to prevent DoS

This protocol design enables **real-time streaming**, **bidirectional communication**, and **type-safe message passing** between Factory Factory and Claude CLI.

## FF CLI vs FF Server API - Which Do We Need?

**Short answer: We need an HTTP/WebSocket API server, not a CLI.**

The "FF CLI" mentioned in the architecture diagrams is misleading. What we actually need is:

**FF Cloud Server** with an HTTP/WebSocket API that:
1. Manages Claude CLI subprocesses (one per workspace)
2. Exposes REST/WebSocket endpoints for desktop/mobile clients
3. Handles authentication and authorization
4. Stores workspace state in a database
5. Manages git operations and sandboxing

**Why not a CLI?**
- **Multi-client access**: Desktop, mobile, and web clients need simultaneous access to the same workspace
- **Centralized state**: Workspace state needs to be in a database, not just CLI output
- **Authentication**: HTTP APIs are easier to secure than CLI commands
- **Streaming**: WebSockets provide better real-time streaming than spawning CLI processes
- **Resource management**: A server can pool resources, handle quotas, and enforce limits better than CLI

**Architecture should be:**
```
Desktop/Mobile Clients
  ↕ WebSocket/HTTP
FF Cloud Server (Node.js + Express)
  ↕ stdin/stdout (NDJSON)
Claude CLI subprocesses
  ↕ HTTPS
Anthropic API
```

The API would look like:
```typescript
// WebSocket for real-time streaming
ws://ff-cloud.com/workspaces/:id/stream

// REST API for workspace management
POST   /workspaces
GET    /workspaces/:id
POST   /workspaces/:id/messages
DELETE /workspaces/:id
GET    /workspaces/:id/files
POST   /workspaces/:id/ratchet/start
```

## Sandboxing: Preventing Users from Breaking Out

**The Challenge:**
Claude CLI can execute arbitrary bash commands via the `Bash` tool. In the cloud, this means users could potentially:
- Access other users' workspaces
- Escape the container/VM
- Exfiltrate secrets
- Mine cryptocurrency
- Attack other services

**Solution: Multi-Layer Sandboxing**

### 1. Container Isolation (Docker/Firecracker)

Each workspace runs in its own isolated container:

```dockerfile
FROM ubuntu:22.04

# Minimal system with no network access by default
RUN apt-get update && apt-get install -y \
    git nodejs npm python3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for running Claude CLI
RUN useradd -m -u 1000 workspace
USER workspace

# Working directory isolated per workspace
WORKDIR /workspace
```

**Container configuration:**
- **No network by default**: `--network none` (only allow specific git/API traffic via proxy)
- **Read-only filesystem**: Only `/workspace` is writable
- **Resource limits**: CPU, memory, disk quotas via cgroups
- **Seccomp profile**: Block dangerous syscalls (e.g., `ptrace`, `reboot`)
- **AppArmor/SELinux**: Restrict file access, capabilities

### 2. Git Repository Sandboxing

**Isolated git checkouts:**
```bash
# Each workspace gets its own git clone
/cloud-workspaces/
  workspace-abc123/
    repo/          # Git checkout goes here
    .claude/       # Claude CLI session data
```

**Git safety:**
- Clone with `--depth 1` to save space
- Use `git config core.hooksPath /dev/null` to disable hooks
- Restrict to specific branches only
- Use GitHub deploy keys (read-only or write-only)

### 3. Claude CLI Restrictions

**Permission mode enforcement:**
```bash
claude --permission-mode acceptEdits \
       --disallowed-tools "Bash(rm -rf:*),Bash(sudo:*)" \
       --output-format stream-json
```

**Bash tool filtering:**
- Maintain an allowlist of safe commands (git, npm, python, node, etc.)
- Block dangerous patterns:
  - `rm -rf /`, `dd`, `mkfs`, `:(){ :|:& };:` (fork bomb)
  - `sudo`, `su`, `chroot`
  - Network commands: `curl`, `wget`, `nc` (unless proxied)
  - File access outside `/workspace`

**Implementation in FF Cloud:**
```typescript
// Intercept control_request messages from Claude CLI
if (msg.type === 'control_request' && msg.request.subtype === 'bash_tool_use') {
  const command = msg.request.command;

  if (isDangerousCommand(command)) {
    // Deny and log
    protocol.sendControlResponse(msg.request_id, {
      behavior: 'deny',
      reason: 'Command blocked by security policy'
    });
    return;
  }

  // Allow safe commands
  protocol.sendControlResponse(msg.request_id, {
    behavior: 'allow'
  });
}
```

### 4. Network Isolation

**Egress proxy for git operations:**
- Only allow HTTPS to github.com (or configured git hosts)
- Block all other external access
- Rate limit API calls
- Log all network activity

```yaml
# Container network config
networks:
  workspace_network:
    driver: bridge
    internal: true  # No external access
  git_proxy_network:
    driver: bridge  # Only connects to git proxy
```

### 5. Monitoring and Rate Limiting

**Per-workspace limits:**
- **CPU**: 2 cores max
- **Memory**: 4GB max
- **Disk**: 10GB max
- **Process count**: 100 max
- **Network**: 100MB/hour max
- **API calls**: 1000/hour max

**Monitoring:**
- Log all bash commands executed
- Alert on suspicious patterns (port scans, crypto miners)
- Auto-kill workspaces exceeding limits
- Track file modifications outside expected paths

### 6. Ephemeral Workspaces

**Workspace lifecycle:**
- Workspaces are **temporary** - destroyed after inactivity or completion
- No persistent state except in database and git remote
- Secrets (API keys, tokens) are injected at runtime, never stored in workspace
- Workspace ID is a UUID - no predictable paths

### 7. User Authentication & Authorization

**Identity management:**
- Each workspace is owned by a specific user
- JWT tokens for API authentication
- Workspace isolation enforced at API level
- Audit log of all workspace actions

**Authorization checks:**
```typescript
// Before any workspace operation
if (workspace.userId !== authenticatedUser.id) {
  throw new ForbiddenError('Access denied');
}
```

## Defense in Depth Summary

| Layer | Protection |
|-------|------------|
| Container | Isolated filesystem, no network, resource limits |
| Git | Sandboxed checkouts, hooks disabled, deploy keys |
| Claude CLI | Command filtering, disallowed tools, permission mode |
| Network | Egress proxy, rate limiting, logging |
| Monitoring | Resource tracking, anomaly detection, auto-kill |
| Lifecycle | Ephemeral, auto-cleanup, no persistent secrets |
| Identity | Authentication, authorization, audit logs |

**Still vulnerable to:**
- Zero-day container escapes (mitigated by using hardened runtimes like Firecracker)
- Resource exhaustion attacks (mitigated by quotas and monitoring)
- Social engineering (out of scope for technical controls)

This approach follows the principle of **defense in depth** - even if one layer fails, others protect the system.

## Firecracker vs Docker: Understanding the Difference

**What is Firecracker?**

Firecracker is a **lightweight virtual machine manager (VMM)** created by AWS, used to run AWS Lambda and Fargate. It provides:

- **True hardware-level isolation** via KVM (Kernel Virtual Machine)
- **Minimal attack surface** - ~50,000 lines of Rust code vs millions in QEMU
- **Fast boot times** - VMs start in <125ms
- **Small memory footprint** - VMs can run with <5MB overhead
- **No Docker daemon** - each microVM is independent

**Docker vs Firecracker:**

| Feature | Docker | Firecracker |
|---------|--------|-------------|
| **Isolation** | Process isolation (namespaces, cgroups) | True VM isolation (hardware virtualization) |
| **Security boundary** | Shared kernel - kernel exploits affect host | Separate kernel per VM - kernel exploits isolated |
| **Startup time** | ~1 second | ~125ms |
| **Memory overhead** | ~10-50MB | ~5MB |
| **Escape risk** | Container escapes possible (CVE history) | VM escapes extremely rare |
| **Use case** | Development, microservices | Security-critical workloads (Lambda, untrusted code) |

**Why Firecracker for FF Cloud?**

Since we're running **untrusted user code** (arbitrary bash commands via Claude CLI), Firecracker provides:

1. **Stronger isolation**: Even if a user exploits a kernel vulnerability, they're isolated to their VM
2. **No shared kernel**: Each workspace has its own kernel, so kernel panics don't affect others
3. **Attack surface reduction**: Minimal VMM code means fewer vulnerabilities
4. **AWS-proven**: Powers millions of Lambda invocations daily

**Architecture with Firecracker:**

```
┌─────────────────────────────────────┐
│         Host OS (Ubuntu)            │
│  ┌──────────────────────────────┐   │
│  │  Firecracker microVM #1      │   │
│  │  ┌────────────────────────┐  │   │
│  │  │  Workspace abc123      │  │   │
│  │  │  - Claude CLI          │  │   │
│  │  │  - Git repo            │  │   │
│  │  │  - /workspace/ (RW)    │  │   │
│  │  └────────────────────────┘  │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │  Firecracker microVM #2      │   │
│  │  ┌────────────────────────┐  │   │
│  │  │  Workspace xyz456      │  │   │
│  │  │  - Claude CLI          │  │   │
│  │  │  - Git repo            │  │   │
│  │  │  - /workspace/ (RW)    │  │   │
│  │  └────────────────────────┘  │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

**Practical trade-offs:**

- **Docker**: Easier to use, better tooling, faster development iteration
- **Firecracker**: Better security, but more complex to set up (need KVM, custom orchestration)

**Recommendation**: Start with **Docker** for MVP/development, migrate to **Firecracker** for production when security is critical.

## Read-Only Filesystem: How Can Claude Edit Files?

**The confusion**: When I said "read-only filesystem," I meant the **base system** is read-only, not the entire filesystem.

**Correct filesystem layout:**

```bash
/                    # Read-only (system binaries, libraries)
├── bin/             # Read-only
├── usr/             # Read-only
├── lib/             # Read-only
├── etc/             # Read-only (or mostly read-only with specific writable files)
└── workspace/       # READ-WRITE (writable by workspace user)
    ├── repo/        # Git repository - Claude can edit these files
    │   ├── src/
    │   ├── package.json
    │   └── .git/
    └── .claude/     # Claude CLI session data
        └── projects/
```

**How it works:**

1. **System directories are read-only**: Prevents users from modifying `/bin/bash`, `/etc/passwd`, etc.
2. **Workspace directory is writable**: Claude CLI can freely edit code, create files, commit to git

**Docker implementation:**

```yaml
# docker-compose.yml
services:
  workspace:
    image: factory-factory-workspace:latest
    read_only: true  # Make root filesystem read-only
    volumes:
      # Mount workspace directory as read-write
      - ./workspaces/${WORKSPACE_ID}:/workspace:rw
      # Mount tmp as read-write (needed for some operations)
      - /tmp:rw
      # Mount specific files that need to be writable
      - /run:rw
      - /var/run:rw
    tmpfs:
      # Temporary filesystem for things like lock files
      - /tmp:exec,mode=1777
```

**Firecracker implementation:**

```json
{
  "drives": [
    {
      "drive_id": "rootfs",
      "is_root_device": true,
      "is_read_only": true,
      "path_on_host": "/vm-images/ubuntu-minimal.ext4"
    },
    {
      "drive_id": "workspace",
      "is_root_device": false,
      "is_read_only": false,
      "path_on_host": "/workspaces/abc123/workspace.ext4"
    }
  ]
}
```

**What the agent CAN do:**
- Edit files in `/workspace/repo/`
- Create new files in `/workspace/`
- Run `git add`, `git commit`, `git push`
- Install npm packages (if using a writable `node_modules` in `/workspace/`)
- Run tests, build artifacts

**What the agent CANNOT do:**
- Modify `/bin/bash` or other system binaries
- Install system packages with `apt-get` (no write access to `/var/lib/apt/`)
- Modify `/etc/passwd` or add users
- Write to `/root/` or other system directories
- Persist malware in the system image (it's read-only)

**Benefits:**
- **Prevents system tampering**: Even if Claude is compromised, it can't modify the OS
- **Clean slate**: Each workspace starts from the same read-only base image
- **Faster startup**: No need to copy the entire filesystem, just mount read-only
- **Malware containment**: Malware can't persist in system directories

**For packages/dependencies:**

If you need to install packages (npm, pip, etc.), you have options:

1. **Pre-install in base image**: Include common packages in the read-only image
2. **Install to workspace**: `npm install --prefix /workspace/repo`
3. **Use volumes**: Mount a shared package cache (read-only) with specific package versions
4. **Layer approach**: Start with read-only base, add a writable overlay for `/usr/local/` or `/opt/`

**Example with overlay filesystem:**

```bash
# Create writable overlay for /usr/local/ (for pip packages, etc.)
docker run \
  --read-only \
  -v /workspace:/workspace:rw \
  --tmpfs /tmp:exec \
  --tmpfs /usr/local:exec  # Writable layer for installed packages
  factory-factory-workspace
```

This way, packages can be installed at runtime but don't persist across workspaces (ephemeral isolation).
