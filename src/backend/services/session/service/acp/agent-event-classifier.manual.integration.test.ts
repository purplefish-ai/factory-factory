import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
} from '@/backend/testing/integration-db';
import {
  type ClassifierGateOutcome,
  fixturePayload,
  loadClassifierFixtures,
  scoreClassifierGate,
} from '@/test-utils/agent-event-classifier-gate';

/**
 * Live replay gate for natural-language event filters. It calls the real
 * provider through the production classifier, so it never runs in CI:
 *
 * RUN_AGENT_EVENT_CLASSIFIER_EVAL=1 AGENT_EVENT_CLASSIFIER_EVAL_PROVIDER=CLAUDE \
 *   pnpm test:integration src/backend/services/session/service/acp/agent-event-classifier.manual.integration.test.ts
 */
const enabled = process.env.RUN_AGENT_EVENT_CLASSIFIER_EVAL === '1';
const provider = process.env.AGENT_EVENT_CLASSIFIER_EVAL_PROVIDER === 'CODEX' ? 'CODEX' : 'CLAUDE';
const split = process.env.AGENT_EVENT_CLASSIFIER_EVAL_SPLIT === 'tuning' ? 'tuning' : 'heldOut';

describe.skipIf(!enabled)('live event classifier replay gate', () => {
  it(`${provider} ${split} fixtures`, async () => {
    const db = await createIntegrationDatabase();
    try {
      const { classifyAgentEvent } = await vi.importActual<
        typeof import('../agent-event-classifier')
      >('../agent-event-classifier');
      const fixtures = loadClassifierFixtures();
      const cases = fixtures.cases.filter((item) => item.split === split);
      const results = await Promise.all(
        cases.map(async (item) => {
          const started = performance.now();
          try {
            const result = await classifyAgentEvent(
              {
                provider,
                accountId: null,
                filterInstructions: fixtures.filters[item.filter] ?? '',
                eventContext: fixturePayload(item),
              },
              AbortSignal.timeout(300_000)
            );
            return {
              outcome: {
                id: item.id,
                decision: result.decision,
                latencyMs: Math.round(performance.now() - started),
              } satisfies ClassifierGateOutcome,
              reason: result.reason,
              classifier: result.classifier,
            };
          } catch (error) {
            return {
              outcome: {
                id: item.id,
                decision: 'error',
                latencyMs: Math.round(performance.now() - started),
              } satisfies ClassifierGateOutcome,
              reason: error instanceof Error ? error.message : 'unknown error',
              classifier: null,
            };
          }
        })
      );
      const score = scoreClassifierGate(
        cases,
        results.map((result) => result.outcome)
      );
      const identity = results.find((result) => result.classifier)?.classifier;
      const report = {
        provider,
        model: identity?.model ?? null,
        promptVersion: identity?.promptVersion ?? null,
        split,
        measuredAt: new Date().toISOString(),
        ...score,
        outcomes: results.map((result, index) => ({
          ...result.outcome,
          kind: cases[index]?.kind,
          obvious: cases[index]?.obvious,
          reason: result.reason,
        })),
      };
      const output = process.env.AGENT_EVENT_CLASSIFIER_EVAL_OUTPUT;
      if (output) {
        await writeFile(
          join(output, `${provider.toLowerCase()}-${split}.json`),
          `${JSON.stringify(report, null, 2)}\n`
        );
      }
      expect(score.failures).toEqual([]);
    } finally {
      await destroyIntegrationDatabase(db);
    }
  }, 900_000);
});
