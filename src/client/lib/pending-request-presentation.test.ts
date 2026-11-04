import { describe, expect, it } from 'vitest';
import { getPendingRequestPresentation } from './pending-request-presentation';

describe('pending request presentation', () => {
  it.each(['REVIEW', 'toString', '__proto__'])(
    'provides a complete safe fallback for %s',
    (type) => {
      const presentation = getPendingRequestPresentation(type);
      expect(presentation).toMatchObject({
        label: 'Needs input',
        waitingText: 'Waiting for your input',
      });
      expect(presentation.icon).toBeDefined();
      expect(presentation.composerPlaceholder).toContain('Respond');
    }
  );
});
