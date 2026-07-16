import {
  Brain,
  Image,
  MapTrifold,
  PaperPlaneTilt,
  SlidersHorizontal,
  SpinnerGap,
  Square,
} from '@phosphor-icons/react';
import { memo, useState } from 'react';
import { AttachmentPreview } from '@/components/chat/attachment-preview';
import type { AcpConfigOption } from '@/components/chat/reducer';
import { ContextWindowIndicator } from '@/components/chat/usage-stats';
import { Button } from '@/components/ui/button';
import { InputGroupButton } from '@/components/ui/input-group';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ChatSettings, MessageAttachment, TokenStats } from '@/lib/chat-protocol';
import {
  type ChatBarCapabilities,
  hasResolvedChatBarCapabilities,
} from '@/shared/chat-capabilities';
import { AcpConfigSelector } from './acp-config-selector';
import { ModelSelector } from './model-selector';
import { QuickActionsDropdown } from './quick-actions-dropdown';
import { SettingsToggle } from './settings-toggle';

export const AttachmentSection = memo(function AttachmentSection({
  attachments,
  onRemove,
}: {
  attachments: MessageAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="px-3 pt-2 pb-1">
      <AttachmentPreview attachments={attachments} onRemove={onRemove} />
    </div>
  );
});

const FileUploadButton = memo(function FileUploadButton({
  fileInputRef,
  onFileSelect,
  supportedImageTypes,
  running,
  disabled,
  modLabel,
  modifierHeld,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  supportedImageTypes: readonly string[];
  running: boolean;
  disabled: boolean;
  modLabel: string;
  modifierHeld: boolean;
}) {
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={running || disabled}
              className="h-6 w-6 p-0"
              aria-label="Upload image"
            >
              <Image className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>
              Upload image
              {modifierHeld ? ` (${modLabel}+Shift+U)` : ''}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <input
        ref={fileInputRef}
        type="file"
        accept={supportedImageTypes.join(',')}
        multiple
        onChange={onFileSelect}
        className="hidden"
        aria-label="File upload input"
      />
    </>
  );
});

interface LeftControlsVisibility {
  provider: ChatBarCapabilities['provider'] | null;
  selectedModel: string;
  selectedReasoningEffort: string;
  showModelSelector: boolean;
  showReasoningSelector: boolean;
  showThinkingToggle: boolean;
  showPlanModeToggle: boolean;
  showAttachments: boolean;
  showUsageIndicator: boolean;
}

function deriveLeftControlsVisibility(
  settings: ChatSettings | undefined,
  capabilities: ChatBarCapabilities | undefined,
  tokenStats: TokenStats | undefined
): LeftControlsVisibility {
  const showModelSelector =
    capabilities?.model.enabled === true && (capabilities.model.options.length ?? 0) > 0;
  const showReasoningSelector =
    capabilities?.reasoning.enabled === true && (capabilities.reasoning.options.length ?? 0) > 0;
  const showThinkingToggle = capabilities?.thinking.enabled === true;
  const showPlanModeToggle = capabilities?.planMode.enabled === true;
  const showAttachments =
    capabilities?.attachments.enabled === true && capabilities.attachments.kinds.includes('image');
  const showUsageIndicator =
    capabilities?.usageStats.enabled === true &&
    capabilities.usageStats.contextWindow === true &&
    tokenStats !== undefined;
  const selectedModel =
    settings?.selectedModel ??
    capabilities?.model.selected ??
    capabilities?.model.options[0]?.value ??
    '';
  const selectedReasoningEffort =
    settings?.reasoningEffort ??
    capabilities?.reasoning.selected ??
    capabilities?.reasoning.options[0]?.value ??
    '';
  const provider = hasResolvedChatBarCapabilities(capabilities) ? capabilities.provider : null;

  return {
    provider,
    selectedModel,
    selectedReasoningEffort,
    showModelSelector,
    showReasoningSelector,
    showThinkingToggle,
    showPlanModeToggle,
    showAttachments,
    showUsageIndicator,
  };
}

function getProviderLogo(provider: ChatBarCapabilities['provider'] | null): {
  light: string;
  dark: string;
  alt: string;
} {
  if (provider === 'CODEX') {
    return {
      light: `${import.meta.env.BASE_URL}logos/codex-light.svg`,
      dark: `${import.meta.env.BASE_URL}logos/codex-dark.svg`,
      alt: 'Codex',
    };
  }
  return {
    light: `${import.meta.env.BASE_URL}logos/claude-light.svg`,
    dark: `${import.meta.env.BASE_URL}logos/claude-dark.svg`,
    alt: 'Claude',
  };
}

const ProviderIndicator = memo(function ProviderIndicator({
  provider,
}: {
  provider: ChatBarCapabilities['provider'] | null;
}) {
  if (!provider) {
    return null;
  }
  const logo = getProviderLogo(provider);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground">
            <img src={logo.light} alt={logo.alt} className="h-3.5 w-3.5 shrink-0 dark:hidden" />
            <img
              src={logo.dark}
              alt={logo.alt}
              className="hidden h-3.5 w-3.5 shrink-0 dark:block"
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{logo.alt}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

const ModeToggles = memo(function ModeToggles({
  showThinkingToggle,
  showPlanModeToggle,
  settings,
  onThinkingChange,
  onPlanModeChange,
  running,
  modLabel,
  modifierHeld,
}: {
  showThinkingToggle: boolean;
  showPlanModeToggle: boolean;
  settings?: ChatSettings;
  onThinkingChange: (enabled: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  running: boolean;
  modLabel: string;
  modifierHeld: boolean;
}) {
  if (!(showThinkingToggle || showPlanModeToggle)) {
    return null;
  }

  return (
    <>
      {showThinkingToggle && (
        <SettingsToggle
          pressed={settings?.thinkingEnabled ?? false}
          onPressedChange={onThinkingChange}
          disabled={running}
          icon={Brain}
          label="Extended thinking mode"
          ariaLabel="Toggle thinking mode"
          shortcut={`${modLabel}+Shift+T`}
          showShortcut={modifierHeld}
        />
      )}
      {showPlanModeToggle && (
        <SettingsToggle
          pressed={settings?.planModeEnabled ?? false}
          onPressedChange={onPlanModeChange}
          disabled={running}
          icon={MapTrifold}
          label="Planning mode"
          ariaLabel="Toggle planning mode"
          shortcut={`${modLabel}+Shift+P`}
          showShortcut={modifierHeld}
        />
      )}
    </>
  );
});

const UsageIndicatorSection = memo(function UsageIndicatorSection({
  showUsageIndicator,
  tokenStats,
}: {
  showUsageIndicator: boolean;
  tokenStats?: TokenStats;
}) {
  if (!(showUsageIndicator && tokenStats)) {
    return null;
  }

  return (
    <>
      <div className="h-4 w-px bg-border" />
      <ContextWindowIndicator tokenStats={tokenStats} />
    </>
  );
});

const AcpConfigControls = memo(function AcpConfigControls({
  acpConfigOptions,
  onSetConfigOption,
  running,
}: {
  acpConfigOptions: AcpConfigOption[];
  onSetConfigOption: (configId: string, value: string) => void;
  running: boolean;
}) {
  return (
    <>
      {acpConfigOptions.map((option, idx) => (
        <div key={option.id} className="flex items-center gap-1">
          {idx > 0 && <div className="h-4 w-px bg-border" />}
          <AcpConfigSelector
            configOption={option}
            onSelect={onSetConfigOption}
            disabled={running}
          />
        </div>
      ))}
    </>
  );
});

const MobileSettingsSheet = memo(function MobileSettingsSheet({
  running,
  showModelSelector,
  selectedModel,
  modelOptions,
  onModelChange,
  showReasoningSelector,
  selectedReasoningEffort,
  reasoningOptions,
  onReasoningChange,
  showThinkingToggle,
  showPlanModeToggle,
  settings,
  onThinkingChange,
  onPlanModeChange,
  hasAcpConfigOptions,
  acpConfigOptions,
  onSetConfigOption,
  showUsageIndicator,
  tokenStats,
}: {
  running: boolean;
  showModelSelector: boolean;
  selectedModel: string;
  modelOptions: ChatBarCapabilities['model']['options'];
  onModelChange: (model: string) => void;
  showReasoningSelector: boolean;
  selectedReasoningEffort: string;
  reasoningOptions: ChatBarCapabilities['reasoning']['options'];
  onReasoningChange: (effort: string) => void;
  showThinkingToggle: boolean;
  showPlanModeToggle: boolean;
  settings?: ChatSettings;
  onThinkingChange: (enabled: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  hasAcpConfigOptions: boolean;
  acpConfigOptions?: AcpConfigOption[] | null;
  onSetConfigOption?: (configId: string, value: string) => void;
  showUsageIndicator: boolean;
  tokenStats?: TokenStats;
}) {
  const [open, setOpen] = useState(false);
  const hasAnyControls =
    hasAcpConfigOptions ||
    showModelSelector ||
    showReasoningSelector ||
    showThinkingToggle ||
    showPlanModeToggle ||
    showUsageIndicator;

  if (!hasAnyControls) {
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Open chat options"
          data-testid="chat-options-trigger"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span className="max-[359px]:sr-only">Options</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-[80dvh] overflow-y-auto"
        data-testid="chat-options-sheet"
      >
        <SheetHeader>
          <SheetTitle>Chat Options</SheetTitle>
          <SheetDescription>Adjust model and runtime settings for this message.</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 py-4">
          {hasAcpConfigOptions && onSetConfigOption ? (
            acpConfigOptions?.map((option) => (
              <div
                key={option.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2"
              >
                <span className="text-sm text-muted-foreground">{option.name}</span>
                <AcpConfigSelector
                  configOption={option}
                  onSelect={onSetConfigOption}
                  disabled={running}
                />
              </div>
            ))
          ) : (
            <>
              {showModelSelector && (
                <div className="flex items-center justify-between gap-2 rounded-md border p-2">
                  <span className="text-sm text-muted-foreground">Model</span>
                  <ModelSelector
                    selectedModel={selectedModel}
                    options={modelOptions}
                    onChange={onModelChange}
                    disabled={running}
                  />
                </div>
              )}
              {showReasoningSelector && (
                <div className="flex items-center justify-between gap-2 rounded-md border p-2">
                  <span className="text-sm text-muted-foreground">Reasoning</span>
                  <ModelSelector
                    selectedModel={selectedReasoningEffort}
                    options={reasoningOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    onChange={onReasoningChange}
                    disabled={running}
                  />
                </div>
              )}
              {showThinkingToggle && (
                <div className="flex items-center justify-between gap-2 rounded-md border p-2">
                  <span className="text-sm text-muted-foreground">Extended thinking</span>
                  <SettingsToggle
                    pressed={settings?.thinkingEnabled ?? false}
                    onPressedChange={onThinkingChange}
                    disabled={running}
                    icon={Brain}
                    label="Extended thinking mode"
                    ariaLabel="Toggle thinking mode"
                  />
                </div>
              )}
              {showPlanModeToggle && (
                <div className="flex items-center justify-between gap-2 rounded-md border p-2">
                  <span className="text-sm text-muted-foreground">Planning mode</span>
                  <SettingsToggle
                    pressed={settings?.planModeEnabled ?? false}
                    onPressedChange={onPlanModeChange}
                    disabled={running}
                    icon={MapTrifold}
                    label="Planning mode"
                    ariaLabel="Toggle planning mode"
                  />
                </div>
              )}
            </>
          )}
          {showUsageIndicator && tokenStats && (
            <div className="rounded-md border p-2">
              <ContextWindowIndicator tokenStats={tokenStats} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
});

interface LeftControlsProps {
  settings?: ChatSettings;
  capabilities?: ChatBarCapabilities;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: string) => void;
  onThinkingChange: (enabled: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  running: boolean;
  modLabel: string;
  modifierHeld: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  supportedImageTypes: readonly string[];
  disabled: boolean;
  onQuickAction: (action: string) => void;
  quickActionsOpen: boolean;
  onQuickActionsOpenChange: (open: boolean) => void;
  tokenStats?: TokenStats;
  acpConfigOptions?: AcpConfigOption[] | null;
  onSetConfigOption?: (configId: string, value: string) => void;
}

interface LeftControlsViewState {
  provider: ChatBarCapabilities['provider'] | null;
  selectedModel: string;
  selectedReasoningEffort: string;
  showModelSelector: boolean;
  showReasoningSelector: boolean;
  showThinkingToggle: boolean;
  showPlanModeToggle: boolean;
  showAttachments: boolean;
  showUsageIndicator: boolean;
  hasModeToggles: boolean;
  hasAcpConfigOptions: boolean;
}

const MobileLeftControls = memo(function MobileLeftControls({
  props,
  view,
}: {
  props: LeftControlsProps;
  view: LeftControlsViewState;
}) {
  const {
    settings,
    capabilities,
    onModelChange,
    onReasoningChange,
    onThinkingChange,
    onPlanModeChange,
    running,
    modLabel,
    modifierHeld,
    fileInputRef,
    onFileSelect,
    supportedImageTypes,
    disabled,
    onQuickAction,
    quickActionsOpen,
    onQuickActionsOpenChange,
    tokenStats,
    acpConfigOptions,
    onSetConfigOption,
  } = props;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 pr-1">
      <ProviderIndicator provider={view.provider} />
      <MobileSettingsSheet
        running={running}
        showModelSelector={view.showModelSelector}
        selectedModel={view.selectedModel}
        modelOptions={capabilities?.model.options ?? []}
        onModelChange={onModelChange}
        showReasoningSelector={view.showReasoningSelector}
        selectedReasoningEffort={view.selectedReasoningEffort}
        reasoningOptions={capabilities?.reasoning.options ?? []}
        onReasoningChange={onReasoningChange}
        showThinkingToggle={view.showThinkingToggle}
        showPlanModeToggle={view.showPlanModeToggle}
        settings={settings}
        onThinkingChange={onThinkingChange}
        onPlanModeChange={onPlanModeChange}
        hasAcpConfigOptions={view.hasAcpConfigOptions}
        acpConfigOptions={acpConfigOptions}
        onSetConfigOption={onSetConfigOption}
        showUsageIndicator={view.showUsageIndicator}
        tokenStats={tokenStats}
      />
      {view.showAttachments && (
        <FileUploadButton
          fileInputRef={fileInputRef}
          onFileSelect={onFileSelect}
          supportedImageTypes={supportedImageTypes}
          running={running}
          disabled={disabled}
          modLabel={modLabel}
          modifierHeld={modifierHeld}
        />
      )}
      <QuickActionsDropdown
        onAction={onQuickAction}
        disabled={disabled}
        open={quickActionsOpen}
        onOpenChange={onQuickActionsOpenChange}
        shortcut={`${modLabel}+Shift+A`}
        showShortcut={modifierHeld}
      />
    </div>
  );
});

const DesktopLeftControls = memo(function DesktopLeftControls({
  props,
  view,
}: {
  props: LeftControlsProps;
  view: LeftControlsViewState;
}) {
  const {
    settings,
    capabilities,
    onModelChange,
    onReasoningChange,
    onThinkingChange,
    onPlanModeChange,
    running,
    modLabel,
    modifierHeld,
    fileInputRef,
    onFileSelect,
    supportedImageTypes,
    disabled,
    onQuickAction,
    quickActionsOpen,
    onQuickActionsOpenChange,
    tokenStats,
    acpConfigOptions,
    onSetConfigOption,
  } = props;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1 scrollbar-hide">
      <ProviderIndicator provider={view.provider} />
      {view.hasAcpConfigOptions && acpConfigOptions && onSetConfigOption ? (
        <>
          <div className="h-4 w-px bg-border" />
          <AcpConfigControls
            acpConfigOptions={acpConfigOptions}
            onSetConfigOption={onSetConfigOption}
            running={running}
          />
        </>
      ) : (
        <>
          {(view.showModelSelector || view.showReasoningSelector || view.hasModeToggles) && (
            <div className="h-4 w-px bg-border" />
          )}
          {view.showModelSelector && (
            <ModelSelector
              selectedModel={view.selectedModel}
              options={capabilities?.model.options ?? []}
              onChange={onModelChange}
              disabled={running}
            />
          )}
          {view.showModelSelector && view.showReasoningSelector && (
            <div className="h-4 w-px bg-border" />
          )}
          {view.showReasoningSelector && (
            <ModelSelector
              selectedModel={view.selectedReasoningEffort}
              options={(capabilities?.reasoning.options ?? []).map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={onReasoningChange}
              disabled={running}
            />
          )}
          {(view.showModelSelector || view.showReasoningSelector) && view.hasModeToggles && (
            <div className="h-4 w-px bg-border" />
          )}
          <ModeToggles
            showThinkingToggle={view.showThinkingToggle}
            showPlanModeToggle={view.showPlanModeToggle}
            settings={settings}
            onThinkingChange={onThinkingChange}
            onPlanModeChange={onPlanModeChange}
            running={running}
            modLabel={modLabel}
            modifierHeld={modifierHeld}
          />
          {view.hasModeToggles && view.showAttachments && <div className="h-4 w-px bg-border" />}
          {view.showAttachments && (
            <FileUploadButton
              fileInputRef={fileInputRef}
              onFileSelect={onFileSelect}
              supportedImageTypes={supportedImageTypes}
              running={running}
              disabled={disabled}
              modLabel={modLabel}
              modifierHeld={modifierHeld}
            />
          )}
        </>
      )}
      <QuickActionsDropdown
        onAction={onQuickAction}
        disabled={disabled}
        open={quickActionsOpen}
        onOpenChange={onQuickActionsOpenChange}
        shortcut={`${modLabel}+Shift+A`}
        showShortcut={modifierHeld}
      />
      <UsageIndicatorSection showUsageIndicator={view.showUsageIndicator} tokenStats={tokenStats} />
    </div>
  );
});

export const LeftControls = memo(function LeftControls(props: LeftControlsProps) {
  const isMobile = useIsMobile();
  const view = deriveLeftControlsVisibility(props.settings, props.capabilities, props.tokenStats);
  const viewState: LeftControlsViewState = {
    ...view,
    hasModeToggles: view.showThinkingToggle || view.showPlanModeToggle,
    hasAcpConfigOptions:
      props.acpConfigOptions != null &&
      props.acpConfigOptions.length > 0 &&
      props.onSetConfigOption != null,
  };

  if (isMobile) {
    return <MobileLeftControls props={props} view={viewState} />;
  }

  return <DesktopLeftControls props={props} view={viewState} />;
});

export const RightControls = memo(function RightControls({
  pendingMessageCount,
  running,
  stopping,
  onStop,
  onSendClick,
  disabled,
  inputRef,
}: {
  pendingMessageCount: number;
  running: boolean;
  stopping: boolean;
  onStop?: () => void;
  onSendClick: (ref: React.RefObject<HTMLTextAreaElement | null>) => void;
  disabled: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {pendingMessageCount > 0 && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <SpinnerGap className="h-3 w-3 animate-spin" />
          <span>Sending...</span>
        </div>
      )}
      {running && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onStop}
          disabled={stopping}
          className="h-7 w-7"
          aria-label={stopping ? 'Stopping...' : 'Stop agent'}
        >
          {stopping ? (
            <SpinnerGap className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Square className="h-3 w-3 fill-current" />
          )}
        </Button>
      )}
      <InputGroupButton
        onClick={() => onSendClick(inputRef)}
        disabled={disabled}
        size="icon-sm"
        aria-label={running ? 'Queue message' : 'Send message'}
      >
        <PaperPlaneTilt className="h-4 w-4" />
      </InputGroupButton>
    </div>
  );
});
