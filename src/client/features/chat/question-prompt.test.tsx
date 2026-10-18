// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserQuestionRequest } from '@/lib/chat-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { QuestionPrompt } from './question-prompt';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('QuestionPrompt', () => {
  it('keeps skipped optional progress dots unanswered while allowing navigation', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const question: UserQuestionRequest = {
      requestId: 'optional-progress',
      timestamp: '2026-10-18T00:00:00Z',
      questions: [
        { question: 'Optional note', options: [], optional: true },
        { question: 'Required note', options: [] },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer: vi.fn() })));
    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Next'
    )!;
    expect(next.disabled).toBe(false);
    flushSync(() => next.click());
    expect(container.querySelector('[aria-label="Go to question 1"]')?.className).toContain(
      'bg-muted-foreground/30'
    );
    root.unmount();
  });

  it.each([
    ['abc', 'Enter a number.'],
    ['1.5', 'Enter a whole number.'],
    ['9007199254740992', 'Enter a whole number.'],
    ['0', 'Enter a number greater than or equal to 1.'],
    ['6', 'Enter a number less than or equal to 5.'],
    ['3', null],
  ])('validates numeric freeform answer %s before submission', (value, error) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'numeric',
      timestamp: '2026-10-18T00:00:00Z',
      questions: [
        { question: 'Count', options: [], validation: { type: 'integer', minimum: 1, maximum: 5 } },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    const input = container.querySelector('textarea')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(Boolean(error));
    expect(container.querySelector('[role="alert"]')?.textContent ?? null).toBe(error);
    if (!error) {
      flushSync(() => submit.click());
      expect(onAnswer).toHaveBeenCalledWith('numeric', { Count: '3' });
    }
    root.unmount();
  });

  it('submits a choice transport value while displaying its readable label', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'empty-choice',
      timestamp: '2026-10-18T00:00:00Z',
      questions: [
        {
          id: 'choice',
          question: 'Choose',
          options: [{ label: 'Empty value', value: '__blank__', description: '' }],
          allowOther: false,
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    expect(container.textContent).toContain('Empty value');
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(false);
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenCalledWith('empty-choice', { choice: '__blank__' });
    root.unmount();
  });

  it('hides a stale Other validation error after choosing a regular option', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const question: UserQuestionRequest = {
      requestId: 'stale-error',
      timestamp: '',
      questions: [
        {
          question: 'Count',
          options: [{ label: '3', description: '' }],
          validation: { type: 'integer' },
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer: vi.fn() })));
    const input = container.querySelector('textarea')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'abc'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('false');
    root.unmount();
  });

  it.each([false, true])('preserves a generic __other__ option (multiSelect=%s)', (multiSelect) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'sentinel',
      timestamp: '',
      questions: [
        {
          id: 'choice',
          question: 'Choose',
          options: [{ label: 'Literal', value: '__other__', description: '' }],
          multiSelect,
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>(multiSelect ? '[role="checkbox"]' : '[role="radio"]')!
        .click()
    );
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(false);
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenCalledWith('sentinel', {
      choice: multiSelect ? ['__other__'] : '__other__',
    });
    root.unmount();
  });

  it.each([
    [{ type: 'string', minLength: 3 }, 'ab'],
    [{ type: 'string', maxLength: 3 }, 'abcd'],
    [{ type: 'string', pattern: '^a+$' }, 'bbb'],
    [{ type: 'string', format: 'email' }, 'invalid'],
    [{ type: 'string', format: 'uri' }, 'invalid'],
    [{ type: 'string', format: 'date' }, '2026-02-31'],
    [{ type: 'string', format: 'date-time' }, '2026-10-18'],
  ] as const)('blocks invalid string constraints %j for %s', (validation, value) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const question: UserQuestionRequest = {
      requestId: 'string-validation',
      timestamp: '',
      questions: [
        {
          question: 'Text',
          options: [],
          validation,
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer: vi.fn() })));
    const input = container.querySelector('textarea')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Submit'
      )!.disabled
    ).toBe(true);
    root.unmount();
  });

  it('validates array item counts before allowing submission', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'array-validation',
      timestamp: '',
      questions: [
        {
          id: 'choices',
          question: 'Choose two',
          multiSelect: true,
          allowOther: false,
          options: ['A', 'B', 'C'].map((label) => ({ label, description: '' })),
          validation: { type: 'array', minItems: 2, maxItems: 2 },
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    const choices = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    flushSync(() => choices[0]!.click());
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Select at least 2 options.'
    );
    flushSync(() => choices[1]!.click());
    expect(submit.disabled).toBe(false);
    flushSync(() => choices[2]!.click());
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Select at most 2 options.'
    );
    flushSync(() => choices[2]!.click());
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenCalledWith('array-validation', { choices: ['A', 'B'] });
    root.unmount();
  });

  it('omits skipped optional constrained strings and arrays from submission', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'optional-constraints',
      timestamp: '',
      questions: [
        {
          id: 'note',
          question: 'Note',
          options: [],
          optional: true,
          validation: { type: 'string', minLength: 5 },
        },
        {
          id: 'choices',
          question: 'Choices',
          options: [{ label: 'A', description: '' }],
          multiSelect: true,
          optional: true,
          validation: { type: 'array', minItems: 2 },
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    flushSync(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Next')!
        .click()
    );
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenCalledWith('optional-constraints', {});
    root.unmount();
  });

  it('renders nothing when the questions array is empty', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();

    const question: UserQuestionRequest = {
      requestId: 'question-empty',
      timestamp: '2026-04-28T00:00:00.000Z',
      questions: [],
    };

    flushSync(() => {
      root.render(createElement(QuestionPrompt, { question, onAnswer }));
    });

    expect(container.innerHTML).toBe('');

    root.unmount();
  });

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
    expect(promptCard?.className).toContain('p-3');

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
    expect(optionContainer?.className).toContain('p-1.5');

    const iconWrapper = container.querySelector('[data-slot="question-prompt-icon"]');
    expect(iconWrapper?.className).toContain('hidden');
    expect(iconWrapper?.className).toContain('sm:block');

    root.unmount();
  });

  it.each([true, false])('allows skipping an optional field only when optional=%s', (optional) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question = unsafeCoerce<UserQuestionRequest>({
      requestId: 'optional-field',
      timestamp: '2026-10-18T00:00:00Z',
      questions: [{ id: 'note', question: 'Additional note', options: [], optional }],
    });
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(!optional);
    if (optional) {
      expect(container.textContent).toContain('(optional)');
      flushSync(() => submit.click());
      expect(onAnswer).toHaveBeenCalledWith('optional-field', {});
    }
    root.unmount();
  });

  it.each([false, true])('hides Other when a strict choice has multiSelect=%s', (multiSelect) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const question = unsafeCoerce<UserQuestionRequest>({
      requestId: 'strict',
      timestamp: '2026-10-18T00:00:00Z',
      questions: [
        {
          id: 'choice',
          question: 'Choose',
          options: [{ label: 'A', description: '' }],
          multiSelect,
          allowOther: false,
        },
      ],
    });
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer: vi.fn() })));
    expect(container.textContent).toContain('A');
    expect(container.querySelector('textarea[aria-label="Other response"]')).toBeNull();
    root.unmount();
  });

  it('renders free-form questions with null options without crashing', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();

    const question = unsafeCoerce<UserQuestionRequest>({
      requestId: 'question-freeform-1',
      timestamp: '2026-04-28T00:00:00.000Z',
      questions: [
        {
          header: 'Clarify',
          question: 'What should the agent do next?',
          options: null,
        },
      ],
    });

    expect(() => {
      flushSync(() => {
        root.render(createElement(QuestionPrompt, { question, onAnswer }));
      });
    }).not.toThrow();

    expect(container.querySelector('textarea[aria-label="Other response"]')).not.toBeNull();

    root.unmount();
  });
});
