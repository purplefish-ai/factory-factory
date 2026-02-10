// Domain: run-script
// Public API for the run script domain module.
// Consumers should import from '@/backend/domains/run-script' only.

// Run script execution
export { RunScriptService, runScriptService } from './run-script.service';

// State machine
export {
  RunScriptStateMachineError,
  runScriptStateMachine,
  type TransitionOptions,
} from './run-script-state-machine.service';

// Startup script execution
export {
  type StartupScriptResult,
  startupScriptService,
} from './startup-script.service';
