// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserQuestionRequest } from '@/lib/chat-protocol';
import { QuestionPrompt } from './question-prompt';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('QuestionPrompt', () => {
  it('uses compact mobile card padding and wrapping text styles', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();

    const question: UserQuestionRequest = {
      requestId: 'question-mobile-1',
      timestamp: '2026-02-18T00:00:00.000Z',
      questions: [
        {
          header: 'ExtremelyLongHeaderThatWouldOtherwiseOverflowOnNarrowScreens',
          question:
            'What should we do with this very long question label that needs wrapping on mobile devices?',
          options: [
            {
              label:
                'Allow always for this command pattern and working directory scope in this workspace',
              description:
                'Use this when you want to persist approval with context and avoid repeated prompts',
            },
          ],
        },
      ],
    };

    flushSync(() => {
      root.render(createElement(QuestionPrompt, { question, onAnswer }));
    });

    const promptCard = container.querySelector('[role="form"]');
    expect(promptCard).not.toBeNull();
    expect(promptCard?.className).toContain('px-3');

    const header = Array.from(container.querySelectorAll('h4')).find((node) =>
      node.textContent?.includes('ExtremelyLongHeaderThatWouldOtherwiseOverflowOnNarrowScreens')
    );
    expect(header?.className).toContain('break-words');

    const optionLabel = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes(
        'Allow always for this command pattern and working directory scope'
      )
    );
    expect(optionLabel?.className).toContain('break-words');

    const optionDescription = Array.from(container.querySelectorAll('p')).find((node) =>
      node.textContent?.includes('persist approval with context')
    );
    expect(optionDescription?.className).toContain('break-words');

    const optionContainer = optionLabel?.closest('label');
    expect(optionContainer?.className).toContain('p-1');

    root.unmount();
  });
});
