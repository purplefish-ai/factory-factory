import { describe, expect, it } from 'vitest';
import {
  extractCommandPreviewFromInput,
  getDisplayToolName,
  isRunLikeToolName,
} from './tool-display-utils';

describe('tool-display-utils', () => {
  describe('isRunLikeToolName', () => {
    it('detects run tool names with command suffixes', () => {
      expect(isRunLikeToolName('Run cat > /tmp/pr-body.md')).toBe(true);
      expect(isRunLikeToolName('run git push origin main')).toBe(true);
      expect(isRunLikeToolName('Run')).toBe(true);
      expect(isRunLikeToolName('RunScript')).toBe(false);
      expect(isRunLikeToolName('Bash')).toBe(false);
    });
  });

  describe('extractCommandPreviewFromInput', () => {
    it('extracts shell script payload after -lc', () => {
      const preview = extractCommandPreviewFromInput({
        command: ['/bin/zsh', '-lc', 'cat > /tmp/pr-body.md <<EOF\nhello\nEOF'],
      });

      expect(preview).toBe('cat > /tmp/pr-body.md <<EOF hello EOF');
    });

    it('extracts direct string commands', () => {
      const preview = extractCommandPreviewFromInput({
        command: 'git push -u origin release/v0.3.0',
      });

      expect(preview).toBe('git push -u origin release/v0.3.0');
    });

    it('does not treat non-shell -c as a shell script flag', () => {
      const preview = extractCommandPreviewFromInput({
        command: ['uv', 'run', 'python', '-c', 'print("hello")'],
      });

      expect(preview).toBe('uv run python -c print("hello")');
    });
  });

  describe('getDisplayToolName', () => {
    it('shows compact run labels in summary mode', () => {
      const display = getDisplayToolName(
        'Run cat > /tmp/pr-body.md <<EOF',
        {
          command: ['/bin/zsh', '-lc', 'cat > /tmp/pr-body.md <<EOF\nhello\nEOF'],
        },
        { summary: true }
      );

      expect(display).toBe('Run');
    });

    it('shows command-aware labels in detail mode', () => {
      const display = getDisplayToolName('Run cat > /tmp/pr-body.md <<EOF', {
        command: ['/bin/zsh', '-lc', 'cat > /tmp/pr-body.md <<EOF\nhello\nEOF'],
      });

      expect(display).toBe('Run cat > /tmp/pr-body.md <<EOF hello EOF');
    });

    it('keeps non-shell -c flags in detail mode', () => {
      const display = getDisplayToolName('Run uv run python -c', {
        command: ['uv', 'run', 'python', '-c', 'print("hello")'],
      });

      expect(display).toBe('Run uv run python -c print("hello")');
    });

    it('truncates long non-run names in summary mode', () => {
      const display = getDisplayToolName(
        'Read deeply nested path with a very long descriptive title for diagnostics',
        {}
      );
      const summaryDisplay = getDisplayToolName(
        'Read deeply nested path with a very long descriptive title for diagnostics',
        {},
        { summary: true }
      );

      expect(display).toBe(
        'Read deeply nested path with a very long descriptive title for diagnostics'
      );
      expect(summaryDisplay).toBe('Read deeply nested path…');
    });

    it('formats webSearch as first-class labels', () => {
      const display = getDisplayToolName(
        'webSearch',
        {
          type: 'webSearch',
          id: 'ws_123',
          query: 'OpenAI Codex app-server command/exec method',
          action: { type: 'other' },
        },
        { summary: false }
      );
      const summaryDisplay = getDisplayToolName(
        'webSearch',
        {
          type: 'webSearch',
          id: 'ws_123',
          query: 'OpenAI Codex app-server command/exec method',
          action: { type: 'other' },
        },
        { summary: true }
      );

      expect(display).toBe('Web search OpenAI Codex app-server command/exec method');
      expect(summaryDisplay).toBe('Web search');
    });
  });
});
