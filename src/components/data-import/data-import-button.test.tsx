/**
 * Tests for the DataImportButton component.
 *
 * Verifies schema-based validation of import files.
 */
import { describe, expect, it } from 'vitest';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';

describe('DataImportButton - File Validation', () => {
  it('should accept valid v3 backup file', () => {
    const validV3Data = {
      meta: {
        exportedAt: '2024-01-01T00:00:00.000Z',
        version: '0.1.0',
        schemaVersion: 3,
      },
      data: {
        projects: [],
        workspaces: [],
        agentSessions: [],
        terminalSessions: [],
        userSettings: null,
      },
    };

    const result = exportDataSchema.safeParse(validV3Data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta.schemaVersion).toBe(3);
    }
  });

  it('should reject legacy v2 backup files', () => {
    const validV2Data = {
      meta: {
        exportedAt: '2024-01-01T00:00:00.000Z',
        version: '0.1.0',
        schemaVersion: 2,
      },
      data: {
        projects: [],
        workspaces: [],
        agentSessions: [],
        terminalSessions: [],
        userSettings: null,
      },
    };

    const result = exportDataSchema.safeParse(validV2Data);
    expect(result.success).toBe(false);
  });

  it('should reject file with missing meta fields', () => {
    const invalidData = {
      meta: {
        exportedAt: '2024-01-01T00:00:00.000Z',
        // missing version
        schemaVersion: 3,
      },
      data: {
        projects: [],
        workspaces: [],
        agentSessions: [],
        terminalSessions: [],
        userSettings: null,
      },
    };

    const result = exportDataSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject file with missing data fields', () => {
    const invalidData = {
      meta: {
        exportedAt: '2024-01-01T00:00:00.000Z',
        version: '0.1.0',
        schemaVersion: 3,
      },
      data: {
        projects: [],
        workspaces: [],
        // missing agentSessions
        terminalSessions: [],
        userSettings: null,
      },
    };

    const result = exportDataSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject file with invalid schemaVersion', () => {
    const invalidData = {
      meta: {
        exportedAt: '2024-01-01T00:00:00.000Z',
        version: '0.1.0',
        schemaVersion: 99,
      },
      data: {
        projects: [],
        workspaces: [],
        agentSessions: [],
        terminalSessions: [],
        userSettings: null,
      },
    };

    const result = exportDataSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject file with wrong data types', () => {
    const invalidData = {
      meta: {
        exportedAt: '2024-01-01T00:00:00.000Z',
        version: '0.1.0',
        schemaVersion: 3,
      },
      data: {
        projects: 'not an array',
        workspaces: [],
        agentSessions: [],
        terminalSessions: [],
        userSettings: null,
      },
    };

    const result = exportDataSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should provide detailed error messages for invalid files', () => {
    const invalidData = {
      meta: {
        exportedAt: '2024-01-01T00:00:00.000Z',
      },
      data: {
        projects: [],
      },
    };

    const result = exportDataSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBeTruthy();
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});
