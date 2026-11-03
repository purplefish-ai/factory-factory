import { expect, it } from 'vitest';
import { formatThinkingText } from './thinking-preview';

it.each([
  ['**Use `user_id` safely**', 'Use user_id safely'],
  ['[Read `API` docs](https://example.com)', 'Read API docs'],
  ['**Checking _current_ state**', 'Checking current state'],
  ['_Use **bold** safely_', 'Use bold safely'],
  ['Running `npm ru', 'Running npm ru'],
  ['Checking results**', 'Checking results'],
  ['Checking results_', 'Checking results'],
  ['Inspect `user_id_`', 'Inspect user_id_'],
])('cleans surrounding Markdown while preserving literal code: %s', (input, expected) => {
  expect(formatThinkingText(input)).toBe(expected);
});
