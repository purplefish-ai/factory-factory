// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/chat-protocol';
import { AssistantMessageRenderer, LoadingIndicator } from './assistant-message-renderer';

afterEach(() => {
  document.body.innerHTML = '';
});

it('renders an answered question as readable pairs with collapsed tool details', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    flushSync(() =>
      root.render(
        <AssistantMessageRenderer
          message={{
            type: 'question_response',
            questionResponse: {
              toolUseId: 'tool-1',
              status: 'answered',
              questions: [
                {
                  question: 'Which processes?',
                  header: 'Why view',
                  answers: ['CPU', 'Memory'],
                  note: 'Group by workspace',
                },
                { question: 'What does the graph show?', answers: [] },
              ],
            },
            questionToolDetails: { toolName: 'AskUserQuestion', result: 'Raw response' },
          }}
        />
      )
    );
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Answered');
    expect(container.querySelector('dt')?.textContent).toContain('Which processes?');
    expect([...container.querySelectorAll('dd li')].map((item) => item.textContent)).toEqual([
      'CPU',
      'Memory',
    ]);
    expect(container.querySelector('dd')?.textContent).toContain('Group by workspace');
    expect(container.textContent).toContain('Answer unavailable');
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toBe('Raw tool details');
  } finally {
    root.unmount();
  }
});

it('hides supplied private answers, notes, and raw details when any question is redacted', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    flushSync(() =>
      root.render(
        <AssistantMessageRenderer
          message={{
            type: 'question_response',
            questionResponse: {
              toolUseId: 'tool-1',
              status: 'answered',
              questions: [
                { question: 'Which processes?', answers: ['CPU'] },
                {
                  question: 'Which token?',
                  answers: ['Private answer value'],
                  note: 'Private note value',
                  redacted: true,
                },
              ],
            },
            questionToolDetails: { toolName: 'AskUserQuestion', result: 'Private raw response' },
          }}
        />
      )
    );
    expect([...container.querySelectorAll('dd')].map((answer) => answer.textContent)).toEqual([
      'CPU',
      'Private answer hidden',
    ]);
    expect(container.textContent).not.toContain('Private raw response');
    expect(container.querySelector('details')).toBeNull();
  } finally {
    root.unmount();
  }
});

it('renders questions with duplicate IDs and duplicate text without duplicate React keys', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    flushSync(() =>
      root.render(
        <AssistantMessageRenderer
          message={{
            type: 'question_response',
            questionResponse: {
              toolUseId: 'tool-1',
              status: 'answered',
              questions: [
                { id: 'choice', question: 'First choice?', answers: ['One'] },
                { id: 'choice', question: 'Second choice?', answers: ['Two'] },
                { question: 'Another choice?', answers: ['Three'] },
                { question: 'Another choice?', answers: ['Four'] },
              ],
            },
          }}
        />
      )
    );
    expect([...container.querySelectorAll('dd')].map((answer) => answer.textContent)).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
    ]);
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    root.unmount();
    consoleError.mockRestore();
  }
});

describe('LoadingIndicator', () => {
  it('preserves all paragraphs for the inline activity indicator', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() =>
        root.render(<LoadingIndicator latestReasoning={'**First step**\n\n**Current step**'} />)
      );
      expect(container.textContent).toBe('First step Current step');
    } finally {
      root.unmount();
    }
  });

  it('renders reasoning text as plain text with markdown stripped', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: '**Testing** `API` ~~calls~~ with _escalation_',
        })
      );
    });

    expect(container.textContent).toContain('Testing API calls with escalation');
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('`');
    expect(container.textContent).not.toContain('~~');
    expect(container.querySelector('strong')).toBeNull();

    root.unmount();
  });

  it('shows fallback loading text when reasoning is empty', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(LoadingIndicator, { latestReasoning: null }));
    });

    expect(container.textContent).toContain('Agent is working…');

    root.unmount();
  });

  it('strips markdown links to plain text', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: 'Read [the docs](https://example.com/docs) before running this.',
        })
      );
    });

    expect(container.textContent).toContain('Read the docs before running this.');
    expect(container.textContent).not.toContain('[');
    expect(container.textContent).not.toContain('https://example.com/docs');

    root.unmount();
  });

  it('truncates long stripped text to 200 chars with ellipsis', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: `${'a'.repeat(190)} **bold** ${'b'.repeat(40)}`,
        })
      );
    });

    expect(container.textContent).toContain('...');
    expect(container.textContent?.length).toBeLessThanOrEqual(200);
    expect(container.textContent).not.toContain('**');

    root.unmount();
  });

  it('shows fallback text when markdown-only input strips to empty content', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: '***~~~```',
        })
      );
    });

    expect(container.textContent).toContain('Agent is working…');

    root.unmount();
  });

  it('removes dangling underscores from unmatched markdown tokens', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(LoadingIndicator, {
          latestReasoning: 'Working through ___partial markdown',
        })
      );
    });

    expect(container.textContent).toContain('Working through partial markdown');
    expect(container.textContent).not.toContain('_');

    root.unmount();
  });
});

describe('AssistantMessageRenderer', () => {
  it('routes lifecycle messages to the dedicated renderer', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const message = {
      type: 'session_lifecycle',
      lifecycle: {
        eventId: 'event-1',
        kind: 'TURN_INTERRUPTED',
        reason: 'PROMPT_TIMEOUT',
        message: 'Turn stopped: reached the 4-hour limit.',
        timestamp: '2026-07-30T12:22:23.353Z',
      },
    } satisfies AgentMessage;

    flushSync(() => {
      root.render(createElement(AssistantMessageRenderer, { message }));
    });

    expect(container.querySelector('[data-testid="session-lifecycle-message"]')).not.toBeNull();
    expect(container.textContent).toContain('Turn stopped: reached the 4-hour limit.');
    root.unmount();
  });
});
