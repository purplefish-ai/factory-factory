// Note: claude.client.ts is NOT exported here because we use OAuth via Claude Code CLI
// instead of API key-based authentication. See claude-code.client.ts for the OAuth-based client.
export * from './git.client';
export * from './github.client';
export * from './terminal.client';
export * from './tmux.client';
