import { type PrismaModelName, prismaModelNames } from '@/backend/services/registry';
import {
  type RecoveryMetadata,
  workspaceJsonModelCoverage,
  recoveryMetadataSchema,
} from '@/shared/schemas/recovery-envelope.schema';

const coverage: Record<
  PrismaModelName,
  Omit<RecoveryMetadata['coverage'][number], 'model'>
> = workspaceJsonModelCoverage;

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
    profile: 'base-json-workspace-1',
    status: 'PARTIAL',
    capabilities: { baseJson: 1 },
    coverage: Object.entries(coverage).map(([model, entry]) => ({ model, ...entry })),
    exclusions: recoveryMetadataSchema.shape.exclusions.element.options,
  });
}
