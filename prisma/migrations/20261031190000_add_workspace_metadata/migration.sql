CREATE TABLE "WorkspaceMetadata" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "title" TEXT,
    "branch" TEXT,
    "summary" TEXT,
    "sidebarSummary" TEXT,
    "generatedAt" DATETIME,
    "sourceSessionId" TEXT,
    "sourceMessageId" TEXT,
    CONSTRAINT "WorkspaceMetadata_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
