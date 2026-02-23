/**
 * Zod schemas for validating persisted JSON stores (local files/localStorage).
 *
 * These schemas protect against malformed or corrupted data from:
 * - Advisory lock persistence format
 * - Resume workspace ID list (string[])
 */

import { z } from 'zod';

/**
 * Schema for a single persisted lock entry
 */
const persistedLockSchema = z.object({
  filePath: z.string(),
  ownerId: z.string(),
  ownerLabel: z.string().optional(),
  acquiredAt: z.string(),
  expiresAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for the full persisted lock store (.ff-locks.json)
 */
export const persistedLockStoreSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  locks: z.array(persistedLockSchema),
});

export type PersistedLockStore = z.infer<typeof persistedLockStoreSchema>;

/**
 * Schema for resume workspace IDs array (localStorage)
 */
export const resumeWorkspaceIdsSchema = z.array(z.string());

export type ResumeWorkspaceIds = z.infer<typeof resumeWorkspaceIdsSchema>;

/**
 * Schema for per-project workspace ordering cache in user settings.
 * Maps project IDs to ordered workspace ID arrays.
 */
export const workspaceOrderMapSchema = z.record(z.string(), z.array(z.string()));

export type WorkspaceOrderMap = z.infer<typeof workspaceOrderMapSchema>;
