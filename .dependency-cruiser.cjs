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
      name: "only-session-domain-imports-session-store",
      severity: "error",
      comment:
        "Session transcript/store internals are single-writer infrastructure and may only be imported by the session domain layer",
      from: {
        path: "^src/backend",
        pathNot:
          "^src/backend/domains/session/|^src/backend/services/session-store\\.service\\.ts$|^src/backend/.*\\.test\\.ts$",
      },
      to: { path: "^src/backend/services/session-store\\.service\\.ts$" },
    },
    {
      name: "no-cross-domain-imports",
      severity: "error",
      comment:
        "Domain modules must not import from sibling domains directly. " +
        "Cross-domain coordination goes through the orchestration layer (Phase 8).",
      from: { path: "^src/backend/domains/([^/]+)/" },
      to: {
        path: "^src/backend/domains/([^/]+)/",
        pathNot: "^src/backend/domains/$1/",
      },
    },
    {
      name: "no-deep-domain-imports",
      severity: "error",
      comment:
        "External consumers must import from domain barrel files (domains/{name}/), " +
        "not from internal paths (domains/{name}/subfolder/). " +
        "This keeps domain internals encapsulated. " +
        "Exceptions: orchestrators/interceptors with documented circular-dep avoidance.",
      from: {
        path: "^src/backend",
        pathNot:
          "^src/backend/domains/([^/]+)/|" +
          // These files use direct module paths to avoid circular dependencies:
          // - conversation-rename imports session/claude and session/lifecycle to avoid
          //   session barrel -> chat-event-forwarder -> interceptors -> session barrel cycle
          // - workspace-init imports workspace/lifecycle and workspace/worktree to avoid
          //   workspace barrel -> creation.service -> workspace-init -> workspace barrel cycle
          "^src/backend/interceptors/conversation-rename\\.interceptor\\.ts$|" +
          "^src/backend/orchestration/workspace-init\\.orchestrator\\.ts$",
      },
      to: {
        path: "^src/backend/domains/[^/]+/.+/",
      },
    },
    {
      name: "no-domains-importing-orchestration",
      severity: "error",
      comment:
        "Domain modules must not import from orchestration layer. " +
        "Orchestration coordinates domains, not the other way around.",
      from: {
        path: "^src/backend/domains/",
        pathNot:
          "\\.test\\.ts$|" +
          // creation.service uses dynamic import() to trigger workspace init after creation
          "^src/backend/domains/workspace/lifecycle/creation\\.service\\.ts$|" +
          // reconciliation needs to re-trigger workspace init for stuck provisioning
          "^src/backend/domains/ratchet/reconciliation\\.service\\.ts$",
      },
      to: { path: "^src/backend/orchestration/" },
    },
    {
      name: "no-domains-importing-routers",
      severity: "error",
      comment:
        "Domain modules must not import from routers or tRPC layer. " +
        "Routers depend on domains, not the other way around.",
      from: { path: "^src/backend/domains/" },
      to: { path: "^src/backend/(routers|trpc)/" },
    },
    {
      name: "no-domains-importing-agents",
      severity: "error",
      comment:
        "Domain modules must not import from agents. " +
        "Agents depend on domains, not the other way around.",
      from: { path: "^src/backend/domains/" },
      to: { path: "^src/backend/agents/" },
    },
    {
      name: "only-accessors-import-db",
      severity: "error",
      comment:
        "Database client should be imported only by resource accessors",
      from: {
        path: "^src/backend",
        pathNot: "^src/backend/(db\\.ts|server\\.ts|resource_accessors/)|^src/backend/.*\\.test\\.ts$",
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
