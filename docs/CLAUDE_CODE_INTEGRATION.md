# Claude Code Integration for FactoryFactory

## Overview

FactoryFactory uses **Claude Code CLI** for all agent interactions. This means users authenticate with their Claude subscription via OAuth instead of requiring API keys.

## Architecture

```
FactoryFactory → Claude Code CLI (tmux sessions) → Claude API
                 ↑
              User's logged-in session (OAuth, no API key needed!)
```

All agent types (Worker, Orchestrator, Supervisor) use Claude Code CLI instances running in tmux sessions. See `src/backend/clients/claude-code.client.ts` for the implementation.

## Claude Code Authentication Flow

### 1. User Login (One-Time)

Users authenticate once via Claude Code:

```bash
# User runs this once on their machine
claude-code login
```

This:
- Opens browser to claude.ai
- User logs in with their Claude account (Free/Pro/Team)
- Session credentials stored in `~/.config/claude-code/` or `~/.claude-code/`
- No API key needed!

### 2. Session Management

Claude Code handles:
- Session token refresh
- Credential storage
- Authentication state
- Subscription tier enforcement (message limits, model access, etc.)

### 3. FactoryFactory Integration

FactoryFactory spawns Claude Code as a subprocess instead of using SDK directly.

## Implementation

### Option A: Spawn Claude Code Process (Recommended)

Similar to how vibe-kanban does it:

```typescript
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export class ClaudeCodeClient extends EventEmitter {
  private process: ChildProcess | null = null;

  /**
   * Start Claude Code subprocess
   * @param options.disableApiKey - If true, removes ANTHROPIC_API_KEY from env
   */
  async startClaudeCode(options: {
    disableApiKey?: boolean;
    model?: string;
    workingDirectory?: string;
  }): Promise<void> {
    const env = { ...process.env };

    // Remove API key if user wants to use their Claude subscription
    if (options.disableApiKey) {
      delete env.ANTHROPIC_API_KEY;
      console.log('Using Claude subscription (API key disabled)');
    }

    // Spawn Claude Code
    this.process = spawn('claude-code', [], {
      env,
      cwd: options.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Set up event handlers
    this.process.stdout?.on('data', (data) => {
      this.handleStdout(data.toString());
    });

    this.process.stderr?.on('data', (data) => {
      console.error('Claude Code error:', data.toString());
    });

    this.process.on('close', (code) => {
      console.log(`Claude Code exited with code ${code}`);
      this.emit('exit', code);
    });
  }

  /**
   * Send message to Claude Code via stdin
   */
  async sendMessage(message: string): Promise<void> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Claude Code not running');
    }

    this.process.stdin.write(message + '\n');
  }

  /**
   * Handle output from Claude Code
   */
  private handleStdout(data: string): void {
    // Parse Claude Code's JSON protocol
    try {
      const response = JSON.parse(data);
      this.emit('message', response);
    } catch (e) {
      // Handle non-JSON output (logs, etc.)
      this.emit('log', data);
    }
  }

  /**
   * Gracefully stop Claude Code
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
```

### Option B: Use Claude Code's JSON Protocol

Claude Code supports a JSON protocol for programmatic interaction:

```typescript
export class ClaudeCodeProtocolClient {
  private client: ClaudeCodeClient;

  async initialize(options: {
    useSubscription: boolean; // true = use Claude sub, false = use API key
  }): Promise<void> {
    this.client = new ClaudeCodeClient();

    await this.client.startClaudeCode({
      disableApiKey: options.useSubscription,
    });

    // Wait for ready signal
    await this.waitForReady();
  }

  async createTask(prompt: string, tools: Tool[]): Promise<string> {
    // Send task creation request
    const request = {
      type: 'create_task',
      prompt,
      tools: tools.map(this.convertMcpToolToClaudeCodeTool),
    };

    await this.client.sendMessage(JSON.stringify(request));

    // Wait for response
    return new Promise((resolve) => {
      this.client.once('message', (response) => {
        if (response.type === 'task_created') {
          resolve(response.taskId);
        }
      });
    });
  }

  async executeTask(taskId: string): Promise<void> {
    const request = {
      type: 'execute_task',
      taskId,
    };

    await this.client.sendMessage(JSON.stringify(request));

    // Stream responses
    this.client.on('message', (response) => {
      if (response.type === 'tool_call') {
        this.handleToolCall(response);
      }
    });
  }

  private async handleToolCall(toolCall: any): Promise<void> {
    // Execute MCP tool
    const result = await executeMcpTool(
      toolCall.agentId,
      toolCall.toolName,
      toolCall.input
    );

    // Send result back to Claude Code
    await this.client.sendMessage(JSON.stringify({
      type: 'tool_result',
      toolCallId: toolCall.id,
      result,
    }));
  }
}
```

## Configuration

### User Settings

Add to user preferences:

```typescript
interface UserSettings {
  // Authentication method
  authMethod: 'subscription' | 'api_key';

  // If authMethod === 'api_key'
  anthropicApiKey?: string; // Encrypted

  // Claude Code settings
  claudeCodePath?: string; // Path to claude-code binary
  preferredModel?: string; // claude-sonnet-4-5-20250929

  // Fallback
  allowFallbackToApiKey?: boolean;
}
```

### Environment Variables

```bash
# User's choice
USE_CLAUDE_SUBSCRIPTION=true  # Use Claude Code with subscription
# OR
USE_CLAUDE_SUBSCRIPTION=false # Use API key (pay-as-you-go)

# Optional: Path to Claude Code
CLAUDE_CODE_PATH=/usr/local/bin/claude-code

# Fallback API key (if subscription fails)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

## Worker Agent Update

### New Worker Creation Flow

```typescript
export async function createWorker(
  taskId: string,
  userSettings: UserSettings
): Promise<string> {
  // Create agent record
  const agent = await agentAccessor.create({
    type: AgentType.WORKER,
    currentTaskId: taskId,
  });

  // Choose authentication method
  if (userSettings.authMethod === 'subscription') {
    // Use Claude Code with subscription
    await createClaudeCodeWorker(agent.id, taskId, userSettings);
  } else {
    // Use SDK with API key (existing implementation)
    await createSdkWorker(agent.id, taskId, userSettings.anthropicApiKey);
  }

  return agent.id;
}

async function createClaudeCodeWorker(
  agentId: string,
  taskId: string,
  settings: UserSettings
): Promise<void> {
  const task = await taskAccessor.findById(taskId);

  // Initialize Claude Code client
  const claudeCode = new ClaudeCodeProtocolClient();

  await claudeCode.initialize({
    useSubscription: true, // Don't pass API key
  });

  // Create task in Claude Code
  const systemPrompt = buildWorkerPrompt(taskId, task.title);
  const tools = convertMcpToolsToClaudeCodeFormat();

  await claudeCode.createTask(systemPrompt, tools);

  // Execute task
  await claudeCode.executeTask(agentId);
}
```

## User Interface

### Settings Page

```tsx
function AuthenticationSettings() {
  const [authMethod, setAuthMethod] = useState<'subscription' | 'api_key'>('subscription');

  return (
    <div>
      <h2>Claude Authentication</h2>

      <RadioGroup value={authMethod} onChange={setAuthMethod}>
        <Radio value="subscription">
          <div>
            <strong>Use Claude Subscription</strong> (Recommended)
            <p>Use your Claude Free/Pro/Team plan. No API key needed!</p>
            <div>
              {isClaudeCodeLoggedIn() ? (
                <span>✓ Logged in to Claude Code</span>
              ) : (
                <div>
                  <span>⚠ Not logged in</span>
                  <button onClick={() => openClaudeCodeLogin()}>
                    Log in with Claude
                  </button>
                  <p><small>Run: <code>claude-code login</code></small></p>
                </div>
              )}
            </div>
          </div>
        </Radio>

        <Radio value="api_key">
          <div>
            <strong>Use API Key</strong> (Pay-as-you-go)
            <p>Use Anthropic API for pay-as-you-go billing</p>
            <input
              type="password"
              placeholder="sk-ant-api03-..."
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </Radio>
      </RadioGroup>
    </div>
  );
}
```

## Checking Claude Code Login Status

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function isClaudeCodeInstalled(): Promise<boolean> {
  try {
    await execAsync('claude-code --version');
    return true;
  } catch {
    return false;
  }
}

export async function isClaudeCodeLoggedIn(): Promise<boolean> {
  try {
    // Run a simple command that requires authentication
    const { stdout } = await execAsync('claude-code --check-auth');
    return stdout.includes('authenticated');
  } catch {
    return false;
  }
}

export async function promptClaudeCodeLogin(): Promise<void> {
  // Open login flow
  await execAsync('claude-code login');
}
```

## Benefits

### For Users
✅ **No API key needed** - Use existing Claude subscription
✅ **Familiar billing** - Charged through Claude plan, not separate API
✅ **Message limits** - Respects Pro/Team/Free tier limits
✅ **Easy setup** - Just log in once with `claude-code login`

### For FactoryFactory
✅ **Better UX** - Users don't need to find/configure API keys
✅ **Wider adoption** - Free tier users can use the system
✅ **No credential management** - Claude Code handles auth
✅ **Fallback option** - Can still support API keys for power users

## Migration Path

### Phase 1: Add Claude Code Support (Parallel)
- Keep existing SDK implementation
- Add Claude Code subprocess integration
- Let users choose in settings

### Phase 2: Make Subscription Default
- Default to Claude Code for new users
- Migrate existing users to offer choice
- Keep API key as fallback

### Phase 3: Optional API Key Removal
- Make API key optional
- Claude Code becomes primary auth method
- SDK only for advanced users

## Installation Instructions for Users

```bash
# 1. Install Claude Code (if not already installed)
npm install -g claude-code
# or
curl -fsSL https://install.claude.ai | sh

# 2. Log in to Claude Code
claude-code login

# 3. Verify login
claude-code --check-auth

# 4. Use FactoryFactory - it will automatically use your Claude subscription!
```

## Comparison

| Feature | Anthropic SDK (Current) | Claude Code (New) |
|---------|------------------------|-------------------|
| **Auth** | API key required | Claude login (one-time) |
| **Billing** | Pay-as-you-go API | Claude subscription |
| **Free tier** | ❌ No free tier | ✅ Free tier available |
| **Message limits** | Rate limits only | Pro/Team limits |
| **Setup** | Find + paste API key | `claude-code login` |
| **User experience** | Developer-focused | User-friendly |

## Next Steps

1. **Install Claude Code** on development machine
2. **Test subprocess spawning** with authentication
3. **Implement ClaudeCodeClient** wrapper
4. **Update worker agent** to support both methods
5. **Add UI** for auth method selection
6. **Document** for users

This is how we achieve the critical requirement of letting users authenticate with their Claude plan!
