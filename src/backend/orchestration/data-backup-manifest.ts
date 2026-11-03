import { type PrismaModelName, prismaModelNames } from '@/backend/services/registry';
import {
  type RecoveryMetadata,
  r4aModelCoverage,
  recoveryMetadataSchema,
} from '@/shared/schemas/recovery-envelope.schema';

const coverage: Record<
  PrismaModelName,
  Omit<RecoveryMetadata['coverage'][number], 'model'>
> = r4aModelCoverage;

export function assertRecoveryModelCoverage(modelNames: readonly string[]): void {
  const names = new Set(modelNames);
  if (
    names.size !== Object.keys(coverage).length ||
    Object.keys(coverage).some((name) => !names.has(name))
  ) {
    throw new Error('Recovery model coverage does not match the current registry');
  }
}
export function createBaseRecoveryManifest(): RecoveryMetadata {
  assertRecoveryModelCoverage(prismaModelNames);
  return recoveryMetadataSchema.parse({
    version: 1,
    profile: 'base-1',
    status: 'PARTIAL',
    capabilities: {},
    coverage: Object.entries(coverage).map(([model, entry]) => ({ model, ...entry })),
    exclusions: recoveryMetadataSchema.shape.exclusions.element.options,
  });
}
