import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ModelSelector } from './model-selector';

it('does not label an unknown selection with the first effort option', () => {
  const markup = renderToStaticMarkup(
    <ModelSelector
      selectedModel=""
      options={[
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ]}
      onChange={vi.fn()}
    />
  );
  expect(markup).not.toContain('>Low<');
  expect(markup).toContain('Select effort');
});
