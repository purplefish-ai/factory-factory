export const STREAMING_PROSE = [
  '## A smoother transcript',
  '',
  'Text arrives in bursts. A short **word fade** can soften each update while keeping the response close to the incoming stream.',
  '',
  'The next paragraph includes `inline code`, *emphasis*, and a [documentation link](https://example.com/docs). Watch how incomplete formatting behaves as its closing characters arrive.',
  '',
  '- Completed paragraphs should stay stable.',
  '- New words should appear without a growing queue.',
  '- Finishing the reply should reveal its exact Markdown immediately.',
  '',
  'This final paragraph grows while the earlier blocks remain in place. The stream can pause, resume, or finish without replaying the entire reply.',
].join('\n');

export const STREAMING_CODE = [
  '## A long code block',
  '',
  'The open fence is intentionally large to expose the cost of reparsing a growing block.',
  '',
  '```ts',
  ...Array.from({ length: 120 }, (_, index) => `const value${index} = ${index} * 2;`),
  '```',
  '',
  'The code block is now complete.',
].join('\n');

export const STREAMING_STRUCTURES = [
  '## Tables and diagrams',
  '',
  '| Input | Expected behavior |',
  '| --- | --- |',
  '| Prose | Short fades |',
  '| Code | Plain progressive text |',
  '| Completion | Exact final content |',
  '',
  '```mermaid',
  'graph LR',
  '  Received --> Parsed',
  '  Parsed --> Visible',
  '```',
  '',
  'Both panes use our existing diagram renderer.',
].join('\n');

export const STREAMING_LINKS = [
  '## Application rendering',
  '',
  '[POSIX workspace file](/demo/repo/src/file.ts:12)',
  '',
  '[Windows workspace file](C:/repo/src/file.ts:12)',
  '',
  '[GitHub pull request](https://github.com/purplefish-ai/factory-factory/pull/2880)',
  '',
  '![Local image fallback](./design/mockup.png)',
  '',
  '<em>Raw HTML stays literal.</em>',
  '',
  '[Unsafe URL](javascript:alert%281%29)',
].join('\n');
