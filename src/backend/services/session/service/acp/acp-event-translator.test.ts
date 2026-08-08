import { describe, expect, it } from 'vitest';
import { AcpEventTranslator as SharedAcpEventTranslator } from '@/shared/acp-protocol/session-update-translator';
import { AcpEventTranslator } from './acp-event-translator';

describe('AcpEventTranslator compatibility export', () => {
  it('re-exports the shared translator implementation', () => {
    expect(AcpEventTranslator).toBe(SharedAcpEventTranslator);
  });
});
