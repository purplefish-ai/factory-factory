/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies cause subtle runtime issues and make the codebase harder to reason about',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-frontend-importing-backend',
      severity: 'error',
      comment:
        'Frontend UI layers should not import backend directly - use API contracts/shared schemas instead',
      from: {
        path: '^src/(client|components|frontend)',
        pathNot: '^src/client/lib/trpc\\.ts$',
      },
      to: { path: '^src/backend' },
    },
    {
      name: 'frontend-trpc-only-imports-backend-trpc',
      severity: 'error',
      comment: 'src/client/lib/trpc.ts may only import backend tRPC types, not other backend modules',
      from: { path: '^src/client/lib/trpc\\.ts$' },
      to: {
        path: '^src/backend/',
        pathNot: '^src/backend/trpc/',
      },
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
      comment: 'Import from concrete service modules, not services/index.',
      from: { path: '^src/' },
      to: { path: '^src/backend/services/index\\.ts$' },
    },
    {
      name: 'no-importing-backend-orchestration-barrel',
      severity: 'error',
      comment: 'Import concrete orchestration modules directly, not orchestration/index.',
      from: { path: '^src/' },
      to: { path: '^src/backend/orchestration/index\\.ts$' },
    },
    {
      name: 'no-lib-importing-app-layers',
      severity: 'error',
      comment:
        'Backend lib helpers should remain low-level and must not depend on orchestration, routers, agents, or service internals',
      from: { path: '^src/backend/lib' },
      to: {
        path: '^src/backend/(orchestration|routers|trpc|agents|services/[^/]+/(service|resources))/',
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
      name: 'only-service-resources-import-db',
      severity: 'error',
      comment: 'Database client should be imported only by service resources',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/(db\\.ts|server\\.ts|services/[^/]+/resources/)|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/db\\.ts$' },
    },
    {
      name: 'no-trpc-importing-service-internals',
      severity: 'error',
      comment: 'tRPC routers must import service barrels, not service internals.',
      from: { path: '^src/backend/trpc/' },
      to: { path: '^src/backend/services/[^/]+/(?!index\\.ts$).+' },
    },
    {
      name: 'no-orchestration-importing-service-internals',
      severity: 'error',
      comment: 'Orchestration must import service barrels only.',
      from: { path: '^src/backend/orchestration/' },
      to: { path: '^src/backend/services/[^/]+/(?!index\\.ts$).+' },
    },
    {
      name: 'only-service-layers-import-service-resources',
      severity: 'error',
      comment: 'Service resources are data-layer internals.',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/services/[^/]+/(index\\.ts|service/|resources/)|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/services/[^/]+/resources/' },
    },
    {
      name: 'no-cross-service-resource-imports',
      severity: 'error',
      comment: 'Service business logic must not import another service\'s resources.',
      from: { path: '^src/backend/services/([^/]+)/service/' },
      to: {
        path: '^src/backend/services/([^/]+)/resources/',
        pathNot: '^src/backend/services/$1/resources/',
      },
    },
    {
      name: 'no-service-resources-importing-app-layers',
      severity: 'error',
      comment: 'Resources must remain pure data access and not depend on service/trpc/router/orchestration layers.',
      from: { path: '^src/backend/services/[^/]+/resources/' },
      to: { path: '^src/backend/(services/[^/]+/service|orchestration|routers|trpc|agents)/' },
    },
    {
      name: 'no-cross-service-internal-imports',
      severity: 'error',
      comment: 'Cross-service imports must go through service barrels only.',
      from: { path: '^src/backend/services/([^/]+)/' },
      to: {
        path: '^src/backend/services/([^/]+)/(?!index\\.ts$).+',
        pathNot: '^src/backend/services/$1/',
      },
    },
    {
      name: 'no-deep-service-imports',
      severity: 'error',
      comment: 'External consumers must import from service barrels only.',
      from: {
        path: '^src/backend',
        pathNot: '^src/backend/services/([^/]+)/|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/services/[^/]+/(?!index\\.ts$).+' },
    },
    {
      name: 'no-services-importing-transport-layers',
      severity: 'error',
      comment: 'Services should not depend on routers or tRPC transport layers.',
      from: { path: '^src/backend/services/' },
      to: { path: '^src/backend/(routers|trpc)/' },
    },
    {
      name: 'no-services-importing-agents',
      severity: 'error',
      comment: 'Services should not depend on agent orchestration internals.',
      from: { path: '^src/backend/services/' },
      to: { path: '^src/backend/agents/' },
    },
    {
      name: 'no-services-importing-orchestration',
      severity: 'error',
      comment: 'Services should not depend on orchestration coordinators.',
      from: {
        path: '^src/backend/services/',
        pathNot: '^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/orchestration/' },
    },
    {
      name: 'session-model-import-boundary',
      severity: 'error',
      comment:
        'Session-model normalization is provider/session-specific and should only be consumed by session internals/resources and user settings persistence.',
      from: {
        path: '^src/backend',
        pathNot:
          '^src/backend/services/session/(service/|resources/)|^src/backend/services/settings/resources/user-settings\\.accessor\\.ts$|^src/backend/lib/session-model\\.ts$|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/lib/session-model\\.ts$' },
    },
    {
      name: 'session-runtime-import-boundary',
      severity: 'error',
      comment:
        'Session runtime managers are internal lifecycle infrastructure and may only be imported by session acp/lifecycle entry points.',
      from: {
        path: '^src/backend/services/session/service/',
        pathNot:
          '^src/backend/services/session/service/(acp/|runtime/|lifecycle/)|^src/backend/services/session/(index\\.ts|service/index\\.ts)$|^src/backend/.*\\.test\\.ts$',
      },
      to: { path: '^src/backend/services/session/service/runtime/' },
    },
    {
      name: 'acp-no-external-imports',
      severity: 'error',
      comment:
        'ACP internals must stay isolated from app code; only ACP internals and the logger service are allowed.',
      from: {
        path: '^src/backend/services/session/service/acp/',
        pathNot: '^src/backend/services/session/service/acp/.*\\.test\\.ts$',
      },
      to: {
        path: '^src/',
        pathNot:
          '^src/backend/services/session/service/acp/|^src/backend/services/session/service/acp$|^src/backend/services/logger.service.ts$',
      },
    },
    {
      name: 'codex-app-server-adapter-self-contained',
      severity: 'error',
      comment:
        'Codex app-server ACP adapter must be self-contained and must not import from outside its own directory.',
      from: {
        path: '^src/backend/services/session/service/acp/codex-app-server-adapter/',
        pathNot:
          '^src/backend/services/session/service/acp/codex-app-server-adapter/.*\\.test\\.ts$',
      },
      to: {
        path: '^src/',
        pathNot: '^src/backend/services/session/service/acp/codex-app-server-adapter/',
      },
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
      comment: 'Backend layers should not depend on UI modules',
      from: { path: '^src/backend' },
      to: { path: '^src/(client|frontend|components)' },
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
