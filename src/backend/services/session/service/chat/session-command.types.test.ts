import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { expectTypeOf, it } from 'vitest';
import type { SessionCommandOutcome } from './session-command.types';

it('requires at least one confirmed option in a configuration correction', () => {
  expectTypeOf<SessionCommandOutcome['configOptionsCorrection']>().toEqualTypeOf<
    [SessionConfigOption, ...SessionConfigOption[]] | undefined
  >();
});
