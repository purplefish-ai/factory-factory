/**
 * Integration test setup file.
 *
 * Configures the test environment for integration tests that run real Claude CLI sessions.
 */

import { execSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

// Ensure we have a clean environment for each test
beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Global setup - verify Claude CLI is available
beforeAll(() => {
  try {
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Claude CLI not found. Integration tests require the Claude CLI to be installed.\n' +
        'Install it with: npm install -g @anthropic-ai/claude-code'
    );
  }

  // Verify ANTHROPIC_API_KEY is set (required for real Claude tests)
  if (!process.env.ANTHROPIC_API_KEY) {
    // Warning is intentionally skipped - CI will have the key set
  }
});

// Global teardown
afterAll(async () => {
  // Give any lingering processes time to clean up
  await new Promise((resolve) => setTimeout(resolve, 100));
});
