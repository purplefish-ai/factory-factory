import { expect, it } from 'vitest';
import { prismaModelNames } from '@/backend/services/registry';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import fixed from '@/shared/testing/recovery-slack-connections-v8.fixture.json';
import { assertRecoveryModelCoverage, createBaseRecoveryManifest } from './data-backup-manifest';

it('declares question response recovery in the current manifest', () => {
  const manifest = createBaseRecoveryManifest();
  expect(manifest).toEqual({
    ...fixed.meta.recovery,
    profile: 'base-json-question-responses-1',
    capabilities: { ...fixed.meta.recovery.capabilities, questionResponses: 1 },
    coverage: [
      ...fixed.meta.recovery.coverage,
      {
        model: 'SessionQuestionResponse',
        status: 'PARTIAL',
        limitation:
          'local answer summaries retain session, provider session and tool identities; restored for newly imported sessions; raw tool content and secret answer values excluded.',
      },
    ],
  });
  expect(manifest.coverage.map((entry) => entry.model).sort()).toEqual(
    [...prismaModelNames].sort()
  );
  expect(() => assertRecoveryModelCoverage(prismaModelNames)).not.toThrow();
  expect(createBaseRecoveryManifest()).not.toBe(manifest);
});
it('accepts the frozen Slack profile manifest without a question response classification', () => {
  expect(exportDataSchema.parse(fixed).meta).toEqual(fixed.meta);
  expect(fixed.meta.recovery.coverage.map(({ model }) => model)).not.toContain(
    'SessionQuestionResponse'
  );
});
it('rejects the question response section in the frozen Slack profile', () => {
  const mismatched = {
    ...fixed,
    data: {
      ...fixed.data,
      recovery: { ...fixed.data.recovery, questionResponses: { version: 1, responses: [] } },
    },
  };
  expect(exportDataSchema.safeParse(mismatched).success).toBe(false);
});
it('fails closed when the live registry gains or loses a model', () => {
  expect(() => assertRecoveryModelCoverage([...prismaModelNames, 'FutureModel'])).toThrow();
  expect(() => assertRecoveryModelCoverage(prismaModelNames.slice(1))).toThrow();
});
