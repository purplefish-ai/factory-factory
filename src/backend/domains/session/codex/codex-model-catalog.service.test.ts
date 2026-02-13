import { describe, expect, it, vi } from 'vitest';
import { CodexModelCatalogService } from './codex-model-catalog.service';

describe('CodexModelCatalogService', () => {
  it('loads paginated model/list data and deduplicates by model id', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-5.3-codex',
            model: 'gpt-5.3-codex',
            upgrade: null,
            displayName: 'gpt-5.3-codex',
            description: 'Latest',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Low' },
              { reasoningEffort: 'medium', description: 'Medium' },
            ],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: true,
          },
        ],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-5.3-codex',
            model: 'gpt-5.3-codex',
            upgrade: null,
            displayName: 'gpt-5.3-codex',
            description: 'Duplicate',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
            defaultReasoningEffort: 'low',
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: false,
          },
          {
            id: 'gpt-5.2-codex',
            model: 'gpt-5.2-codex',
            upgrade: null,
            displayName: 'gpt-5.2-codex',
            description: 'Previous',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
            defaultReasoningEffort: 'low',
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: false,
          },
        ],
        nextCursor: null,
      });

    const service = new CodexModelCatalogService({ request });

    const models = await service.listModels({ forceRefresh: true });

    expect(request).toHaveBeenCalledTimes(2);
    expect(models.map((model) => model.model)).toEqual(['gpt-5.3-codex', 'gpt-5.2-codex']);
  });

  it('falls back to cached models when refresh fails', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-5.3-codex',
            model: 'gpt-5.3-codex',
            upgrade: null,
            displayName: 'gpt-5.3-codex',
            description: 'Latest',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: true,
          },
        ],
        nextCursor: null,
      })
      .mockRejectedValueOnce(new Error('temporary failure'));

    const service = new CodexModelCatalogService({ request });

    const first = await service.listModels({ forceRefresh: true });
    const second = await service.listModels({ forceRefresh: true });

    expect(first).toEqual(second);
  });
});
