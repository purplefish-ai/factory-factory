import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { agentEventPayloadSchema, type AgentEventPayload } from '@/shared/agent-runtime';

/**
 * Release gate for the event classifier's replay fixtures. These are fixture
 * gates, not population accuracy claims.
 */
export const CLASSIFIER_GATE_THRESHOLDS = {
  maxAdversarialFalsePositives: 0,
  minPositiveRecall: 0.9,
  maxErrorOrUncertainRate: 0.1,
} as const;

const text = z.string().min(1).max(4000);
const caseFields = {
  id: z.string().regex(/^[th]\d{2}$/),
  split: z.enum(['tuning', 'heldOut']),
  kind: z.enum(['positive', 'negative', 'adversarial']),
  /** Frozen before tuning: every obvious positive must match for the gate to pass. */
  obvious: z.boolean(),
  filter: z.string().min(1),
};
const fixtureCaseSchema = z
  .discriminatedUnion('source', [
    z.strictObject({ ...caseFields, source: z.literal('GITHUB'), title: text, body: text }),
    z.strictObject({
      ...caseFields,
      source: z.literal('SLACK'),
      text,
      threadReply: z.boolean(),
    }),
  ])
  .refine((value) => value.kind === 'positive' || !value.obvious, 'Only positives are obvious');
const fixturesSchema = z
  .strictObject({
    version: z.literal(1),
    filters: z.record(z.string().regex(/^[A-Z]+$/), text),
    cases: z.array(fixtureCaseSchema).min(40),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.cases.map((item) => item.id)).size !== value.cases.length) {
      ctx.addIssue({ code: 'custom', message: 'Case identities must be unique' });
    }
    for (const item of value.cases) {
      if (!value.filters[item.filter]) {
        ctx.addIssue({ code: 'custom', message: `Unknown filter for ${item.id}` });
      }
    }
  });
export type ClassifierFixtureCase = z.infer<typeof fixtureCaseSchema>;

const metricsSchema = z.strictObject({
  fixtureSplit: z.enum(['tuning', 'heldOut']),
  cases: z.number().int().nonnegative(),
  positives: z.number().int().nonnegative(),
  obviousPositives: z.number().int().nonnegative(),
  negatives: z.number().int().nonnegative(),
  adversarial: z.number().int().nonnegative(),
  decisions: z.strictObject({
    match: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  }),
  truePositives: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  adversarialFalsePositives: z.number().int().nonnegative(),
  missedObviousPositives: z.array(z.string()),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  errorOrUncertainRate: z.number().min(0).max(1),
  latencyMs: z.strictObject({
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
});
export type ClassifierGateMetrics = z.infer<typeof metricsSchema>;
const gateRecordSchema = z.strictObject({
  version: z.literal(1),
  thresholds: z.strictObject({
    maxAdversarialFalsePositives: z.number(),
    minPositiveRecall: z.number(),
    maxErrorOrUncertainRate: z.number(),
  }),
  providers: z
    .array(
      z.strictObject({
        provider: z.enum(['CLAUDE', 'CODEX']),
        model: z.string().min(1),
        promptVersion: z.string().min(1),
        passed: z.boolean(),
        measuredAt: z.iso.datetime().nullable(),
        metrics: metricsSchema.nullable(),
        notes: z.string().max(2000).optional(),
      })
    )
    .length(2),
});

/** The checked-in records live with the agent-definition capsule they gate. */
function readRecord(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../backend/services/agent-definition/testing/${name}`, import.meta.url),
      'utf8'
    )
  );
}
export function loadClassifierFixtures() {
  return fixturesSchema.parse(readRecord('classifier-fixtures.json'));
}
export function loadClassifierGateRecord() {
  return gateRecordSchema.parse(readRecord('classifier-gate.json'));
}

/** Expands a compact fixture into a stored event payload with synthetic identities. */
export function fixturePayload(item: ClassifierFixtureCase): AgentEventPayload {
  const time = { occurredAt: '2026-11-01T12:00:00.000Z', observedAt: '2026-11-01T12:00:05.000Z' };
  const number = Number(item.id.slice(1)) + (item.split === 'heldOut' ? 100 : 0);
  if (item.source === 'GITHUB') {
    return agentEventPayloadSchema.parse({
      version: 1,
      provider: 'GITHUB',
      ...time,
      sourceUrl: `https://github.com/example-org/example-app/issues/${number}`,
      actorId: 'fixture-actor',
      repositoryId: '1000',
      repositoryFullName: 'example-org/example-app',
      action: 'labeled',
      creatorId: 'fixture-creator',
      issue: { number, title: item.title, body: item.body, addedLabel: 'agent' },
    });
  }
  const eventTs = `1762000000.${String(number).padStart(6, '0')}`;
  return agentEventPayloadSchema.parse({
    version: 1,
    provider: 'SLACK',
    ...time,
    sourceUrl: `https://example.slack.com/archives/C0FIXTURE/p${number}`,
    actorId: 'U0FIXTURE',
    workspaceId: 'T0FIXTURE',
    appId: 'A0FIXTURE',
    channelId: 'C0FIXTURE',
    action: 'message',
    eventTs,
    threadTs: item.threadReply ? '1762000000.000001' : null,
    actorType: 'HUMAN',
    subtype: null,
    text: item.text,
  });
}

export type ClassifierGateOutcome = {
  id: string;
  decision: 'match' | 'skip' | 'uncertain' | 'error';
  latencyMs: number;
};

function percentile(values: number[], fraction: number) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length
    ? (sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0)
    : 0;
}
const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;

export function gateFailures(metrics: ClassifierGateMetrics) {
  const failures: string[] = [];
  if (metrics.adversarialFalsePositives > CLASSIFIER_GATE_THRESHOLDS.maxAdversarialFalsePositives) {
    failures.push('adversarial false positive');
  }
  if (metrics.missedObviousPositives.length > 0) {
    failures.push('missed obvious positive');
  }
  if (metrics.recall < CLASSIFIER_GATE_THRESHOLDS.minPositiveRecall) {
    failures.push('positive recall below threshold');
  }
  if (metrics.errorOrUncertainRate > CLASSIFIER_GATE_THRESHOLDS.maxErrorOrUncertainRate) {
    failures.push('error or uncertain rate above threshold');
  }
  if (metrics.positives === 0 || metrics.adversarial === 0) {
    failures.push('fixture set lacks positives or adversarial cases');
  }
  return failures;
}

function tally(cases: ClassifierFixtureCase[], byId: Map<string, ClassifierGateOutcome>) {
  const counts = {
    decisions: { match: 0, skip: 0, uncertain: 0, error: 0 },
    truePositives: 0,
    falsePositives: 0,
    adversarialFalsePositives: 0,
    missedObviousPositives: [] as string[],
  };
  for (const item of cases) {
    const decision = byId.get(item.id)?.decision ?? 'error';
    counts.decisions[decision]++;
    if (decision !== 'match') {
      if (item.obvious) {
        counts.missedObviousPositives.push(item.id);
      }
    } else if (item.kind === 'positive') {
      counts.truePositives++;
    } else {
      counts.falsePositives++;
      counts.adversarialFalsePositives += item.kind === 'adversarial' ? 1 : 0;
    }
  }
  return counts;
}

/** Scores one split's outcomes; every case must have exactly one outcome. */
export function scoreClassifierGate(
  cases: ClassifierFixtureCase[],
  outcomes: ClassifierGateOutcome[]
) {
  const caseIds = new Set(cases.map((item) => item.id));
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  if (
    byId.size !== outcomes.length ||
    byId.size !== caseIds.size ||
    [...caseIds].some((id) => !byId.has(id))
  ) {
    throw new Error('Each case needs exactly one outcome');
  }
  const splits = new Set(cases.map((item) => item.split));
  const fixtureSplit = cases[0]?.split;
  if (splits.size !== 1 || !fixtureSplit) {
    throw new Error('Score exactly one fixture split');
  }
  const {
    decisions,
    truePositives,
    falsePositives,
    adversarialFalsePositives,
    missedObviousPositives,
  } = tally(cases, byId);
  const positives = cases.filter((item) => item.kind === 'positive').length;
  const latencies = outcomes.map((outcome) => outcome.latencyMs);
  const metrics: ClassifierGateMetrics = {
    fixtureSplit,
    cases: cases.length,
    positives,
    obviousPositives: cases.filter((item) => item.obvious).length,
    negatives: cases.filter((item) => item.kind === 'negative').length,
    adversarial: cases.filter((item) => item.kind === 'adversarial').length,
    decisions,
    truePositives,
    falsePositives,
    adversarialFalsePositives,
    missedObviousPositives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, positives),
    errorOrUncertainRate: ratio(decisions.error + decisions.uncertain, cases.length),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(0, ...latencies),
    },
  };
  const failures = gateFailures(metrics);
  return { passed: failures.length === 0, failures, metrics };
}
