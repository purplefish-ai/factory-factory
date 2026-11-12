import { z } from 'zod';
import {
  agentActivationAccessor,
  type StartingTrigger,
} from '@/backend/services/agent-definition/resources/agent-activation.accessor';
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
});
type BaselineSource = Pick<AgentSourcePollService, 'prepareBaseline'>;
type Prepared = { ok: true; id: string } | { ok: false };

/**
 * Two-step GitHub activation. Enable moves supported triggers to STARTING and
 * prepares a provider baseline; a trigger becomes ACTIVE only once that
 * baseline resolves, in one transaction that rechecks everything that permits
 * it. `completePending` finishes, retries or expires STARTING generations after
 * each source poll cycle.
 */
export class AgentActivationService {
  constructor(
    private readonly source: BaselineSource,
    private readonly now: () => Date = () => new Date()
  ) {}

  async begin(input: unknown, signal: AbortSignal) {
    const parsed = beginActivationSchema.parse(input);
    const starting = await agentActivationAccessor.begin(
      parsed,
      this.now(),
      configService.getAgentRuntimeLimits().activationExpiryMs
    );
    await this.advance(starting, signal);
  }

  async completePending(signal: AbortSignal) {
    await this.advance(await agentActivationAccessor.listStarting(), signal);
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
