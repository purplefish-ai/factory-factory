// Domain: run-script
// Public API for the run script domain module.
// Consumers should import from '@/backend/domains/run-script' only.

// Bridge interfaces for orchestration layer wiring
export type { RunScriptWorkspaceBridge } from './bridges';

// Run script execution
export { createRunScriptService, RunScriptService } from './run-script.service';

// State machine
export {
  RUN_SCRIPT_STATUS_CHANGED,
  RunScriptStateMachineError,
  type RunScriptStatusChangedEvent,
  runScriptStateMachine,
  type TransitionOptions,
} from './run-script-state-machine.service';

// Startup script execution
export {
  type StartupScriptResult,
  startupScriptService,
} from './startup-script.service';
