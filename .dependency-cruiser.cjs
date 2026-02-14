/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies cause subtle runtime issues and make the codebase harder to reason about',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-accessors-importing-application-layers',
      severity: 'error',
      comment:
        'Resource accessors should remain pure data access and not depend on application/domain layers',
      from: { path: '^src/backend/resource_accessors' },
      to: {
        path: '^src/backend/(domains|orchestration|routers|trpc|agents|services)/',
      },
    },
    {
      name: 'no-services-importing-domains',
      severity: 'error',
      comment:
        'Infrastructure services must not depend on domain modules. Move domain logic into domains/ or orchestration/',
      from: { path: '^src/backend/services' },
      to: { path: '^src/backend/domains' },
    },
    {
      name: 'no-services-importing-accessors',
      severity: 'error',
      comment:
        'Infrastructure services must not depend on resource accessors. Data access should live in domains or orchestration',
      from: { path: '^src/backend/services' },
      to: { path: '^src/backend/resource_accessors' },
    },
    {
      name: 'no-services-importing-agents',
      severity: 'error',
      comment: 'Services should not depend on agents - agents should depend on services',
      from: { path: '^src/backend/services' },
      to: { path: '^src/backend/agents' },
    },
    {
      name: 'no-services-importing-routers',
      severity: 'error',
      comment: 'Services should not depend on routers - routers should depend on services',
      from: { path: '^src/backend/services' },
      to: { path: '^src/backend/routers' },
    },
    {
      name: 'no-lib-importing-application-layers',
      severity: 'error',
      comment:
        'Backend lib helpers should remain low-level and must not depend on domains, orchestration, routers, agents, or accessors',
      from: { path: '^src/backend/lib' },
      to: {
        path: '^src/backend/(domains|orchestration|routers|trpc|agents|resource_accessors)/',
      },
    },
    {
      name: 'no-lib-importing-services-without-allowlist',
      severity: 'error',
      comment:
        'Backend lib helpers should avoid service coupling. If a lib helper needs a service dependency, add an explicit allowlist entry.',
      from: {
        path: '^src/backend/lib',
        pathNot:
          '^src/backend/lib/(file-lock-mutex|session-summaries)\\.ts$|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/services/' },
    },
    {
      name: 'no-mcp-routers-importing-agents',
      severity: 'error',
      // task.mcp.ts is exempted because it's the MCP endpoint for managing agent
      // lifecycle itself (startWorker, killWorkerAndCleanup). Unlike other MCP tools
      // that provide capabilities TO agents, task.mcp.ts provides control OVER agents.
      // This is fundamentally different - it's agent management, not agent capability.
      comment:
        'MCP routers should not import agent logic directly (except task.mcp.ts for worker lifecycle)',
      from: {
        path: '^src/backend/routers/mcp',
        pathNot: '^src/backend/routers/mcp/task\\.mcp\\.ts$',
      },
      to: { path: '^src/backend/agents' },
    },
    {
      name: 'no-frontend-importing-backend',
      severity: 'error',
      comment:
        'Frontend UI layers should not import backend directly - use API contracts/shared schemas instead',
      from: {
        path: '^src/(client|components|frontend)',
        pathNot: '^src/frontend/lib/trpc\\.ts$',
      },
      to: { path: '^src/backend' },
    },
    {
      name: 'no-importing-legacy-shared-claude-protocol',
      severity: 'error',
      comment:
        'Import shared protocol contracts from src/shared/acp-protocol, not src/shared/claude.',
      from: { path: '^src/' },
      to: { path: '^src/shared/claude/' },
    },
    {
      name: 'no-importing-legacy-claude-types-facade',
      severity: 'error',
      comment:
        'Import chat protocol helpers from src/lib/chat-protocol; the Claude-named facade was removed.',
      from: { path: '^src/' },
      to: { path: '^src/lib/claude-types\\.ts$' },
    },
    {
      name: 'no-importing-backend-constants-barrel',
      severity: 'error',
      comment:
        'Import from concrete constants modules (e.g. constants/http, constants/websocket), not constants/index.',
      from: { path: '^src/' },
      to: { path: '^src/backend/constants/index\\.ts$' },
    },
    {
      name: 'no-importing-backend-services-barrel',
      severity: 'error',
      comment:
        'Import from concrete service modules, not services/index.',
      from: { path: '^src/' },
      to: { path: '^src/backend/services/index\\.ts$' },
    },
    {
      name: 'no-importing-backend-orchestration-barrel',
      severity: 'error',
      comment:
        'Import concrete orchestration modules directly, not orchestration/index.',
      from: { path: '^src/' },
      to: { path: '^src/backend/orchestration/index\\.ts$' },
    },
    {
      name: 'no-importing-resource-accessors-index-barrel',
      severity: 'error',
      comment:
        'Import concrete resource accessor modules directly, not resource_accessors/index.',
      from: { path: '^src/' },
      to: { path: '^src/backend/resource_accessors/index\\.ts$' },
    },
    {
      name: 'frontend-trpc-only-imports-backend-trpc',
      severity: 'error',
      comment: 'src/frontend/lib/trpc.ts may only import backend tRPC types, not other backend modules',
      from: { path: '^src/frontend/lib/trpc\\.ts$' },
      to: {
        path: '^src/backend/',
        pathNot: '^src/backend/trpc/',
      },
    },
    {
      name: 'no-trpc-importing-accessors',
      severity: 'error',
      comment: 'tRPC routers should use services, not access data directly via resource accessors',
      from: { path: '^src/backend/trpc' },
      to: { path: '^src/backend/resource_accessors' },
    },
    {
      name: 'only-domains-or-orchestration-import-accessors',
      severity: 'error',
      comment:
        'Resource accessors are data-layer internals and may only be imported by domains and orchestration',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/(domains/|orchestration/|resource_accessors/)|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/resource_accessors/' },
    },
    {
      name: 'no-direct-claude-session-accessor-imports',
      severity: 'error',
      comment:
        'Use agent-session.accessor at call sites; keep claude-session accessor behind that alias during migration.',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/resource_accessors/(claude-session|agent-session)\\.accessor\\.ts$|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/resource_accessors/claude-session\\.accessor\\.ts$' },
    },
    {
      name: 'session-model-import-boundary',
      severity: 'error',
      comment:
        'Session-model normalization is provider/session-specific and should only be consumed by the session domain and resource accessors.',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/(domains/session/|resource_accessors/)|^src/backend/lib/session-model\\.ts$|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/lib/session-model\\.ts$' },
    },
    {
      name: 'only-allowlisted-orchestration-import-accessors',
      severity: 'error',
      comment:
        'Orchestration accessor imports must stay explicit and minimal. Add new files here only with clear rationale.',
      from: {
        path: '^src/backend/orchestration/',
        pathNot:
          '^src/backend/orchestration/(workspace-init\\.orchestrator|snapshot-reconciliation\\.orchestrator|scheduler\\.service|health\\.service|decision-log-query\\.service|data-backup\\.service|types)\\.ts$|^src/backend/orchestration/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/resource_accessors/' },
    },
    {
      name: 'no-shared-importing-app-layers',
      severity: 'error',
      comment:
        'Shared contracts must stay framework/domain neutral and not depend on backend or UI layers',
      from: { path: '^src/shared' },
      to: { path: '^src/(backend|client|frontend|components)' },
    },
    {
      name: 'no-backend-importing-ui-layers',
      severity: 'error',
      comment: 'Backend domain/application layers should not depend on UI modules',
      from: { path: '^src/backend' },
      to: { path: '^src/(client|frontend|components)' },
    },
    {
      name: 'only-session-domain-imports-session-store',
      severity: 'error',
      comment:
        'Session transcript/store internals are single-writer infrastructure and may only be imported by the session domain layer',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/domains/session/|^src/backend/services/session-store\\.service\\.ts$|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/services/session-store\\.service\\.ts$' },
    },
    {
      name: 'session-runtime-import-boundary',
      severity: 'error',
      comment:
        'Session runtime managers are internal lifecycle infrastructure and may only be imported by session acp/lifecycle entry points.',
      from: {
        path: '^src/backend/domains/session/',
        pathNot:
          '^src/backend/domains/session/(acp/|runtime/|lifecycle/)|^src/backend/domains/session/index\\.ts$|^src/backend/domains/session/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/domains/session/runtime/' },
    },
    {
      name: 'acp-no-external-imports',
      severity: 'error',
      comment:
        'ACP internals must stay isolated from app code; only ACP internals and the logger service are allowed.',
      from: {
        path: '^src/backend/domains/session/acp/',
        pathNot: '^src/backend/domains/session/acp/.*\\.test\\.ts$',
      },
      to: {
        path: '^src/',
        pathNot:
          '^src/backend/domains/session/acp/|^src/backend/domains/session/acp$|^src/backend/services/logger.service.ts$',
      },
    },
    {
      name: 'no-cross-domain-imports',
      severity: 'error',
      comment:
        'Domain modules must not import from sibling domains directly. ' +
        'Cross-domain coordination goes through the orchestration layer (Phase 8).',
      from: { path: '^src/backend/domains/([^/]+)/' },
      to: {
        path: '^src/backend/domains/([^/]+)/',
        pathNot: '^src/backend/domains/$1/',
      },
    },
    {
      name: 'no-deep-domain-imports',
      severity: 'error',
      comment:
        'External consumers must import from domain barrel files (domains/{name}/), ' +
        'not from internal paths (domains/{name}/subfolder/). ' +
        'This keeps domain internals encapsulated. ' +
        'Exception: conversation-rename interceptor uses deep imports to avoid circular dependency.',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/domains/([^/]+)/|' +
          '^src/backend/interceptors/conversation-rename\\.interceptor\\.ts$',
      },
      to: {
        path: '^src/backend/domains/[^/]+/.+/',
      },
    },
    {
      name: 'no-orchestration-importing-domain-internals',
      severity: 'error',
      comment:
        'Orchestration must import domains through barrels only (domains/{name}/index.ts), ' +
        'not through domain internals.',
      from: { path: '^src/backend/orchestration/' },
      to: {
        path: '^src/backend/domains/[^/]+/(?!index\\.ts$).+',
      },
    },
    {
      name: 'no-non-barrel-domain-root-imports',
      severity: 'error',
      comment:
        'External consumers must use domain barrels. Imports like domains/{name}/foo.ts are internal-only.',
      from: {
        path: '^(src|electron)/',
        pathNot: '^src/backend/domains/([^/]+)/',
      },
      to: {
        path: '^src/backend/domains/[^/]+/(?!index\\.ts$)[^/]+\\.ts$',
      },
    },
    {
      name: 'no-domains-importing-orchestration',
      severity: 'error',
      comment:
        'Domain modules must not import from orchestration layer. ' +
        'Orchestration coordinates domains, not the other way around.',
      from: {
        path: '^src/backend/domains/',
        pathNot:
          '\\.test\\.ts$|' +
          // reconciliation needs to re-trigger workspace init for stuck provisioning
          '^src/backend/domains/ratchet/reconciliation\\.service\\.ts$',
      },
      to: { path: '^src/backend/orchestration/' },
    },
    {
      name: 'no-domains-importing-routers',
      severity: 'error',
      comment:
        'Domain modules must not import from routers or tRPC layer. ' +
        'Routers depend on domains, not the other way around.',
      from: { path: '^src/backend/domains/' },
      to: { path: '^src/backend/(routers|trpc)/' },
    },
    {
      name: 'no-domains-importing-agents',
      severity: 'error',
      comment:
        'Domain modules must not import from agents. ' +
        'Agents depend on domains, not the other way around.',
      from: { path: '^src/backend/domains/' },
      to: { path: '^src/backend/agents/' },
    },
    {
      name: 'only-accessors-import-db',
      severity: 'error',
      comment: 'Database client should be imported only by resource accessors',
      from: {
        path: '^src/backend',
        pathNot: '^src/backend/(db\\.ts|server\\.ts|resource_accessors/)|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/db\\.ts$' },
    },
    {
      name: 'no-routers-importing-accessors',
      severity: 'error',
      comment: 'Routers should use services, not access data directly via resource accessors',
      from: { path: '^src/backend/routers' },
      to: { path: '^src/backend/resource_accessors' },
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules'],
    },
    exclude: {
      path: ['prisma/generated'],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
      text: {
        highlightFocused: true,
      },
    },
  },
};
