# Claude Model Catalog and Explicit Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover Claude models through the Claude ACP runtime and display concise, versioned model labels in both Admin and in-chat selectors without changing saved defaults.

**Architecture:** A temporary, non-persisted `ClaudeAcpAgent` session supplies the global Claude catalog. One pure formatter normalizes Claude model option names at every ACP ingress and in the catalog loader; the user-settings router discovers Claude and Codex concurrently with independent fallbacks.

**Tech Stack:** TypeScript, `@agentclientprotocol/claude-agent-acp`, ACP SDK config options, Express/tRPC, React, Radix dropdowns, Vitest, jsdom, Storybook

## Global Constraints

- Keep `UserSettings.defaultClaudeModel`, its schema default, and every existing saved value unchanged.
- Store and send the original provider option value; normalize display names only.
- Use the Claude ACP runtime as the catalog source; do not parse `claude --help` or add a second static version map.
- The catalog session must use `persistSession: false`, `tools: []`, no MCP servers, and no prompt.
- Exclude project/local workspace settings from the global Admin catalog while preserving user and managed Claude policy.
- Claude and Codex discovery must fail independently.
- Retain the current static Claude aliases and efforts as the fallback.
- Do not show raw resolved model IDs in either dropdown.
- Add or update tests and Storybook coverage for the UI behavior.

---

### Task 1: Normalize concise Claude model labels at every ACP ingress

**Files:**
- Create: `src/backend/services/session/service/acp/claude-model-options.ts`
- Create: `src/backend/services/session/service/acp/claude-model-options.test.ts`
- Modify: `src/backend/services/session/service/acp/acp-session-config-options.ts`
- Create: `src/backend/services/session/service/acp/acp-session-config-options.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.config.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.config.service.test.ts`

**Interfaces:**
- Produces: `formatClaudeModelOptionName(option: Pick<SessionConfigSelectOption, 'value' | 'name' | 'description'>): string`
- Produces: `normalizeSessionConfigOptions(provider: string, configOptions: SessionConfigOption[]): SessionConfigOption[]`
- Consumes: ACP model option descriptions such as `Sonnet 5 · Efficient for routine tasks`
- Preserves: every option `value`, description, ordering, grouping, and non-Claude option

- [ ] **Step 1: Write formatter tests**

Create `claude-model-options.test.ts` with table-driven coverage:

```typescript
import { describe, expect, it } from 'vitest';
import { formatClaudeModelOptionName } from './claude-model-options';

describe('formatClaudeModelOptionName', () => {
  it.each([
    [
      {
        value: 'default',
        name: 'Default (recommended)',
        description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
      },
      'Default — Opus 4.8 (1M)',
    ],
    [
      {
        value: 'opus[1m]',
        name: 'Opus',
        description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
      },
      'Opus 4.8 (1M)',
    ],
    [
      {
        value: 'claude-fable-5[1m]',
        name: 'Fable',
        description: 'Fable 5 · Most capable for hard tasks',
      },
      'Fable 5',
    ],
    [
      { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
      'Sonnet 5',
    ],
    [
      { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
      'Haiku 4.5',
    ],
    [{ value: 'custom', name: 'My Custom Model', description: undefined }, 'My Custom Model'],
  ])('formats $value as an explicit concise label', (option, expected) => {
    expect(formatClaudeModelOptionName(option)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the formatter test to verify RED**

Run:

```bash
pnpm test src/backend/services/session/service/acp/claude-model-options.test.ts
```

Expected: FAIL because `claude-model-options.ts` does not exist.

- [ ] **Step 3: Implement the minimal formatter**

Create `claude-model-options.ts`:

```typescript
import type { SessionConfigSelectOption } from '@agentclientprotocol/sdk';

type ClaudeModelOptionLabelInput = Pick<
  SessionConfigSelectOption,
  'value' | 'name' | 'description'
>;

const CONTEXT_SUFFIX = /\s+with\s+(\d+(?:\.\d+)?[KMG]?)\s+context$/i;
const MODEL_VERSION_TOKEN = /\bv?\d+(?:[.-]\d+)*\b/i;
const GENERIC_MODEL_TOKENS = new Set(['claude', 'default', 'model', 'recommended']);

function modelNameTokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).filter(
    (token) => token.length > 1 && !GENERIC_MODEL_TOKENS.has(token)
  );
}

function isPlausibleModelIdentity(
  identity: string,
  option: ClaudeModelOptionLabelInput
): boolean {
  if (!MODEL_VERSION_TOKEN.test(identity)) {
    return false;
  }
  if (option.value === 'default') {
    return true;
  }

  const identityTokens = new Set(modelNameTokens(identity));
  return modelNameTokens(`${option.name} ${option.value}`).some((token) =>
    identityTokens.has(token)
  );
}

export function formatClaudeModelOptionName(option: ClaudeModelOptionLabelInput): string {
  const identity = option.description?.split('·')[0]?.trim();
  if (!(identity && isPlausibleModelIdentity(identity, option))) {
    return option.name;
  }

  const conciseIdentity = identity.replace(CONTEXT_SUFFIX, ' ($1)');
  return option.value === 'default' ? `Default — ${conciseIdentity}` : conciseIdentity;
}
```

- [ ] **Step 4: Run the formatter test to verify GREEN**

Run:

```bash
pnpm test src/backend/services/session/service/acp/claude-model-options.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write initial-session normalization tests**

Create `acp-session-config-options.test.ts`. Test a Claude response containing
flat and grouped model options, plus a mode option. Assert that
`requireSessionConfigOptions('CLAUDE', 'newSession', response)` changes only the
model option names:

```typescript
import { describe, expect, it } from 'vitest';
import { requireSessionConfigOptions } from './acp-session-config-options';

describe('requireSessionConfigOptions Claude labels', () => {
  it('normalizes flat Claude model names and preserves option values', () => {
    const configOptions = requireSessionConfigOptions('CLAUDE', 'newSession', {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'sonnet',
          options: [
            {
              value: 'default',
              name: 'Default (recommended)',
              description: 'Opus 4.8 with 1M context · Best for everyday tasks',
            },
            {
              value: 'sonnet',
              name: 'Sonnet',
              description: 'Sonnet 5 · Efficient for routine tasks',
            },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
    });

    expect(configOptions[0]?.options).toEqual([
      expect.objectContaining({ value: 'default', name: 'Default — Opus 4.8 (1M)' }),
      expect.objectContaining({ value: 'sonnet', name: 'Sonnet 5' }),
    ]);
    expect(configOptions[1]?.options).toEqual([{ value: 'default', name: 'Default' }]);
  });
});
```

Add a second test with a `SessionConfigSelectGroup[]` model option and assert
the nested names become `Fable 5` and `Haiku 4.5` while group names remain
unchanged.

- [ ] **Step 6: Run the normalization test to verify RED**

Run:

```bash
pnpm test src/backend/services/session/service/acp/acp-session-config-options.test.ts
```

Expected: FAIL because non-default Claude options still retain unversioned names.

- [ ] **Step 7: Route all Claude model options through the formatter**

In `acp-session-config-options.ts`:

1. Import `formatClaudeModelOptionName`.
2. Replace the current default-only `normalizeClaudeModelOption` implementation
   with:

```typescript
function normalizeClaudeModelOption(
  option: SessionConfigSelectOption
): SessionConfigSelectOption {
  return {
    ...option,
    name: formatClaudeModelOptionName(option),
  };
}
```

3. Remove `resolveModelFamilyName`, which is superseded by the formatter.
4. Export `normalizeSessionConfigOptions` so notification handling can use the
   same boundary.

- [ ] **Step 8: Run ACP config-option tests to verify GREEN**

Run:

```bash
pnpm test src/backend/services/session/service/acp/acp-session-config-options.test.ts \
  src/backend/services/session/service/acp/acp-runtime-manager.test.ts
```

Expected: PASS. Update existing runtime-manager expectations from `Opus 4.6` to
the approved `Default — Opus 4.6` form where the test fixture represents the
`default` option.

- [ ] **Step 9: Write the mid-session update regression test**

In `session.config.service.test.ts`, add:

```typescript
it('normalizes Claude model labels in asynchronous config option updates', () => {
  const handle = unsafeCoerce<AcpProcessHandle>({
    provider: 'CLAUDE',
    providerSessionId: 'provider-session-1',
    configOptions: [],
  });
  const incoming = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'sonnet',
      options: [
        {
          value: 'sonnet',
          name: 'Sonnet',
          description: 'Sonnet 5 · Efficient for routine tasks',
        },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }],
    },
  ];

  service.applyConfigOptionsUpdateDelta('session-1', handle, unsafeCoerce(incoming));

  expect(handle.configOptions[0]?.options).toEqual([
    expect.objectContaining({ value: 'sonnet', name: 'Sonnet 5' }),
  ]);
  expect(sessionDomain.emitDelta).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({
      type: 'config_options_update',
      configOptions: handle.configOptions,
    })
  );
});
```

- [ ] **Step 10: Run the mid-session test to verify RED**

Run:

```bash
pnpm test src/backend/services/session/service/lifecycle/session.config.service.test.ts
```

Expected: FAIL because `applyConfigOptionsUpdateDelta` currently stores and emits
the raw notification options.

- [ ] **Step 11: Normalize notification options before storage and emission**

Import `normalizeSessionConfigOptions` into `session.config.service.ts` and
change `applyConfigOptionsUpdateDelta` to normalize once:

```typescript
const normalizedConfigOptions = normalizeSessionConfigOptions(
  handle.provider,
  configOptions
);
handle.configOptions = normalizedConfigOptions;
```

Use `normalizedConfigOptions` for snapshot persistence and the
`config_options_update` delta. Build chat capabilities from the updated handle.

- [ ] **Step 12: Run all Task 1 tests to verify GREEN**

Run:

```bash
pnpm test src/backend/services/session/service/acp/claude-model-options.test.ts \
  src/backend/services/session/service/acp/acp-session-config-options.test.ts \
  src/backend/services/session/service/acp/acp-runtime-manager.test.ts \
  src/backend/services/session/service/lifecycle/session.config.service.test.ts
```

Expected: PASS.

- [ ] **Step 13: Commit Task 1**

```bash
git add src/backend/services/session/service/acp/claude-model-options.ts \
  src/backend/services/session/service/acp/claude-model-options.test.ts \
  src/backend/services/session/service/acp/acp-session-config-options.ts \
  src/backend/services/session/service/acp/acp-session-config-options.test.ts \
  src/backend/services/session/service/acp/acp-runtime-manager.test.ts \
  src/backend/services/session/service/lifecycle/session.config.service.ts \
  src/backend/services/session/service/lifecycle/session.config.service.test.ts
git commit -m "Show resolved Claude model versions"
```

### Task 2: Add the ephemeral Claude ACP catalog loader

**Files:**
- Create: `src/backend/services/session/service/acp/claude-model-catalog-loader.ts`
- Create: `src/backend/services/session/service/acp/claude-model-catalog-loader.test.ts`
- Modify: `src/backend/services/session/service/acp/index.ts`
- Modify: `src/backend/services/session/service/index.ts`
- Modify: `src/backend/app-context.ts`

**Interfaces:**
- Produces: `ClaudeModelCatalogEntry = { id: string; displayName: string; description: string | null }`
- Produces: `fetchClaudeModelCatalogFromAcp(): Promise<ClaudeModelCatalogEntry[]>`
- Consumes: `ClaudeAcpAgent.newSession(...).configOptions`
- Exposes: `ApplicationServices.fetchClaudeModelCatalogFromAcp`

- [ ] **Step 1: Write catalog loader tests with a mocked ACP agent**

Create `claude-model-catalog-loader.test.ts`. Hoist mocks for `initialize`,
`newSession`, `closeSession`, and `dispose`, then replace `ClaudeAcpAgent` with a
test class through `vi.mock('@agentclientprotocol/claude-agent-acp', ...)`.

The success fixture must return:

```typescript
mockNewSession.mockResolvedValue({
  sessionId: 'catalog-session',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'default',
      options: [
        {
          value: 'default',
          name: 'Default (recommended)',
          description: 'Opus 4.8 with 1M context · Best for everyday tasks',
        },
        {
          value: 'claude-fable-5[1m]',
          name: 'Fable',
          description: 'Fable 5 · Most capable for hard tasks',
        },
        {
          value: 'sonnet',
          name: 'Sonnet',
          description: 'Sonnet 5 · Efficient for routine tasks',
        },
      ],
    },
  ],
});
```

Assert the returned catalog is:

```typescript
expect(await fetchClaudeModelCatalogFromAcp()).toEqual([
  {
    id: 'default',
    displayName: 'Default — Opus 4.8 (1M)',
    description: 'Opus 4.8 with 1M context · Best for everyday tasks',
  },
  {
    id: 'claude-fable-5[1m]',
    displayName: 'Fable 5',
    description: 'Fable 5 · Most capable for hard tasks',
  },
  {
    id: 'sonnet',
    displayName: 'Sonnet 5',
    description: 'Sonnet 5 · Efficient for routine tasks',
  },
]);
expect(mockCloseSession).toHaveBeenCalledWith({ sessionId: 'catalog-session' });
expect(mockDispose).toHaveBeenCalledOnce();
```

Also assert the `newSession` request uses `tmpdir()`, no MCP servers, and ACP
metadata containing `persistSession: false`, `settingSources: ['user']`, and
`tools: []`.

Add failure tests:

- a response with no model config option rejects with
  `Claude ACP session did not provide model options`, then closes and disposes;
- a rejected `initialize` disposes the agent and never calls `closeSession`;
- a rejected `newSession` still disposes the agent and does not call
  `closeSession` without a returned session ID;
- a rejected `closeSession` still calls `dispose`, logs the cleanup error, and
  preserves an already-discovered catalog or the original discovery error.

- [ ] **Step 2: Run the loader test to verify RED**

Run:

```bash
pnpm test src/backend/services/session/service/acp/claude-model-catalog-loader.test.ts
```

Expected: FAIL because the loader does not exist.

- [ ] **Step 3: Implement the catalog loader**

Create `claude-model-catalog-loader.ts` with:

```typescript
import { tmpdir } from 'node:os';
import { ClaudeAcpAgent, type NewSessionMeta } from '@agentclientprotocol/claude-agent-acp';
import { PROTOCOL_VERSION, type SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import { createLogger } from '@/backend/services/logger.service';
import { formatClaudeModelOptionName } from './claude-model-options';

export type ClaudeModelCatalogEntry = {
  id: string;
  displayName: string;
  description: string | null;
};
```

Build the no-prompt client using
`ConstructorParameters<typeof ClaudeAcpAgent>[0]`. Void notification methods may
be no-ops; request/IO methods must throw `Claude catalog discovery cannot service
ACP callbacks` if unexpectedly invoked. Adapt the repository logger to the
Claude agent's two-method logger interface:

```typescript
const appLogger = createLogger('claude-model-catalog-loader');
const claudeLogger: NonNullable<ConstructorParameters<typeof ClaudeAcpAgent>[1]> = {
  log: (...args: unknown[]) => appLogger.debug('Claude ACP catalog', { args }),
  error: (...args: unknown[]) => appLogger.warn('Claude ACP catalog', { args }),
};
```

Use this lifecycle exactly:

```typescript
const agent = new ClaudeAcpAgent(client, claudeLogger);
let providerSessionId: string | null = null;

try {
  await agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const meta: NewSessionMeta = {
    claudeCode: {
      options: {
        persistSession: false,
        settingSources: ['user'],
        tools: [],
      },
    },
  };
  const result = await agent.newSession({
    cwd: tmpdir(),
    mcpServers: [],
    _meta: meta,
  });
  providerSessionId = result.sessionId;

  const modelOption = result.configOptions
    .filter((option) => option.type === 'select')
    .find((option) => option.category === 'model' || option.id === 'model');
  if (!modelOption) {
    throw new Error('Claude ACP session did not provide model options');
  }

  const options = modelOption.options.flatMap((option): SessionConfigSelectOption[] =>
    'group' in option ? option.options : [option]
  );
  if (options.length === 0) {
    throw new Error('Claude ACP session did not provide model options');
  }

  return options.map((option) => ({
    id: option.value,
    displayName: formatClaudeModelOptionName(option),
    description: option.description ?? null,
  }));
} finally {
  try {
    if (providerSessionId) {
      try {
        await agent.closeSession({ sessionId: providerSessionId });
      } catch (error) {
        appLogger.warn('Failed to close Claude ACP catalog session', { error });
      }
    }
  } finally {
    await agent.dispose();
  }
}
```

Keep the implementation local to the session capsule and do not export the
no-op client.

- [ ] **Step 4: Run the loader test to verify GREEN**

Run:

```bash
pnpm test src/backend/services/session/service/acp/claude-model-catalog-loader.test.ts
```

Expected: PASS.

- [ ] **Step 5: Export and inject the loader**

Export `fetchClaudeModelCatalogFromAcp` and `ClaudeModelCatalogEntry` through:

- `src/backend/services/session/service/acp/index.ts`;
- `src/backend/services/session/service/index.ts`.

In `app-context.ts`:

1. Import `fetchClaudeModelCatalogFromAcp` from the session capsule.
2. Add
   `fetchClaudeModelCatalogFromAcp: typeof fetchClaudeModelCatalogFromAcp` to
   `ApplicationServices`.
3. Add the function to `createDefaultApplicationDependencies().services`.

- [ ] **Step 6: Verify exports and application context types**

Run:

```bash
pnpm typecheck
pnpm deps:check
```

Expected: both commands pass with no service-boundary violations.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/backend/services/session/service/acp/claude-model-catalog-loader.ts \
  src/backend/services/session/service/acp/claude-model-catalog-loader.test.ts \
  src/backend/services/session/service/acp/index.ts \
  src/backend/services/session/service/index.ts \
  src/backend/app-context.ts
git commit -m "Load Claude model catalog from ACP"
```

### Task 3: Use dynamic Claude options with independent provider fallbacks

**Files:**
- Modify: `src/backend/trpc/user-settings.trpc.ts`
- Modify: `src/backend/trpc/user-settings.router.test.ts`

**Interfaces:**
- Consumes: `ApplicationServices.fetchClaudeModelCatalogFromAcp`
- Consumes: `ApplicationServices.fetchCodexModelCatalogFromAppServer`
- Produces: unchanged `getProviderOptions` response shape with
  `CLAUDE.source: 'cli' | 'fallback'`

- [ ] **Step 1: Extend the router test context**

Add a hoisted `mockFetchClaudeModelCatalogFromAcp` and expose it through the
test caller's `appContext.services`:

```typescript
fetchClaudeModelCatalogFromAcp: (...args: unknown[]) =>
  mockFetchClaudeModelCatalogFromAcp(...args),
```

Reset it in `beforeEach` and give both catalog mocks successful default values so
unrelated router tests do not depend on fallback paths.

- [ ] **Step 2: Write the dynamic Claude provider-options test**

Configure the Claude mock with normalized catalog entries and assert:

```typescript
expect((await createCaller().getProviderOptions()).CLAUDE).toEqual({
  source: 'cli',
  models: [
    {
      value: 'default',
      label: 'Default — Opus 4.8 (1M)',
      description: 'Opus 4.8 with 1M context · Best for everyday tasks',
    },
    {
      value: 'claude-fable-5[1m]',
      label: 'Fable 5',
      description: 'Fable 5 · Most capable for hard tasks',
    },
    {
      value: 'sonnet',
      label: 'Sonnet 5',
      description: 'Sonnet 5 · Efficient for routine tasks',
    },
  ],
  efforts: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
});
```

- [ ] **Step 3: Write Claude fallback and independence tests**

Add one test where Claude rejects with `claude unavailable` and Codex succeeds.
Assert Claude contains the static `sonnet`, `opus`, `haiku`, and `fable` options
plus `error: 'claude unavailable'`, while Codex still has `source: 'cli'`.

Add the inverse test: Claude succeeds while Codex rejects, and assert the Claude
catalog remains dynamic while Codex uses its fallback.

- [ ] **Step 4: Write the concurrency test**

Use two controllable promises for the catalog mocks. Call
`createCaller().getProviderOptions()` without awaiting it, wait one microtask,
and assert both fetchers have already been called. Resolve both promises and
await the result so the test leaves no pending work.

- [ ] **Step 5: Run router tests to verify RED**

Run:

```bash
pnpm test src/backend/trpc/user-settings.router.test.ts
```

Expected: FAIL because the router never calls the Claude catalog service.

- [ ] **Step 6: Implement Claude provider option discovery**

Add:

```typescript
async function getClaudeProviderOptions(
  fetchClaudeModelCatalogFromAcp: ApplicationServices['fetchClaudeModelCatalogFromAcp']
): Promise<ProviderOptions> {
  try {
    const catalog = await fetchClaudeModelCatalogFromAcp();
    return {
      source: 'cli',
      models: catalog.map((model) => ({
        value: model.id,
        label: model.displayName,
        description: model.description,
      })),
      efforts: CLAUDE_FALLBACK_OPTIONS.efforts,
    };
  } catch (error) {
    return {
      ...CLAUDE_FALLBACK_OPTIONS,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

Change the query to start both discoveries together:

```typescript
const [claude, codex] = await Promise.all([
  getClaudeProviderOptions(ctx.appContext.services.fetchClaudeModelCatalogFromAcp),
  getCodexProviderOptions(ctx.appContext.services.fetchCodexModelCatalogFromAppServer),
]);
return { CLAUDE: claude, CODEX: codex };
```

- [ ] **Step 7: Run router tests to verify GREEN**

Run:

```bash
pnpm test src/backend/trpc/user-settings.router.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/backend/trpc/user-settings.trpc.ts \
  src/backend/trpc/user-settings.router.test.ts
git commit -m "Use Claude catalog in provider settings"
```

### Task 4: Verify explicit labels in both selectors and add visual coverage

**Files:**
- Modify: `src/client/routes/admin-page.test.tsx`
- Modify: `src/client/features/chat/chat-input/components/acp-config-selector.tsx`
- Create: `src/client/features/chat/chat-input/components/acp-config-selector.test.tsx`
- Create: `src/client/features/chat/chat-input/components/acp-config-selector.stories.tsx`

**Interfaces:**
- Consumes: Admin `ProviderOptions.models[].label`
- Consumes: live ACP `AcpConfigOption.options[].name`
- Produces: selector callbacks containing the original option value

- [ ] **Step 1: Make Admin provider options controllable in tests**

Move the provider-options fixture into the hoisted `mocks` object and return
`mocks.providerOptions` from the mocked tRPC query. Reset it in `beforeEach` to:

```typescript
{
  CLAUDE: {
    source: 'cli',
    models: [
      { value: 'default', label: 'Default — Opus 4.8 (1M)' },
      { value: 'claude-fable-5[1m]', label: 'Fable 5' },
      { value: 'sonnet', label: 'Sonnet 5' },
    ],
    efforts: [{ value: 'medium', label: 'Medium' }],
  },
  CODEX: {
    source: 'fallback',
    models: [{ value: 'default', label: 'Default' }],
    efforts: [{ value: 'medium', label: 'Medium' }],
  },
}
```

- [ ] **Step 2: Write the Admin selector test**

Render `AdminDashboardPage`, open `#default-claude-model`, and assert the
listbox contains `Default — Opus 4.8 (1M)`, `Fable 5`, and `Sonnet 5`. Select
`Fable 5` and assert:

```typescript
expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
  defaultClaudeModel: 'claude-fable-5[1m]',
});
```

Add a second test with `mocks.userSettings.defaultClaudeModel = 'claude-legacy'`.
Open the selector and assert `claude-legacy` is present alongside the discovered
options. This preserves saved custom or retired model values without adding them
to the backend catalog.

- [ ] **Step 3: Run the Admin test**

Run:

```bash
pnpm test src/client/routes/admin-page.test.tsx
```

Expected: PASS after the fixture change, proving Admin already renders backend
labels and saves raw values.

- [ ] **Step 4: Write the in-chat ACP selector test**

Create a jsdom test that renders `AcpConfigSelector` with:

```typescript
const modelOption: AcpConfigOption = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'sonnet',
  options: [
    { value: 'default', name: 'Default — Opus 4.8 (1M)' },
    { value: 'claude-fable-5[1m]', name: 'Fable 5' },
    { value: 'sonnet', name: 'Sonnet 5' },
  ],
};
```

Assert the trigger reads `Sonnet 5`, open it, assert all three labels are in the
menu, and assert the menu class initially does not satisfy the approved wide,
responsive layout. Choose `Fable 5` and assert:

```typescript
expect(onSelect).toHaveBeenCalledWith('model', 'claude-fable-5[1m]');
```

Use these layout assertions after opening the menu:

```typescript
expect(menu?.className).toContain('w-64');
expect(menu?.className).toContain('max-w-[calc(100vw-2rem)]');
```

- [ ] **Step 5: Run the in-chat test before layout changes**

Run:

```bash
pnpm test src/client/features/chat/chat-input/components/acp-config-selector.test.tsx
```

Expected: FAIL because the current menu uses `w-48` and lacks the responsive
maximum width. Confirm the label and raw-value assertions otherwise describe the
existing selector contract.

- [ ] **Step 6: Widen the versioned-label menu**

In `acp-config-selector.tsx`, change the trigger bound from `max-w-[12rem]` to
`max-w-[14rem]`, and change the menu to:

```tsx
<DropdownMenuContent
  align="start"
  className="w-64 max-w-[calc(100vw-2rem)]"
>
```

Keep truncation on the trigger and allow the menu entries to show the concise
labels.

- [ ] **Step 7: Add the Storybook story**

Create `acp-config-selector.stories.tsx`:

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import { AcpConfigSelector } from './acp-config-selector';

const modelOption: AcpConfigOption = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'sonnet',
  options: [
    { value: 'default', name: 'Default — Opus 4.8 (1M)' },
    { value: 'opus[1m]', name: 'Opus 4.8 (1M)' },
    { value: 'claude-fable-5[1m]', name: 'Fable 5' },
    { value: 'sonnet', name: 'Sonnet 5' },
    { value: 'haiku', name: 'Haiku 4.5' },
  ],
};

const meta = {
  title: 'Chat/Input/AcpConfigSelector',
  component: AcpConfigSelector,
  parameters: { layout: 'centered' },
  args: {
    configOption: modelOption,
    onSelect: fn(),
    disabled: false,
  },
} satisfies Meta<typeof AcpConfigSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeModels: Story = {};
```

- [ ] **Step 8: Verify client tests and Storybook compilation**

Run:

```bash
pnpm test src/client/routes/admin-page.test.tsx \
  src/client/features/chat/chat-input/components/acp-config-selector.test.tsx
pnpm build:storybook
```

Expected: tests pass and Storybook builds without type or rendering errors.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/client/routes/admin-page.test.tsx \
  src/client/features/chat/chat-input/components/acp-config-selector.tsx \
  src/client/features/chat/chat-input/components/acp-config-selector.test.tsx \
  src/client/features/chat/chat-input/components/acp-config-selector.stories.tsx
git commit -m "Show explicit Claude models in selectors"
```

### Task 5: Document behavior and run complete verification

**Files:**
- Modify: `AGENTS.md` under **ACP Runtime**
- Review: all changes since `main`

**Interfaces:**
- Consumes: completed catalog loader, normalization, router, and selector work
- Produces: current repository guidance and a fully verified branch

- [ ] **Step 1: Update the ACP Runtime feature note**

Append this behavior to the ACP Runtime note without removing existing details:

```markdown
Admin Claude model options come from an ephemeral, non-persisted Claude ACP
session with tools disabled; discovery failure falls back to static aliases.
Claude model names are normalized from provider descriptions at every ACP config
ingress so Admin and in-chat selectors show explicit family versions while
preserving raw provider values and configured defaults.
```

- [ ] **Step 2: Run formatting and focused regression tests**

```bash
pnpm check:fix
pnpm test src/backend/services/session/service/acp/claude-model-options.test.ts \
  src/backend/services/session/service/acp/acp-session-config-options.test.ts \
  src/backend/services/session/service/acp/claude-model-catalog-loader.test.ts \
  src/backend/services/session/service/acp/acp-runtime-manager.test.ts \
  src/backend/services/session/service/lifecycle/session.config.service.test.ts \
  src/backend/trpc/user-settings.router.test.ts \
  src/client/routes/admin-page.test.tsx \
  src/client/features/chat/chat-input/components/acp-config-selector.test.tsx
```

Expected: formatting completes cleanly and all focused suites pass.

- [ ] **Step 3: Run repository-wide verification**

```bash
pnpm typecheck
pnpm check
pnpm test
pnpm build
pnpm build:storybook
```

Expected: typecheck, guardrails, application build, and Storybook build exit
successfully with no new warnings or dependency-boundary violations. The full
suite must introduce no failures beyond the pre-existing timing-sensitive
`src/backend/lib/shell.test.ts` failures tracked in
https://github.com/purplefish-ai/factory-factory/issues/2150. Record the exact
full-suite result; any other failure is a regression to investigate before
completion.

- [ ] **Step 4: Review the complete diff and defaults**

```bash
git diff main...HEAD
git status -sb
rg -n "defaultClaudeModel.*sonnet|default\('sonnet'\)" prisma src
```

Confirm:

- no Prisma schema or migration changed;
- no existing Claude default changed;
- raw model values still flow through save and selection callbacks;
- only Claude display names are normalized;
- the worktree contains no unrelated changes.

- [ ] **Step 5: Commit documentation or formatting follow-up**

```bash
git add AGENTS.md
git commit -m "Document Claude model discovery"
```

If `pnpm check:fix` changed implementation files after their task commits, stage
only those formatting changes with `AGENTS.md` and describe them in the commit
body.

- [ ] **Step 6: Request code review**

Invoke `superpowers:requesting-code-review` and provide the approved spec, this
plan, the full diff from `main`, and the verification results. Address any
validated findings before declaring completion.

- [ ] **Step 7: Finish the development branch**

Invoke `superpowers:verification-before-completion`, rerun any command affected
by review fixes, then use `superpowers:finishing-a-development-branch` to offer
the repository's supported integration choices.
