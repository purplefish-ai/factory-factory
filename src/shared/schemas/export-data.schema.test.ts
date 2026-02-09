/**
 * Tests for export-data schema enum synchronization with Prisma.
 *
 * These tests ensure that the Zod enum values stay in sync with Prisma-generated enums.
 * If Prisma schema enums are modified, these tests will fail, prompting updates to the
 * shared schema to prevent backup import failures.
 */
import {
  CIStatus as PrismaCIStatus,
  KanbanColumn as PrismaKanbanColumn,
  PRState as PrismaPRState,
  RatchetState as PrismaRatchetState,
  RunScriptStatus as PrismaRunScriptStatus,
  SessionStatus as PrismaSessionStatus,
  WorkspaceCreationSource as PrismaWorkspaceCreationSource,
  WorkspaceStatus as PrismaWorkspaceStatus,
} from '@prisma-gen/client';
import { describe, expect, it } from 'vitest';
import { exportedClaudeSessionSchema, exportedWorkspaceSchemaV2 } from './export-data.schema';

type DefWithType = {
  def?: {
    type?: string;
    innerType?: unknown;
    options?: unknown[];
    entries?: Record<string, string>;
  };
};

describe('Enum sync with Prisma schema', () => {
  // Helper to extract Zod enum options from a Zod enum schema
  const getEnumOptions = (zodEnum: unknown): string[] => {
    let enumSchema = zodEnum as DefWithType;

    // Unwrap optional/nullable wrappers (they use .def.type and .def.innerType)
    while (enumSchema.def?.type === 'optional' || enumSchema.def?.type === 'nullable') {
      enumSchema = enumSchema.def.innerType as DefWithType;
    }

    // Handle union types (like runScriptStatus which is z.union([RunScriptStatus, z.literal('PAUSED')]))
    if (enumSchema.def?.type === 'union') {
      const firstOption = enumSchema.def.options?.[0];
      if (!firstOption) {
        throw new Error('Expected union schema to contain at least one option');
      }
      enumSchema = firstOption as DefWithType;
    }

    // Extract enum values from the def property
    const entries = enumSchema.def?.entries;
    if (!entries) {
      throw new Error('Expected enum schema entries to be present');
    }
    return Object.keys(entries);
  };

  it('WorkspaceStatus matches Prisma', () => {
    const zodValues = getEnumOptions(exportedWorkspaceSchemaV2.shape.status);
    const prismaValues = Object.values(PrismaWorkspaceStatus);
    expect(zodValues).toEqual(prismaValues);
  });

  it('WorkspaceCreationSource matches Prisma', () => {
    const zodValues = getEnumOptions(exportedWorkspaceSchemaV2.shape.creationSource);
    const prismaValues = Object.values(PrismaWorkspaceCreationSource);
    expect(zodValues).toEqual(prismaValues);
  });

  it('RunScriptStatus matches Prisma', () => {
    // Note: The schema uses a union with 'PAUSED' for backward compatibility
    // We check the first option which should be the RunScriptStatus enum
    const zodValues = getEnumOptions(exportedWorkspaceSchemaV2.shape.runScriptStatus);
    const prismaValues = Object.values(PrismaRunScriptStatus);
    expect(zodValues).toEqual(prismaValues);
  });

  it('PRState matches Prisma', () => {
    const zodValues = getEnumOptions(exportedWorkspaceSchemaV2.shape.prState);
    const prismaValues = Object.values(PrismaPRState);
    expect(zodValues).toEqual(prismaValues);
  });

  it('CIStatus matches Prisma', () => {
    const zodValues = getEnumOptions(exportedWorkspaceSchemaV2.shape.prCiStatus);
    const prismaValues = Object.values(PrismaCIStatus);
    expect(zodValues).toEqual(prismaValues);
  });

  it('KanbanColumn matches Prisma', () => {
    const zodValues = getEnumOptions(exportedWorkspaceSchemaV2.shape.cachedKanbanColumn);
    const prismaValues = Object.values(PrismaKanbanColumn);
    expect(zodValues).toEqual(prismaValues);
  });

  it('RatchetState matches Prisma', () => {
    const zodValues = getEnumOptions(exportedWorkspaceSchemaV2.shape.ratchetState);
    const prismaValues = Object.values(PrismaRatchetState);
    expect(zodValues).toEqual(prismaValues);
  });

  it('SessionStatus matches Prisma', () => {
    const zodValues = getEnumOptions(exportedClaudeSessionSchema.shape.status);
    const prismaValues = Object.values(PrismaSessionStatus);
    expect(zodValues).toEqual(prismaValues);
  });
});
