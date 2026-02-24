import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import { dedupeStrings, isRecord } from './acp-adapter-utils';
import type {
  AdapterSession,
  ApprovalPolicy,
  CodexModelEntry,
  CollaborationModeEntry,
  ExecutionPreset,
  ReasoningEffort,
  SandboxMode,
} from './adapter-state';

export const DEFAULT_APPROVAL_POLICIES: ApprovalPolicy[] = ['on-failure', 'on-request', 'never'];
export const DEFAULT_SANDBOX_MODES: SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function humanizeToken(value: string): string {
  return value
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function sanitizeModeName(mode: string): string {
  return mode
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatApprovalPolicyLabel(policy: ApprovalPolicy): string {
  if (policy === 'on-request') {
    return 'On Request';
  }
  if (policy === 'on-failure') {
    return 'On Failure';
  }
  if (policy === 'never') {
    return 'Never Ask';
  }
  if (policy === 'untrusted') {
    return 'Untrusted';
  }
  return humanizeToken(policy);
}

function formatSandboxModeLabel(mode: SandboxMode): string {
  if (mode === 'workspace-write') {
    return 'Workspace Write';
  }
  if (mode === 'read-only') {
    return 'Read-only';
  }
  if (mode === 'danger-full-access') {
    return 'Full Access';
  }
  return humanizeToken(mode);
}

function formatExecutionPresetName(
  approvalPolicy: ApprovalPolicy,
  sandboxMode: SandboxMode
): string {
  if (approvalPolicy === 'never' && sandboxMode === 'danger-full-access') {
    return 'YOLO (Full Access)';
  }

  return `${formatApprovalPolicyLabel(approvalPolicy)} (${formatSandboxModeLabel(sandboxMode)})`;
}

function createWorkspaceWriteSandboxPolicy(cwd: string): Record<string, unknown> {
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function createDangerFullAccessSandboxPolicy(): Record<string, unknown> {
  return {
    type: 'dangerFullAccess',
  };
}

function parseSandboxModeFromPolicy(policy: unknown): SandboxMode | null {
  if (!isRecord(policy)) {
    return null;
  }
  const policyType = typeof policy.type === 'string' ? policy.type : null;
  if (policyType === 'workspaceWrite') {
    return 'workspace-write';
  }
  if (policyType === 'readOnly') {
    return 'read-only';
  }
  if (policyType === 'dangerFullAccess') {
    return 'danger-full-access';
  }
  return null;
}

export function createSandboxPolicyFromMode(
  mode: SandboxMode,
  cwd: string
): Record<string, unknown> {
  if (mode === 'danger-full-access') {
    return createDangerFullAccessSandboxPolicy();
  }
  if (mode === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
    };
  }
  return createWorkspaceWriteSandboxPolicy(cwd);
}

function createCollaborationModeConfigOption(
  currentMode: string,
  collaborationModes: CollaborationModeEntry[]
): SessionConfigOption {
  const options = collaborationModes
    .filter((entry) => isNonEmptyString(entry.mode))
    .map((entry) => ({
      value: entry.mode,
      name: entry.name,
    }));

  if (!options.some((option) => option.value === currentMode)) {
    options.unshift({ value: currentMode, name: sanitizeModeName(currentMode) });
  }

  return {
    id: 'mode',
    category: 'mode',
    name: 'Collaboration Mode',
    type: 'select',
    currentValue: currentMode,
    options,
  };
}

function createModelConfigOption(
  currentModel: string,
  modelCatalog: CodexModelEntry[]
): SessionConfigOption {
  const options: SessionConfigSelectOption[] = modelCatalog.map((model) => ({
    value: model.id,
    name: model.displayName,
    description: model.description,
  }));

  if (!options.some((option) => option.value === currentModel)) {
    options.unshift({ value: currentModel, name: currentModel });
  }

  return {
    id: 'model',
    category: 'model',
    name: 'Model',
    type: 'select',
    currentValue: currentModel,
    options,
  };
}

function createReasoningEffortConfigOption(
  currentReasoningEffort: ReasoningEffort | null,
  modelCatalog: CodexModelEntry[],
  currentModel: string
): SessionConfigOption | null {
  const modelEntry = modelCatalog.find((model) => model.id === currentModel);
  if (!modelEntry) {
    return null;
  }

  const supportedEntries = modelEntry.supportedReasoningEfforts.filter((entry) =>
    isNonEmptyString(entry.reasoningEffort)
  );
  if (supportedEntries.length === 0) {
    return null;
  }

  const supportedByValue = new Map<string, string | undefined>();
  for (const entry of supportedEntries) {
    if (!supportedByValue.has(entry.reasoningEffort)) {
      supportedByValue.set(entry.reasoningEffort, entry.description);
    }
  }

  const supportedValues = [...supportedByValue.keys()];
  const resolvedCurrent =
    currentReasoningEffort && supportedByValue.has(currentReasoningEffort)
      ? currentReasoningEffort
      : supportedByValue.has(modelEntry.defaultReasoningEffort)
        ? modelEntry.defaultReasoningEffort
        : supportedValues[0];

  if (!resolvedCurrent) {
    return null;
  }

  return {
    id: 'reasoning_effort',
    category: 'thought_level',
    name: 'Reasoning Effort',
    type: 'select',
    currentValue: resolvedCurrent,
    options: supportedValues.map((value) => ({
      value,
      name: value,
      ...(supportedByValue.get(value) ? { description: supportedByValue.get(value) } : {}),
    })),
  };
}

function createExecutionModeConfigOption(
  currentPresetId: ExecutionPreset['id'],
  presets: ExecutionPreset[]
): SessionConfigOption {
  return {
    id: 'execution_mode',
    category: 'permission',
    name: 'Execution Mode',
    type: 'select',
    currentValue: currentPresetId,
    options: presets.map((preset) => ({
      value: preset.id,
      name: preset.name,
      ...(preset.description ? { description: preset.description } : {}),
    })),
  };
}

function toExecutionPresetId(approvalPolicy: ApprovalPolicy, sandboxMode: SandboxMode): string {
  return JSON.stringify([approvalPolicy, sandboxMode]);
}

export function resolveDefaultModel(modelCatalog: CodexModelEntry[]): string {
  const preferred = modelCatalog.find((model) => model.isDefault);
  const fallback = modelCatalog[0]?.id;
  if (preferred?.id) {
    return preferred.id;
  }
  if (fallback) {
    return fallback;
  }
  throw new Error('Codex app-server model/list returned no models');
}

export function resolveSessionModel(model: unknown, fallbackModel: string): string {
  return isNonEmptyString(model) ? model : fallbackModel;
}

export function resolveSandboxPolicy(sandbox: unknown, cwd: string): Record<string, unknown> {
  return isRecord(sandbox) ? sandbox : createWorkspaceWriteSandboxPolicy(cwd);
}

export function resolveDefaultCollaborationMode(
  collaborationModes: CollaborationModeEntry[]
): string {
  if (collaborationModes.length === 0) {
    throw new Error('Codex collaborationMode/list returned no modes');
  }
  const preferredDefault = collaborationModes.find((entry) => entry.mode === 'default');
  const firstMode = collaborationModes[0]?.mode;
  if (!firstMode) {
    throw new Error('Codex collaborationMode/list returned an invalid mode entry');
  }
  return preferredDefault?.mode ?? firstMode;
}

export function resolveTurnCollaborationMode(
  collaborationModes: CollaborationModeEntry[],
  session: AdapterSession
): Record<string, unknown> | null {
  const modeEntry = collaborationModes.find(
    (entry) => entry.mode === session.defaults.collaborationMode
  );

  return {
    mode: modeEntry?.mode ?? session.defaults.collaborationMode,
    settings: {
      model: modeEntry?.model ?? session.defaults.model,
      reasoning_effort: modeEntry?.reasoningEffort ?? session.defaults.reasoningEffort,
      developer_instructions: modeEntry?.developerInstructions ?? null,
    },
  };
}

export function resolveReasoningEffortForModel(
  modelCatalog: CodexModelEntry[],
  modelId: string,
  candidateReasoningEffort: unknown
): ReasoningEffort | null {
  const modelEntry = modelCatalog.find((entry) => entry.id === modelId);
  if (!modelEntry) {
    return null;
  }

  const supportedEntries = modelEntry.supportedReasoningEfforts.filter((entry) =>
    isNonEmptyString(entry.reasoningEffort)
  );
  if (supportedEntries.length === 0) {
    return null;
  }

  const supportedValues = dedupeStrings(supportedEntries.map((entry) => entry.reasoningEffort));
  if (
    isNonEmptyString(candidateReasoningEffort) &&
    supportedValues.includes(candidateReasoningEffort)
  ) {
    return candidateReasoningEffort;
  }
  if (supportedValues.includes(modelEntry.defaultReasoningEffort)) {
    return modelEntry.defaultReasoningEffort;
  }
  return supportedValues[0] ?? null;
}

export function getCollaborationModeValues(
  collaborationModes: CollaborationModeEntry[],
  currentMode: string
): string[] {
  const values = collaborationModes
    .map((entry) => entry.mode)
    .filter((mode): mode is string => isNonEmptyString(mode));
  if (!values.includes(currentMode)) {
    values.unshift(currentMode);
  }
  return dedupeStrings(values);
}

export function resolveCurrentSandboxMode(
  allowedSandboxModes: SandboxMode[],
  sandboxPolicy: Record<string, unknown>
): SandboxMode {
  const currentSandboxMode = parseSandboxModeFromPolicy(sandboxPolicy);
  if (currentSandboxMode) {
    return currentSandboxMode;
  }
  const allowedSandboxMode = allowedSandboxModes[0];
  if (allowedSandboxMode) {
    return allowedSandboxMode;
  }
  throw new Error('Unable to resolve current sandbox mode for execution-mode options');
}

export function getExecutionPresets(
  session: AdapterSession,
  allowedApprovalPolicies: ApprovalPolicy[],
  allowedSandboxModes: SandboxMode[]
): ExecutionPreset[] {
  const currentSandboxMode = resolveCurrentSandboxMode(
    allowedSandboxModes,
    session.defaults.sandboxPolicy
  );
  const policies =
    allowedApprovalPolicies.length > 0
      ? allowedApprovalPolicies
      : [session.defaults.approvalPolicy];
  const sandboxModes = allowedSandboxModes.length > 0 ? allowedSandboxModes : [currentSandboxMode];

  const presets: ExecutionPreset[] = [];
  const seen = new Set<string>();
  const addPreset = (
    approvalPolicy: ApprovalPolicy,
    sandboxMode: SandboxMode,
    description?: string
  ): void => {
    const id = toExecutionPresetId(approvalPolicy, sandboxMode);
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    presets.push({
      id,
      name: formatExecutionPresetName(approvalPolicy, sandboxMode),
      ...(description ? { description } : {}),
      approvalPolicy,
      sandboxMode,
    });
  };

  addPreset(
    session.defaults.approvalPolicy,
    currentSandboxMode,
    `Current session: ${formatExecutionPresetName(session.defaults.approvalPolicy, currentSandboxMode)}`
  );
  for (const policy of policies) {
    for (const sandboxMode of sandboxModes) {
      addPreset(policy, sandboxMode);
    }
  }

  return presets;
}

export function resolveExecutionPresetId(
  session: AdapterSession,
  presets: ExecutionPreset[],
  allowedSandboxModes: SandboxMode[]
): ExecutionPreset['id'] {
  const currentSandboxMode = resolveCurrentSandboxMode(
    allowedSandboxModes,
    session.defaults.sandboxPolicy
  );
  const currentPresetId = toExecutionPresetId(session.defaults.approvalPolicy, currentSandboxMode);
  const fallbackPresetId = presets[0]?.id;
  if (!fallbackPresetId) {
    throw new Error('Execution-mode presets are unavailable for this session');
  }
  return presets.some((preset) => preset.id === currentPresetId)
    ? currentPresetId
    : fallbackPresetId;
}

export function buildConfigOptions(
  session: AdapterSession,
  modelCatalog: CodexModelEntry[],
  collaborationModes: CollaborationModeEntry[],
  allowedApprovalPolicies: ApprovalPolicy[],
  allowedSandboxModes: SandboxMode[]
): SessionConfigOption[] {
  const executionPresets = getExecutionPresets(
    session,
    allowedApprovalPolicies,
    allowedSandboxModes
  );
  const currentExecutionPreset = resolveExecutionPresetId(
    session,
    executionPresets,
    allowedSandboxModes
  );
  const configOptions: SessionConfigOption[] = [
    createModelConfigOption(session.defaults.model, modelCatalog),
    createCollaborationModeConfigOption(session.defaults.collaborationMode, collaborationModes),
    createExecutionModeConfigOption(currentExecutionPreset, executionPresets),
  ];

  const reasoningOption = createReasoningEffortConfigOption(
    session.defaults.reasoningEffort,
    modelCatalog,
    session.defaults.model
  );
  if (reasoningOption) {
    configOptions.push(reasoningOption);
  }

  return configOptions;
}

export function isKnownModel(modelCatalog: CodexModelEntry[], modelId: string): boolean {
  return modelCatalog.some((model) => model.id === modelId);
}

export function isReasoningEffortSupportedForModel(
  modelCatalog: CodexModelEntry[],
  modelId: string,
  reasoningEffort: string
): boolean {
  const modelEntry = modelCatalog.find((model) => model.id === modelId);
  if (!modelEntry) {
    return false;
  }

  return modelEntry.supportedReasoningEfforts
    .map((entry) => entry.reasoningEffort)
    .filter((effort): effort is string => isNonEmptyString(effort))
    .includes(reasoningEffort);
}

export function resolveCollaborationModeLabel(
  collaborationModes: CollaborationModeEntry[],
  modeId: string
): string {
  const entry = collaborationModes.find((candidate) => candidate.mode === modeId);
  if (entry?.name) {
    return entry.name;
  }
  return sanitizeModeName(modeId);
}
