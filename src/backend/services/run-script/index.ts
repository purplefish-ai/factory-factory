// Bridge interfaces for orchestration layer wiring
export type { RunScriptWorkspaceBridge } from './service/bridges';

export { EventSetupError, type EventStartupScriptOptions } from './service/event-startup-script';

// Factory configuration and run-script infrastructure
export { FactoryConfigService } from './service/factory-config.service';

// Run script execution
export { createRunScriptService, RunScriptService } from './service/run-script.service';
export {
  type PersistWorkspaceCommands,
  type RunScriptCommandCache,
  runScriptConfigPersistenceService,
} from './service/run-script-config-persistence.service';

// State machine
export {
  RUN_SCRIPT_STATUS_CHANGED,
  RunScriptStateMachineError,
  type RunScriptStatusChangedEvent,
  runScriptStateMachine,
  type TransitionOptions,
} from './service/run-script-state-machine.service';

// Startup script execution
export {
  type RunStartupScriptOptions,
  type StartupScriptResult,
  startupScriptService,
} from './service/startup-script.service';
