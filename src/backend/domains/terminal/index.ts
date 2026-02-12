// Domain: terminal
// Public API for the terminal domain module.
// Consumers should import from '@/backend/domains/terminal' only.

// --- Terminal PTY management, output buffering, and monitoring ---
export {
  type CreateTerminalOptions,
  type CreateTerminalResult,
  type TerminalInstance,
  type TerminalOutput,
  type TerminalResourceUsage,
  TerminalService,
  terminalService,
} from './terminal.service';
