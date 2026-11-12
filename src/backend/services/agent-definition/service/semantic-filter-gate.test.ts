import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_CLASSIFICATION_PROMPT_VERSION } from '@/backend/prompts/agent-event-classification';
import { configService } from '@/backend/services/config.service';
import {
  type ClassifierGateOutcome,
  fixturePayload,
  gateFailures,
  loadClassifierFixtures,
  loadClassifierGateRecord,
  scoreClassifierGate,
} from '@/test-utils/agent-event-classifier-gate';
import {
  isClassifierProven,
  PROVEN_CLASSIFIER_PROVIDERS,
  semanticFilterSupported,
} from './semantic-filter-gate';

const fixtures = loadClassifierFixtures();
const heldOut = fixtures.cases.filter((item) => item.split === 'heldOut');
function constant(decision: ClassifierGateOutcome['decision']) {
  return heldOut.map((item) => ({ id: item.id, decision, latencyMs: 1 }));
}

describe('classifier replay fixtures', () => {
  it('cover GitHub and Slack in both splits with enough adversarial negatives', () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(40);
    expect(
      fixtures.cases.filter((item) => item.kind === 'adversarial').length
    ).toBeGreaterThanOrEqual(10);
    expect(heldOut.filter((item) => item.kind === 'adversarial').length).toBeGreaterThanOrEqual(10);
    for (const split of ['tuning', 'heldOut'] as const) {
      for (const source of ['GITHUB', 'SLACK'] as const) {
        const subset = fixtures.cases.filter(
          (item) => item.split === split && item.source === source
        );
        expect(subset.some((item) => item.kind === 'positive')).toBe(true);
        expect(subset.some((item) => item.kind !== 'positive')).toBe(true);
      }
    }
    expect(heldOut.some((item) => item.obvious)).toBe(true);
  });

  it('expand to valid stored payloads with synthetic identities only', () => {
    for (const item of fixtures.cases) {
      const payload = fixturePayload(item);
      expect(payload.provider).toBe(item.source);
      expect(payload.sourceUrl).toMatch(/example/);
    }
  });
});

describe('classifier gate scoring', () => {
  it.each(['skip', 'uncertain', 'error'] as const)('fails an always-%s classifier', (decision) => {
    const result = scoreClassifierGate(heldOut, constant(decision));
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining(['missed obvious positive', 'positive recall below threshold'])
    );
  });

  it('fails an always-match classifier on adversarial false positives', () => {
    const result = scoreClassifierGate(heldOut, constant('match'));
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('adversarial false positive');
  });

  it('passes a classifier that matches exactly the positive labels', () => {
    const result = scoreClassifierGate(
      heldOut,
      heldOut.map((item) => ({
        id: item.id,
        decision: item.kind === 'positive' ? 'match' : 'skip',
        latencyMs: 10,
      }))
    );
    expect(result).toMatchObject({ passed: true, metrics: { precision: 1, recall: 1 } });
  });

  it('fails one adversarial match even with perfect recall', () => {
    const adversarial = heldOut.find((item) => item.kind === 'adversarial');
    const result = scoreClassifierGate(
      heldOut,
      heldOut.map((item) => ({
        id: item.id,
        decision: item.kind === 'positive' || item === adversarial ? 'match' : 'skip',
        latencyMs: 10,
      }))
    );
    expect(result.failures).toEqual(['adversarial false positive']);
  });

  it('requires an outcome for every held-out case', () => {
    expect(() => scoreClassifierGate(heldOut, constant('skip').slice(1))).toThrow();
  });
});

describe('checked-in classifier gate record', () => {
  const record = loadClassifierGateRecord();
  const settings = configService.getAgentEventClassifierConfig();

  it('unlocks exactly the providers that passed', () => {
    expect(
      record.providers
        .filter((entry) => entry.passed)
        .map((entry) => entry.provider)
        .toSorted()
    ).toEqual([...PROVEN_CLASSIFIER_PROVIDERS].toSorted());
  });

  it('records passing metrics for the current prompt and configured models', () => {
    for (const entry of record.providers) {
      expect(entry.model).toBe(
        entry.provider === 'CLAUDE' ? settings.claudeModel : settings.codexModel
      );
      if (!entry.passed) {
        continue;
      }
      expect(entry.promptVersion).toBe(AGENT_EVENT_CLASSIFICATION_PROMPT_VERSION);
      expect(entry.measuredAt).not.toBeNull();
      expect(entry.metrics).not.toBeNull();
      expect(entry.metrics && gateFailures(entry.metrics)).toEqual([]);
      expect(entry.metrics).toMatchObject({ fixtureSplit: 'heldOut', cases: heldOut.length });
    }
  });

  it('requires every provider to be proven when the automation inherits its provider', () => {
    expect(semanticFilterSupported(undefined)).toBe(
      isClassifierProven('CLAUDE') && isClassifierProven('CODEX')
    );
    for (const provider of ['CLAUDE', 'CODEX'] as const) {
      expect(semanticFilterSupported(provider)).toBe(isClassifierProven(provider));
    }
  });
});
