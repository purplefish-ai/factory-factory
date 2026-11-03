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
    it.each([
      ['mcp.codex_apps.github.fetch_pr_comments', 'Fetch PR comments · GitHub'],
      ['mcp.codex_apps.github.list_pull_request_review_threads', 'List PR review threads · GitHub'],
      ['mcp__github__list_pull_request_review_threads', 'List PR review threads · GitHub'],
      ['mcp__playwright__browser_take_screenshot', 'Take screenshot · Playwright'],
      ['mcp__my_server__fetch_build_status', 'Fetch build status · My server'],
      ['mcp.acme.lookupCustomer', 'Lookup customer · Acme'],
      ['mcp__acme__getAPIStatus', 'Get API status · Acme'],
      ['mcp__acme__getJSONSchema', 'Get JSON schema · Acme'],
      ['mcp__acme__getURLs', 'Get URLs · Acme'],
      ['mcp__acme__getURLsForIDs', 'Get URLs for IDs · Acme'],
      ['mcp__GitHub__fetch_pr_comments', 'Fetch PR comments · GitHub'],
      ['mcp.codex_apps.GitHub.fetch_pr_comments', 'Fetch PR comments · GitHub'],
      ['mcp__acme__getSHA256Hash', 'Get SHA256 hash · Acme'],
      ['mcp__acme__readHTTP2Headers', 'Read HTTP2 headers · Acme'],
      ['mcp__acme__encode_base64', 'Encode base64 · Acme'],
      ['mcp__acme__list_v2_items', 'List v2 items · Acme'],
      ['mcp__acme__cafe\u0301Tool', 'Cafe\u0301 tool · Acme'],
      ['mcp__acme__caféTool', 'Café tool · Acme'],
      ['mcp__acme__café', 'Café · Acme'],
      ['mcp__acme__get.PR', 'Get.PR · Acme'],
      ['mcp__acme__getJSONsForURLs', 'Get JSONs for URLs · Acme'],
      ['mcp__acme__delete-records', 'Delete records · Acme'],
      ['mcp__acme__tool__with_separator', 'Tool with separator · Acme'],
      ['mcp__broken', 'mcp__broken'],
      ['mcp__acme__', 'mcp__acme__'],
      ['mcp..lookup', 'mcp..lookup'],
      ['CustomTool', 'CustomTool'],
    ])('formats %s without requiring a known tool', (name, label) => {
      expect(getDisplayToolName(name, {})).toBe(label);
    });

    it('shortens file listings without exposing their target', () => {
      expect(getDisplayToolName('List files in task workspace/src', {})).toBe('List files');
      expect(getDisplayToolName('List files', {})).toBe('List files');
      expect(getDisplayToolName('List files matching a pattern', {})).toBe(
        'List files matching a pattern'
      );
    });

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
