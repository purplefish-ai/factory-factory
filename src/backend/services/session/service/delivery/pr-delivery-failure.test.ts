import { describe, expect, it } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  classifyPRDeliveryFailure,
  createPRDeliveryBlockedError,
  createResumeFailedError,
} from './pr-delivery-failure';

describe('PR delivery failure reasons', () => {
  it('keeps the user-visible blocked messages unchanged', () => {
    expect(createPRDeliveryBlockedError('busy').message).toBe(
      'A turn is already in progress for this session'
    );
    expect(createPRDeliveryBlockedError('preempted').message).toBe(
      'Turn in progress: human message queued during preparation'
    );
    expect(createPRDeliveryBlockedError('resume_failed').message).toBe(
      'Required existing conversation could not be restored'
    );
    expect(createResumeFailedError().message).toBe(
      'Required existing conversation could not be restored'
    );
  });

  it.each([
    ['busy', 'busy'],
    ['preempted', 'busy'],
    ['resume_failed', 'resume_failed'],
  ] as const)('classifies the typed %s error as %s', (cause, reason) => {
    expect(classifyPRDeliveryFailure(createPRDeliveryBlockedError(cause)).reason).toBe(reason);
  });

  it('classifies by kind when the message is reworded', () => {
    expect(
      classifyPRDeliveryFailure(
        new ApplicationError('CONFLICT', 'Session slot occupied', { kind: 'SESSION_TURN_BUSY' })
      ).reason
    ).toBe('busy');
    expect(
      classifyPRDeliveryFailure(
        new ApplicationError('PRECONDITION_FAILED', 'Could not reopen the chat', {
          kind: 'SESSION_RESUME_FAILED',
        })
      ).reason
    ).toBe('resume_failed');
  });

  it('does not infer a reason from untyped text that merely resembles ours', () => {
    expect(
      classifyPRDeliveryFailure(new Error('Required existing conversation could not be restored'))
        .reason
    ).toBe('failed');
    expect(
      classifyPRDeliveryFailure(
        new Error('Turn in progress: human message queued during preparation')
      ).reason
    ).toBe('failed');
    expect(
      classifyPRDeliveryFailure(
        new Error('Codex account changed; sign in again to restore existing conversations')
      ).reason
    ).toBe('failed');
    expect(
      classifyPRDeliveryFailure(
        new ApplicationError('CONFLICT', 'A turn is already in progress for this session')
      ).reason
    ).toBe('failed');
  });

  it('keeps classifying the provider runtime busy payload as busy', () => {
    expect(
      classifyPRDeliveryFailure({
        code: -32_600,
        message: 'Invalid request',
        data: { reason: 'A turn is already in progress for this session' },
      }).reason
    ).toBe('busy');
    expect(classifyPRDeliveryFailure(new Error('transport failure')).reason).toBe('failed');
  });
});
