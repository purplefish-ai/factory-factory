import { expect, it } from 'vitest';
import { prismaModelNames } from '@/backend/services/registry';
import { recoveryManifest } from './data-backup-manifest';

it('requires an explicit recovery classification and reason for every registered model', () => {
  const manifest = recoveryManifest();
  expect(Object.keys(manifest.models).sort()).toEqual([...prismaModelNames].sort());
  for (const coverage of Object.values(manifest.models)) {
    expect(coverage.reason.length).toBeGreaterThan(20);
  }
  expect(manifest.kind).toBe('logical');
  expect(manifest.limitations.join(' ')).toContain('encryption.key');
});

it('isolates manifest policy from callers editing an exported snapshot', () => {
  const edited = recoveryManifest();
  Reflect.deleteProperty(edited.models, 'AgentRun');
  expect(Object.keys(recoveryManifest().models).sort()).toEqual([...prismaModelNames].sort());
});
