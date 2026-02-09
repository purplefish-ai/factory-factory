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
      comment: "Frontend (src/app) should not import backend directly - use API calls instead",
      from: { path: "^src/app" },
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
