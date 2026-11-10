import { expect, it, vi } from 'vitest';
import { SessionDeltaEventSchema } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { AcpEventProcessor, type AcpEventProcessorDependencies } from './acp-event-processor';

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));

it('finalizes orphaned tool calls with deltas the chat client accepts', () => {
  const emitDelta = vi.fn();
  const processor = new AcpEventProcessor(
    unsafeCoerce<AcpEventProcessorDependencies>({
      runtimeManager: { getClient: vi.fn() },
      sessionDomainService: { emitDelta, appendClaudeEvent: vi.fn().mockReturnValue(7) },
      sessionPermissionService: {},
      sessionConfigService: {},
      onToolCallTimeout: vi.fn(),
    })
  );
  processor.pendingAcpToolCalls.set(
    'sid',
    new Map([
      [
        'tool-1',
        {
          toolUseId: 'tool-1',
          toolName: 'Bash',
          acpKind: 'execute',
          acpLocations: [{ path: '/tmp/out.txt', line: 3 }],
        },
      ],
    ])
  );

  processor.finalizeOrphanedToolCalls('sid', 'runtime exited');

  const deltas = emitDelta.mock.calls.map(([, delta]) => JSON.parse(JSON.stringify(delta)));
  expect(deltas.map((delta) => delta.type)).toEqual(['tool_progress', 'agent_message']);
  for (const delta of deltas) {
    expect(SessionDeltaEventSchema.safeParse(delta)).toMatchObject({ success: true, data: delta });
  }
});
