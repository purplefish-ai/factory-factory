// All Claude interactions use claude-code.client.ts which leverages Claude Code CLI with OAuth.
// No ANTHROPIC_API_KEY required - authentication is handled via OAuth.
export * from './git.client';
export * from './github.client';
export * from './tmux.client';
export * from './terminal.client';
