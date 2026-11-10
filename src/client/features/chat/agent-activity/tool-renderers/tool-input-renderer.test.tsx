import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolInputRenderer } from './tool-input-renderer';

function render(name: string, input: Record<string, unknown>) {
  return renderToStaticMarkup(<ToolInputRenderer name={name} input={input} />);
}

describe('ToolInputRenderer with malformed agent input', () => {
  it.each([
    ['TodoWrite', { todos: 'not a list' }],
    ['TodoWrite', { todos: { length: 2 } }],
    ['TodoWrite', { todos: null }],
    ['TodoWrite', { todos: [{ content: 'Ship it', status: 'blocked' }] }],
    ['Task', { subagent_type: 'explore', prompt: { text: 'nested' } }],
    ['Read', { file_path: 42, offset: 10 }],
    ['Read', { file_path: 'src/a.ts', offset: 'ten' }],
    ['Write', { file_path: ['src', 'a.ts'], content: 'body' }],
    ['Write', { file_path: 'src/a.ts', content: { lines: 6000 } }],
    ['Edit', { file_path: 'src/a.ts', old_string: 7, new_string: null }],
  ])('shows %s input %j as raw JSON instead of throwing', (name, input) => {
    const html = render(name, input);
    expect(html).toContain('<pre');
    expect(html).toContain(JSON.stringify(input, null, 2).replaceAll('"', '&quot;'));
  });
});

describe('ToolInputRenderer with well-formed agent input', () => {
  it('renders a task list with its progress', () => {
    const html = render('TodoWrite', {
      todos: [
        { content: 'Write tests', status: 'completed' },
        { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
      ],
    });
    expect(html).toContain('Task List (1/2)');
    expect(html).toContain('50%');
    expect(html).toContain('Fixing bug');
  });

  it('treats a missing task list as empty', () => {
    expect(render('TodoWrite', {})).toContain('No todos');
  });

  it('renders the read range and the edited file', () => {
    expect(render('Read', { file_path: 'src/a.ts', offset: 10, limit: 20 })).toContain(
      'Lines 10 - 30'
    );
    const edit = render('Edit', { file_path: 'src/a.ts', old_string: 'old', new_string: 'new' });
    expect(edit).toContain('a.ts');
    expect(edit).toContain('Remove');
    expect(edit).not.toContain('&quot;old_string&quot;');
  });

  it('renders the subagent type and prompt of a task', () => {
    const html = render('Task', { subagent_type: 'explore', prompt: 'Find the bug' });
    expect(html).toContain('explore agent');
    expect(html).toContain('Find the bug');
  });
});
