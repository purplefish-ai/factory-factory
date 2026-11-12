import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentActivationAccessor,
  type StartingTrigger,
} from '@/backend/services/agent-definition/resources/agent-activation.accessor';
import {
  completeSlack,
  listStartingSlack,
} from '@/backend/services/agent-definition/resources/slack-activation.accessor';
import { configService } from '@/backend/services/config.service';
import {
  agentActivationInputSchema,
  agentManagementIdSchema,
  agentNativeIntentSchema,
} from '@/shared/agent-management';
import { agentDefinitionRevisionSchema } from '@/shared/schemas/agent-definition.schema';
import type { AgentSourcePollService } from './agent-source-poll.service';

const beginActivationSchema = agentActivationInputSchema.extend({
  definitionRevision: agentDefinitionRevisionSchema,
  projectSource: z.strictObject({
    githubOwner: z.string().nullable(),
    githubRepo: z.string().nullable(),
  }),
  execution: agentNativeIntentSchema,
  triggerIds: z.array(agentManagementIdSchema).max(20),
  slackSources: z
    .array(
      z.strictObject({
        connectionId: agentManagementIdSchema,
        workspaceId: agentManagementIdSchema,
        appId: agentManagementIdSchema,
      })
    )
    .max(20)
    .default([]),
  sourceNames: z.record(z.string().max(600), z.string().max(500)).default({}),
});
type BaselineSource = Pick<AgentSourcePollService, 'prepareBaseline'>;
type Prepared = { ok: true; id: string } | { ok: false };

/**
 * Two-step activation. Enable moves supported triggers to STARTING. A GitHub
 * trigger prepares a provider baseline and becomes ACTIVE once it resolves;
 * `completePending` finishes, retries or expires those after each source poll
 * cycle. A Slack trigger waits for a test message in each selected channel;
 * `completeSlackPending` applies them and activates or expires the generation.
 * Either way activation is one transaction that rechecks everything that
 * permits it.
 */
export class AgentActivationService {
  constructor(
    private readonly source: BaselineSource,
    private readonly now: () => Date = () => new Date()
  ) {}

  async begin(input: unknown, signal: AbortSignal) {
    const parsed = beginActivationSchema.parse(input);
    const limits = configService.getAgentRuntimeLimits();
    if (parsed.slackSources.length && !limits.slackIntakeEnabled) {
      throw new ApplicationError('PRECONDITION_FAILED', 'Slack event intake is not available yet.');
    }
    const starting = await agentActivationAccessor.begin(parsed, this.now(), {
      githubMs: limits.activationExpiryMs,
      slackMs: limits.slackActivationExpiryMs,
    });
    await this.advance(starting, signal);
  }

  async completePending(signal: AbortSignal) {
    await this.advance(await agentActivationAccessor.listStarting(), signal);
  }

  /** Database-only, so it runs with each evaluation pass and a test message counts within seconds. */
  async completeSlackPending(signal: AbortSignal) {
    for (const trigger of await listStartingSlack()) {
      if (signal.aborted) {
        return;
      }
      await completeSlack(trigger, this.now());
    }
  }

  pause(input: unknown) {
    return agentActivationAccessor.pause(agentActivationInputSchema.parse(input));
  }

  private async advance(starting: StartingTrigger[], signal: AbortSignal) {
    // One baseline per connection and pass: it postdates every listed generation.
    const prepared = new Map<string, Promise<Prepared>>();
    for (const trigger of starting) {
      if (signal.aborted) {
        return;
      }
      if ((await agentActivationAccessor.activate(trigger, this.now())) !== 'NEEDS_BASELINE') {
        continue;
      }
      let baseline = prepared.get(trigger.connectionId);
      if (!baseline) {
        baseline = this.prepare(trigger.connectionId, signal);
        prepared.set(trigger.connectionId, baseline);
      }
      const result = await baseline;
      if (signal.aborted) {
        // An interrupted preparation stays STARTING; the next cycle retries it.
        return;
      }
      if (!result.ok) {
        await agentActivationAccessor.failStarting(trigger);
        continue;
      }
      await agentActivationAccessor.recordBaseline(trigger, result.id);
      await agentActivationAccessor.activate(trigger, this.now());
    }
  }

  private async prepare(connectionId: string, signal: AbortSignal): Promise<Prepared> {
    try {
      const baseline = await this.source.prepareBaseline(connectionId, signal);
      return { ok: true, id: baseline.id };
    } catch {
      // The poll service records source health; the trigger reports it as its reason.
      return { ok: false };
    }
  }
}
