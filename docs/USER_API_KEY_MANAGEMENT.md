# User API Key Management for FactoryFactory

## Overview

Instead of using a single hardcoded `ANTHROPIC_API_KEY`, allow each user to provide their own Claude API key. This enables:

- **Cost transparency**: Users pay for their own Claude usage
- **Usage limits**: Each user has their own rate limits
- **Security**: No shared credentials
- **Compliance**: Better for enterprise deployments

## Architecture

```
User Account
  └── Settings
      └── API Keys
          ├── Anthropic API Key (encrypted)
          ├── GitHub Token (encrypted)
          └── Linear API Key (encrypted)

Worker Agent
  └── Uses authenticated user's API key
  └── Logs usage for billing/analytics
```

## Implementation Steps

### 1. Add User API Key Storage

**Database Schema** (add to Prisma):

```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?

  // Encrypted API keys
  anthropicApiKey String? // Encrypted with app secret
  githubToken     String? // Encrypted
  linearApiKey    String? // Encrypted

  // Preferences
  preferredModel  String? // Default: claude-sonnet-4-5-20250929

  // Relations
  createdAgents Agent[]
  createdEpics  Epic[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Agent {
  id String @id @default(uuid())

  // Add user ownership
  userId String?
  user   User?   @relation(fields: [userId], references: [id])

  // ... existing fields
}
```

### 2. Update Claude Client

**Before** (single global key):
```typescript
export class ClaudeClient {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = new Anthropic({ apiKey });
  }
}
```

**After** (per-user keys):
```typescript
export class ClaudeClient {
  private clients: Map<string, Anthropic>;

  constructor() {
    this.clients = new Map();
  }

  /**
   * Get or create Anthropic client for a specific user
   */
  getClientForUser(userId: string, apiKey: string): Anthropic {
    if (!this.clients.has(userId)) {
      this.clients.set(userId, new Anthropic({ apiKey }));
    }
    return this.clients.get(userId)!;
  }

  /**
   * Create agent with user's API key
   */
  async createAgentForUser(
    userId: string,
    apiKey: string,
    agentId: string,
    config: CreateAgentConfig
  ): Promise<void> {
    const client = this.getClientForUser(userId, apiKey);

    this.sessions.set(agentId, {
      userId,
      client,
      systemPrompt: config.systemPrompt,
      profile: config.profile,
      messages: [],
      tools: config.tools || [],
    });
  }
}
```

### 3. Update Worker Creation

```typescript
export async function createWorker(
  taskId: string,
  userId: string // NEW: user creating the worker
): Promise<string> {
  // Get user settings with API key
  const userSettings = await getUserSettings(userId);

  if (!userSettings.anthropicApiKey) {
    throw new Error('User has not configured Anthropic API key');
  }

  // Decrypt API key (stored encrypted in DB)
  const apiKey = decrypt(userSettings.anthropicApiKey);

  // Create worker with user's key
  const agent = await agentAccessor.create({
    type: AgentType.WORKER,
    userId, // Track who created this agent
    currentTaskId: taskId,
  });

  // Initialize Claude with user's key
  await claudeClient.createAgentForUser(
    userId,
    apiKey,
    agent.id,
    {
      systemPrompt: buildWorkerPrompt(taskId, task.title),
      tools: convertMcpToolsToAnthropicFormat(),
      profile: getProfileForAgentType(AgentType.WORKER),
    }
  );

  return agent.id;
}
```

### 4. Add API Key Management UI

**API Endpoints**:

```typescript
// GET /api/user/settings
router.get('/settings', authenticateUser, async (req, res) => {
  const user = await getUserById(req.userId);

  return res.json({
    hasAnthropicKey: !!user.anthropicApiKey,
    hasGitHubToken: !!user.githubToken,
    preferredModel: user.preferredModel,
    // Never return actual keys
  });
});

// POST /api/user/settings/anthropic-key
router.post('/settings/anthropic-key', authenticateUser, async (req, res) => {
  const { apiKey } = req.body;

  // Validate key works
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'test' }],
    });
  } catch (error) {
    return res.status(400).json({
      error: 'Invalid API key or API key does not have access',
    });
  }

  // Encrypt and store
  const encryptedKey = encrypt(apiKey);
  await updateUserSettings(req.userId, {
    anthropicApiKey: encryptedKey,
  });

  return res.json({ success: true });
});
```

**Frontend Component**:

```tsx
// Settings page
function APIKeySettings() {
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);

  return (
    <div>
      <h2>Claude API Settings</h2>

      {!hasKey ? (
        <div>
          <p>You need a Claude API key to use workers.</p>
          <a href="https://console.anthropic.com/" target="_blank">
            Get your API key from Anthropic Console →
          </a>

          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-api03-..."
          />

          <button onClick={() => saveApiKey(apiKey)}>
            Save API Key
          </button>
        </div>
      ) : (
        <div>
          <p>✓ API key configured</p>
          <button onClick={() => removeApiKey()}>Remove Key</button>
        </div>
      )}
    </div>
  );
}
```

### 5. Encryption Utilities

```typescript
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!; // 32-byte key
const ALGORITHM = 'aes-256-gcm';

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Return: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedData: string): string {
  const [ivHex, authTagHex, encrypted] = encryptedData.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

## User Flow

1. **User signs up** → Create account
2. **User goes to Settings** → "API Keys" section
3. **User adds Anthropic API key** → Validated and encrypted
4. **User creates task** → Worker uses their key
5. **Worker executes** → Costs charged to user's Anthropic account
6. **User views usage** → Dashboard shows API usage/costs

## Benefits

✅ **Security**: Each user's key is encrypted at rest
✅ **Isolation**: User A's workers can't use User B's quota
✅ **Transparency**: Users see their own Claude usage
✅ **Scalability**: No single API key rate limit bottleneck
✅ **Compliance**: Better for enterprise (each employee owns their key)

## Migration Path

For existing deployments with `ANTHROPIC_API_KEY`:

1. Add User table and API key fields
2. Keep `ANTHROPIC_API_KEY` as fallback for system tasks
3. Use user keys when available, fallback to system key
4. Gradually migrate users to provide their own keys

```typescript
async function getApiKeyForWorker(userId?: string): Promise<string> {
  // Prefer user's key
  if (userId) {
    const user = await getUserById(userId);
    if (user.anthropicApiKey) {
      return decrypt(user.anthropicApiKey);
    }
  }

  // Fallback to system key
  const systemKey = process.env.ANTHROPIC_API_KEY;
  if (!systemKey) {
    throw new Error('No API key available');
  }

  return systemKey;
}
```

## Alternative: Claude for Work Integration

If you want true "login with Claude" instead of API keys:

**Wait for Anthropic to release**:
- OAuth provider for Claude accounts
- Team/workspace SSO integration
- API key management through Claude Console with OAuth

As of January 2025, this doesn't exist yet, but Anthropic may add it in the future for enterprise customers.

For now, **user-provided API keys** is the recommended approach.
