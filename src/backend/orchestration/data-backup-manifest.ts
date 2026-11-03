import { z } from 'zod';
import { type PrismaModelName, prismaModelNames } from '@/backend/services/registry';
import {
  type RecoveryMetadata,
  periodicHistoryModelCoverage,
  recoveryMetadataSchema,
} from '@/shared/schemas/recovery-envelope.schema';

const coverage: Record<
  PrismaModelName,
  Omit<RecoveryMetadata['coverage'][number], 'model'>
> = periodicHistoryModelCoverage;

export function assertRecoveryModelCoverage(modelNames: readonly string[]): void {
  const names = new Set(modelNames);
  if (
    names.size !== Object.keys(coverage).length ||
    Object.keys(coverage).some((name) => !names.has(name))
  ) {
    throw new Error('Recovery model coverage does not match the current registry');
  }
}
export function createBaseRecoveryManifest(): RecoveryMetadata & {
  profile: 'base-json-periodic-history-1';
} {
  assertRecoveryModelCoverage(prismaModelNames);
  return recoveryMetadataSchema
    .safeExtend({ profile: z.literal('base-json-periodic-history-1') })
    .parse({
      version: 1,
      profile: 'base-json-periodic-history-1',
      status: 'PARTIAL',
      capabilities: { baseJson: 1, periodicConfig: 1, periodicHistory: 1 },
      coverage: Object.entries(coverage).map(([model, entry]) => ({ model, ...entry })),
      exclusions: recoveryMetadataSchema.shape.exclusions.element.options.filter(
        (exclusion) => exclusion !== 'PHYSICAL_NULLABLE_JSON_FIDELITY'
      ),
    });
}
