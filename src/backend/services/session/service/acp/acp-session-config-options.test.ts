import { describe, expect, it } from 'vitest';
import { requireSessionConfigOptions } from './acp-session-config-options';

describe('requireSessionConfigOptions Claude labels', () => {
  it('normalizes flat Claude model names and preserves option values', () => {
    const configOptions = requireSessionConfigOptions('CLAUDE', 'newSession', {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'sonnet',
          options: [
            {
              value: 'default',
              name: 'Default (recommended)',
              description: 'Opus 4.8 with 1M context · Best for everyday tasks',
            },
            {
              value: 'sonnet',
              name: 'Sonnet',
              description: 'Sonnet 5 · Efficient for routine tasks',
            },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
    });

    expect(configOptions[0]?.options).toEqual([
      expect.objectContaining({ value: 'default', name: 'Default — Opus 4.8 (1M)' }),
      expect.objectContaining({ value: 'sonnet', name: 'Sonnet 5' }),
    ]);
    expect(configOptions[1]?.options).toEqual([{ value: 'default', name: 'Default' }]);
  });

  it('normalizes grouped Claude model names without changing group names', () => {
    const configOptions = requireSessionConfigOptions('CLAUDE', 'newSession', {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'fable',
          options: [
            {
              group: 'latest',
              name: 'Latest models',
              options: [
                {
                  value: 'fable',
                  name: 'Fable',
                  description: 'Fable 5 · Most capable for hard tasks',
                },
                {
                  value: 'haiku',
                  name: 'Haiku',
                  description: 'Haiku 4.5 · Fastest for quick answers',
                },
              ],
            },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
    });

    expect(configOptions[0]?.options).toEqual([
      expect.objectContaining({
        name: 'Latest models',
        options: [
          expect.objectContaining({ value: 'fable', name: 'Fable 5' }),
          expect.objectContaining({ value: 'haiku', name: 'Haiku 4.5' }),
        ],
      }),
    ]);
  });

  it('normalizes a category-less Claude model option identified by its id', () => {
    const configOptions = requireSessionConfigOptions('CLAUDE', 'newSession', {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'sonnet',
          options: [
            {
              value: 'sonnet',
              name: 'Sonnet',
              description: 'Sonnet 5 · Efficient for routine tasks',
            },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
    });

    expect(configOptions[0]).toMatchObject({ category: 'model' });
    expect(configOptions[0]?.options).toEqual([
      expect.objectContaining({ value: 'sonnet', name: 'Sonnet 5' }),
    ]);
  });
});
