// @vitest-environment jsdom

import { createElement, Fragment } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserQuestionRequest } from '@/lib/chat-protocol';
import { CommitProbe } from '@/test-utils/commit-probe';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { QuestionPrompt } from './question-prompt';

function typeAnswer(input: HTMLTextAreaElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('QuestionPrompt', () => {
  it('shows a replaced request without the previous answers in its first commit', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const request = (requestId: string): UserQuestionRequest => ({
      requestId,
      timestamp: '2026-10-18T00:00:00Z',
      questions: [
        {
          question: 'Pick one',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
          allowOther: false,
        },
      ],
    });
    const committed: boolean[] = [];
    const onCommit = () =>
      committed.push(Boolean(container.querySelector('[role="radio"][aria-checked="true"]')));
    const render = (requestId: string) =>
      flushSync(() =>
        root.render(
          createElement(
            Fragment,
            null,
            createElement(QuestionPrompt, { question: request(requestId), onAnswer: vi.fn() }),
            createElement(CommitProbe, { onCommit })
          )
        )
      );

    render('first');
    flushSync(() => container.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    expect(container.querySelector('[role="radio"][aria-checked="true"]')).not.toBeNull();

    const before = committed.length;
    render('second');
    expect([...new Set(committed.slice(before))]).toEqual([false]);
    root.unmount();
  });

  it('allows skipping an optional step and preserves its draft when navigating back', () => {
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
    const getButton = (label: string) =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === label
      )!;
    expect(getButton('Next').disabled).toBe(false);
    flushSync(() => getButton('Next').click());
    expect(container.textContent).toContain('2 of 2');
    flushSync(() => getButton('Back').click());
    expect(container.textContent).toContain('1 of 2');
    expect(container.querySelector('textarea')?.value).toBe('');
    typeAnswer(container.querySelector('textarea')!, 'Optional draft');
    flushSync(() => getButton('Next').click());
    expect(container.textContent).toContain('2 of 2');
    flushSync(() => getButton('Back').click());
    expect(container.querySelector('textarea')?.value).toBe('Optional draft');
    root.unmount();
  });

  it.each(['Top processes', 'None of the above'])(
    'keeps the companion note on the same step and submits it with %s',
    (choice) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const onAnswer = vi.fn();
      const question: UserQuestionRequest = {
        requestId: 'codex-choice-with-note',
        timestamp: '',
        questions: [
          {
            id: 'view',
            question: 'What should the detail view show?',
            options: ['Top processes', 'None of the above'].map((label) => ({
              label,
              description: '',
            })),
            allowOther: false,
          },
          {
            id: 'view_note',
            question: 'Additional answer or note',
            options: [],
            optional: true,
            companionNote: { questionId: 'view', revealOnValue: 'None of the above' },
          },
        ],
      };
      flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
      expect(container.querySelector('textarea')).toBeNull();
      const radio = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      ).find((button) => button.closest('label')?.textContent === choice)!;
      flushSync(() => radio.click());
      if (choice === 'Top processes') {
        expect(container.querySelector('textarea')).toBeNull();
        const addNote = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Add a note'
        )!;
        flushSync(() => addNote.click());
      }
      const note = container.querySelector('textarea')!;
      flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          note,
          'Include memory use.'
        );
        note.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const submit = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Submit'
      )!;
      expect(submit.disabled).toBe(false);
      flushSync(() => submit.click());
      expect(onAnswer).toHaveBeenCalledWith('codex-choice-with-note', {
        view: choice,
        view_note: 'Include memory use.',
      });
      root.unmount();
    }
  );

  it('opens a custom answer for a companion without a reveal choice', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'choice-with-custom-answer',
      timestamp: '',
      questions: [
        {
          id: 'choice',
          question: 'Choose',
          options: [{ label: 'A', description: '' }],
          optional: true,
          allowOther: false,
        },
        {
          id: 'custom',
          question: 'Custom answer',
          options: [],
          optional: true,
          companionNote: { questionId: 'choice' },
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    expect(container.querySelector('textarea')).toBeNull();
    const addAnswer = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add a custom answer'
    );
    expect(addAnswer).toBeDefined();
    flushSync(() => addAnswer!.click());
    typeAnswer(container.querySelector('textarea')!, 'B');
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenCalledWith('choice-with-custom-answer', { custom: 'B' });
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
    expect(container.querySelector('textarea')).toBeNull();
    flushSync(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))[1]!.click()
    );
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
    expect(container.querySelector('textarea')).toBeNull();
    root.unmount();
  });

  it('omits a blank Other answer to an optional choice', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'optional-other',
      timestamp: '',
      questions: [
        { question: 'Pick one', optional: true, options: [{ label: 'A', description: '' }] },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    const other = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))[1]!;
    flushSync(() => other.click());
    expect(container.querySelector('textarea')).not.toBeNull();
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(false);
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenCalledWith('optional-other', {});
    root.unmount();
  });

  it('validates and submits optional multi-select answers without counting blank Other', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'optional-multi-other',
      timestamp: '',
      questions: [
        {
          id: 'choices',
          question: 'Pick two',
          multiSelect: true,
          optional: true,
          options: ['A', 'B', 'C'].map((label) => ({ label, description: '' })),
          validation: { type: 'array', minItems: 2, maxItems: 2 },
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    const [first, second, third, other] =
      container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    flushSync(() => other!.click());
    expect(submit.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenLastCalledWith('optional-multi-other', {});

    flushSync(() => first!.click());
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Select at least 2 options.'
    );
    flushSync(() => second!.click());
    expect(submit.disabled).toBe(false);
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenLastCalledWith('optional-multi-other', { choices: ['A', 'B'] });

    flushSync(() => third!.click());
    expect(submit.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Select at most 2 options.'
    );
    root.unmount();
  });

  it('discards a multi-select custom answer when Other is unchecked', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const question: UserQuestionRequest = {
      requestId: 'discard-other',
      timestamp: '',
      questions: [
        {
          question: 'Pick multiple',
          multiSelect: true,
          options: [{ label: 'A', description: '' }],
        },
      ],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer: vi.fn() })));
    const other = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
    )[1]!;
    flushSync(() => other.click());
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(true);
    const input = container.querySelector('textarea')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Draft'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => other.click());
    expect(container.querySelector('textarea')).toBeNull();
    flushSync(() => other.click());
    expect(container.querySelector('textarea')?.value).toBe('');
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
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(submit.disabled).toBe(true);
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
    expect(optionContainer?.className).toContain('py-1');

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

    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('[role="radio"]')).toBeNull();

    root.unmount();
  });

  it('accepts a text answer with no options and allowOther disabled', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAnswer = vi.fn();
    const question: UserQuestionRequest = {
      requestId: 'free-form-without-other',
      timestamp: '',
      questions: [{ id: 'text', question: 'Enter a value', options: [], allowOther: false }],
    };
    flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer })));
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )!;
    expect(submit.disabled).toBe(true);
    const input = container.querySelector('textarea');
    expect(input).not.toBeNull();
    typeAnswer(input!, 'A text answer');
    expect(submit.disabled).toBe(false);
    flushSync(() => submit.click());
    expect(onAnswer).toHaveBeenCalledWith('free-form-without-other', { text: 'A text answer' });
    root.unmount();
  });

  it('keeps focus in a focused composer when a question arrives', async () => {
    vi.useFakeTimers();
    try {
      const composer = document.createElement('textarea');
      document.body.appendChild(composer);
      composer.focus();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const question: UserQuestionRequest = {
        requestId: 'focus-guard',
        timestamp: '2026-10-18T00:00:00Z',
        questions: [
          {
            question: 'Pick one',
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
          },
        ],
      };
      flushSync(() => root.render(createElement(QuestionPrompt, { question, onAnswer: vi.fn() })));
      await vi.advanceTimersByTimeAsync(100);

      expect(document.activeElement).toBe(composer);

      composer.blur();
      flushSync(() =>
        root.render(
          createElement(QuestionPrompt, {
            question: { ...question, requestId: 'focus-guard-2' },
            onAnswer: vi.fn(),
          })
        )
      );
      await vi.advanceTimersByTimeAsync(100);

      expect(container.contains(document.activeElement)).toBe(true);
      root.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
