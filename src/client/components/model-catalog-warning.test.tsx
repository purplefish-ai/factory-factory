// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogWarning } from './model-catalog-warning';

interface Catalog {
  source: 'cli' | 'fallback';
  models: { value: string; label: string }[];
  efforts: [];
}
const mocks = vi.hoisted(() => ({
  settings: undefined as { defaultClaudeModel: string; defaultCodexModel: string } | undefined,
  catalog: undefined as { CLAUDE: Catalog; CODEX: Catalog } | undefined,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    userSettings: {
      get: { useQuery: () => ({ data: mocks.settings }) },
      getProviderOptions: { useQuery: () => ({ data: mocks.catalog }) },
    },
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.settings = { defaultClaudeModel: 'retired-claude', defaultCodexModel: 'default' };
  mocks.catalog = {
    CLAUDE: {
      source: 'cli',
      models: [{ value: 'sonnet', label: 'Sonnet 5.5' }],
      efforts: [],
    },
    CODEX: {
      source: 'cli',
      models: [{ value: 'six-sol', label: '6 Sol' }],
      efforts: [],
    },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});
function render() {
  flushSync(() =>
    root.render(createElement(MemoryRouter, null, createElement(ModelCatalogWarning)))
  );
}

describe('ModelCatalogWarning', () => {
  it('warns outside settings about missing saved models and links to chat defaults', () => {
    mocks.settings!.defaultCodexModel = 'retired-codex';
    render();
    const warning = container.querySelector('[role="alert"]');
    expect(warning?.textContent).toContain('Claude');
    expect(warning?.textContent).toContain('retired-claude');
    expect(warning?.textContent).toContain('Codex');
    expect(warning?.textContent).toContain('retired-codex');
    expect(warning?.textContent).toContain('not in the current model catalog');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/admin');
  });

  it.each(['settings', 'catalog'] as const)('waits for %s before warning', (key) => {
    mocks[key] = undefined;
    render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not treat a fallback list as evidence of a missing model', () => {
    mocks.catalog!.CLAUDE.source = 'fallback';
    render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('still warns for one provider when discovery for the other failed', () => {
    mocks.catalog!.CLAUDE.source = 'fallback';
    mocks.settings!.defaultCodexModel = 'retired-codex';
    render();
    const warning = container.querySelector('[role="alert"]');
    expect(warning?.textContent).toContain('retired-codex');
    expect(warning?.textContent).not.toContain('retired-claude');
  });

  it.each(['sonnet', 'opus', 'haiku', 'fable', 'sonnet[1m]', 'opus[1m]'])(
    'accepts the Claude alias %s when advertised by the catalog',
    (model) => {
      mocks.catalog!.CLAUDE.models = [{ value: model, label: model }];
      mocks.settings!.defaultClaudeModel = model;
      render();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    }
  );

  it.each([
    { model: 'sonnet', options: [{ value: 'claude-sonnet-5', label: 'Sonnet 5' }] },
    {
      model: 'sonnet[1m]',
      options: [{ value: 'claude-sonnet-5[1m]', label: 'Sonnet 5 (1M)' }],
    },
    { model: 'claude-sonnet-5', options: [{ value: 'sonnet', label: 'Sonnet 5' }] },
    {
      model: 'claude-sonnet-5-5[1m]',
      options: [{ value: 'sonnet[1m]', label: 'Sonnet 5.5 (1M)' }],
    },
  ])('accepts an equivalent Claude catalog selection: $model', ({ model, options }) => {
    mocks.settings!.defaultClaudeModel = model;
    mocks.catalog!.CLAUDE.models = options;
    render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    { model: 'opus[1m]', options: [{ value: 'opus', label: 'Opus 5' }] },
    { model: 'sonnet[1m]', options: [{ value: 'claude-sonnet-5', label: 'Sonnet 5' }] },
    { model: 'claude-sonnet-5', options: [{ value: 'sonnet', label: 'Sonnet 5.5' }] },
    {
      model: 'sonnet',
      options: [
        { value: 'claude-sonnet-5', label: 'Sonnet 5' },
        { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      ],
    },
  ])('warns when a Claude selection cannot resolve: $model', ({ model, options }) => {
    mocks.settings!.defaultClaudeModel = model;
    mocks.catalog!.CLAUDE.models = options;
    render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(model);
  });

  it('accepts a catalog Codex model alongside a supported Claude alias', () => {
    mocks.settings = { defaultClaudeModel: 'sonnet', defaultCodexModel: 'six-sol' };
    render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('clears the warning when the user chooses a catalog model', () => {
    render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    mocks.settings!.defaultClaudeModel = 'sonnet';
    render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('clears the warning when the saved model returns to the live catalog', () => {
    render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    mocks.catalog!.CLAUDE.models.push({ value: 'retired-claude', label: 'Restored model' });
    render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.settings!.defaultClaudeModel).toBe('retired-claude');
  });
});
