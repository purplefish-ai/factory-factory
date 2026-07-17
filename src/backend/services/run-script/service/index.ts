// Domain: run-script
// Public API for the run script domain module.
// Consumers should import from '@/backend/services/run-script' only.

// Bridge interfaces for orchestration layer wiring
export type { RunScriptWorkspaceBridge } from './bridges';

// Factory configuration and run-script infrastructure
export { FactoryConfigService } from './factory-config.service';
export { PortAllocationService } from './port-allocation.service';
// Run script execution
export { createRunScriptService, RunScriptService } from './run-script.service';
export {
  type PersistWorkspaceCommands,
  type RunScriptCommandCache,
  runScriptConfigPersistenceService,
} from './run-script-config-persistence.service';
export {
  RunScriptProxyService,
  runScriptProxyService,
} from './run-script-proxy.service';

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
  type RunStartupScriptOptions,
  type StartupScriptResult,
  startupScriptService,
} from './startup-script.service';
