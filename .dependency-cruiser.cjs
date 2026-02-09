/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies cause subtle runtime issues and make the codebase harder to reason about",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "no-accessors-importing-services",
      severity: "error",
      comment: "Resource accessors should be pure data access, not import business logic from services",
      from: { path: "^src/backend/resource_accessors" },
      to: { path: "^src/backend/services" },
    },
    {
      name: "no-accessors-importing-agents",
      severity: "error",
      comment: "Resource accessors should be pure data access, not import agent logic",
      from: { path: "^src/backend/resource_accessors" },
      to: { path: "^src/backend/agents" },
    },
    {
      name: "no-services-importing-agents",
      severity: "error",
      comment: "Services should not depend on agents - agents should depend on services",
      from: { path: "^src/backend/services" },
      to: { path: "^src/backend/agents" },
    },
    {
      name: "no-services-importing-routers",
      severity: "error",
      comment: "Services should not depend on routers - routers should depend on services",
      from: { path: "^src/backend/services" },
      to: { path: "^src/backend/routers" },
    },
    {
      name: "no-mcp-routers-importing-agents",
      severity: "error",
      // task.mcp.ts is exempted because it's the MCP endpoint for managing agent
      // lifecycle itself (startWorker, killWorkerAndCleanup). Unlike other MCP tools
      // that provide capabilities TO agents, task.mcp.ts provides control OVER agents.
      // This is fundamentally different - it's agent management, not agent capability.
      comment: "MCP routers should not import agent logic directly (except task.mcp.ts for worker lifecycle)",
      from: {
        path: "^src/backend/routers/mcp",
        pathNot: "^src/backend/routers/mcp/task\\.mcp\\.ts$",
      },
      to: { path: "^src/backend/agents" },
    },
    {
      name: "no-frontend-importing-backend",
      severity: "error",
      comment:
        "Frontend UI layers should not import backend directly - use API contracts/shared schemas instead",
      from: {
        path: "^src/(client|components|frontend)",
        pathNot: "^src/frontend/lib/trpc\\.ts$",
      },
      to: { path: "^src/backend" },
    },
    {
      name: "no-trpc-importing-accessors",
      severity: "error",
      comment: "tRPC routers should use services, not access data directly via resource accessors",
      from: { path: "^src/backend/trpc" },
      to: { path: "^src/backend/resource_accessors" },
    },
    {
      name: "no-shared-importing-app-layers",
      severity: "error",
      comment:
        "Shared contracts must stay framework/domain neutral and not depend on backend or UI layers",
      from: { path: "^src/shared" },
      to: { path: "^src/(backend|client|frontend|components)" },
    },
    {
      name: "no-backend-importing-ui-layers",
      severity: "error",
      comment: "Backend domain/application layers should not depend on UI modules",
      from: { path: "^src/backend" },
      to: { path: "^src/(client|frontend|components)" },
    },
    {
      name: "only-accessors-import-db",
      severity: "error",
      comment:
        "Database client should be imported only by resource accessors (plus temporary allowlist while migrating legacy services)",
      from: {
        path: "^src/backend",
        pathNot:
          "^src/backend/(db\\.ts|server\\.ts|resource_accessors/)|^src/backend/routers/api/health\\.router\\.ts$|^src/backend/services/(workspace-state-machine|run-script-state-machine|fixer-session|data-backup)\\.service\\.ts$|^src/backend/services/.*\\.test\\.ts$",
      },
      to: { path: "^src/backend/db\\.ts$" },
    },
    {
      name: "no-routers-importing-accessors",
      severity: "error",
      comment: "Routers should use services, not access data directly via resource accessors",
      from: { path: "^src/backend/routers" },
      to: { path: "^src/backend/resource_accessors" },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules"],
    },
    exclude: {
      path: ["prisma/generated"],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
      text: {
        highlightFocused: true,
      },
    },
  },
};
