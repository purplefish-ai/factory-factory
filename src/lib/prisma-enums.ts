// Re-export Prisma enums for browser-safe usage
// Import from here in 'use client' components instead of @prisma/client
export { EpicState, TaskState, AgentType, AgentState } from '../generated/prisma/enums';
