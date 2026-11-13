// --- Terminal PTY management, output buffering, and monitoring ---
export {
  type CreateTerminalOptions,
  type CreateTerminalResult,
  type TerminalInstance,
  type TerminalOutput,
  type TerminalResourceUsage,
  TerminalService,
  terminalService,
} from './service/terminal.service';
export { type TerminalSession, terminalSessionService } from './service/terminal-session.service';
