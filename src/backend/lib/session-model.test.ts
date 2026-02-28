import { describe, expect, it } from 'vitest';
import { normalizeSessionModelForProvider, resolveSessionModelForProvider } from './session-model';

describe('normalizeSessionModelForProvider', () => {
  it('returns undefined for empty model values', () => {
    expect(normalizeSessionModelForProvider(undefined, 'CLAUDE')).toBeUndefined();
    expect(normalizeSessionModelForProvider(null, 'CODEX')).toBeUndefined();
    expect(normalizeSessionModelForProvider('   ', 'CLAUDE')).toBeUndefined();
  });

  it('normalizes Claude aliases to lowercase', () => {
    expect(normalizeSessionModelForProvider('Opus', 'CLAUDE')).toBe('opus');
    expect(normalizeSessionModelForProvider('SONNET', 'CLAUDE')).toBe('sonnet');
  });

  it('rejects obvious cross-provider model leakage', () => {
    expect(normalizeSessionModelForProvider('opus', 'CODEX')).toBeUndefined();
    expect(normalizeSessionModelForProvider('opus', 'OPENCODE')).toBeUndefined();
    expect(normalizeSessionModelForProvider('claude-sonnet-4-5-20250929', 'CODEX')).toBeUndefined();
    expect(normalizeSessionModelForProvider('gpt-5', 'CLAUDE')).toBeUndefined();
    expect(normalizeSessionModelForProvider('o3', 'CLAUDE')).toBeUndefined();
  });

  it('keeps provider-compatible models', () => {
    expect(normalizeSessionModelForProvider('gpt-5', 'CODEX')).toBe('gpt-5');
    expect(normalizeSessionModelForProvider('gpt-5', 'OPENCODE')).toBe('gpt-5');
    expect(normalizeSessionModelForProvider('gpt-5-codex', 'CODEX')).toBe('gpt-5-codex');
    expect(normalizeSessionModelForProvider('claude-opus-4-5-20251101', 'CLAUDE')).toBe(
      'claude-opus-4-5-20251101'
    );
  });
});

describe('resolveSessionModelForProvider', () => {
  it('falls back to provider defaults when normalized model is missing or invalid', () => {
    expect(resolveSessionModelForProvider(undefined, 'CLAUDE')).toBe('sonnet');
    expect(resolveSessionModelForProvider('opus', 'CODEX')).toBe('default');
    expect(resolveSessionModelForProvider('opus', 'OPENCODE')).toBe('default');
    expect(resolveSessionModelForProvider('gpt-5', 'CLAUDE')).toBe('sonnet');
  });
});
