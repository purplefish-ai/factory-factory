CREATE TABLE "SessionQuestionResponse" (
    "sessionId" TEXT NOT NULL,
    "providerSessionId" TEXT NOT NULL,
    "toolUseId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "summary" JSONB NOT NULL,

    PRIMARY KEY ("sessionId", "providerSessionId", "toolUseId"),
    CONSTRAINT "SessionQuestionResponse_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
