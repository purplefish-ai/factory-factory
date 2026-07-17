// Domain: terminal
// Public API for the terminal domain module.
// Consumers should import from '@/backend/services/terminal' only.

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
export type { TerminalSession } from './terminal-session.service';
export { terminalSessionService } from './terminal-session.service';
