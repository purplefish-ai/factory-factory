import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
import { MapTrifoldIcon } from '@phosphor-icons/react/dist/csr/MapTrifold';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
import { SquareIcon } from '@phosphor-icons/react/dist/csr/Square';
import { memo, useMemo, useState } from 'react';
import { getConfigPresentation } from '@/client/components/acp-config-presentation';
import { AcpConfigSelector } from '@/client/components/acp-config-selector';
import { getRuntimeControlVisibility } from '@/client/features/chat/chat-input/runtime-control-visibility';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import { AttachmentPreview } from '@/client/features/composer';
import { ProviderModelPicker } from '@/client/features/session-selection';
import { ShortcutKeys } from '@/client/features/shortcuts';
import { formatShortcut } from '@/client/lib/keyboard-shortcuts';
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
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import type { ChatSettings, MessageAttachment } from '@/lib/chat-protocol';
import {
  type ChatBarCapabilities,
  type ChatModelOption,
  hasResolvedChatBarCapabilities,
} from '@/shared/chat-capabilities';
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
    <div className="shrink-0 px-3 pt-2 pb-1">
      <AttachmentPreview attachments={attachments} onRemove={onRemove} />
    </div>
  );
});

const FileUploadButton = memo(function FileUploadButton({
  fileInputRef,
  onFileSelect,
  supportedImageTypes,
  disabled,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  supportedImageTypes: readonly string[];
  disabled: boolean;
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
              disabled={disabled}
              className="h-6 w-6 p-0"
              aria-label="Upload image"
            >
              <ImageIcon className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="flex items-center gap-2">
              Upload image
              <ShortcutKeys id="composer.attachImage" />
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

export interface LeftControlsProps {
  settings?: ChatSettings;
  capabilities?: ChatBarCapabilities;
  capabilitiesLoaded?: boolean;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: string) => void;
  onThinkingChange: (enabled: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  running: boolean;
  stopping?: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  supportedImageTypes: readonly string[];
  disabled: boolean;
  onQuickAction: (action: string) => void;
  /** Lets quick actions start a new chat; omit where only this chat applies. */
  onRunQuickActionInNewChat?: (name: string, prompt: string) => void;
  newChatUnavailableReason?: string | null;
  quickActionsOpen: boolean;
  onQuickActionsOpenChange: (open: boolean) => void;
  acpConfigOptions?: AcpConfigOption[] | null;
  onSetConfigOption?: (configId: string, value: string) => void;
}

type RuntimeControlsInput = Pick<
  LeftControlsProps,
  | 'capabilities'
  | 'capabilitiesLoaded'
  | 'settings'
  | 'acpConfigOptions'
  | 'onSetConfigOption'
  | 'onModelChange'
>;

function getRuntimeControls(props: RuntimeControlsInput) {
  const { capabilities, settings, onSetConfigOption } = props;
  const { modelOption, nativeOptions, showReasoning, showThinking, showPlanning } =
    getRuntimeControlVisibility(props);
  const modelOptions: ChatModelOption[] = modelOption
    ? modelOption.options.flatMap((entry) =>
        'group' in entry
          ? entry.options.map((option) => ({ value: option.value, label: option.name }))
          : [{ value: entry.value, label: entry.name }]
      )
    : (capabilities?.model.options ?? []);
  const loaded = props.capabilitiesLoaded ?? hasResolvedChatBarCapabilities(capabilities);
  const loading = !loaded;
  const model =
    settings?.selectedModel ?? modelOption?.currentValue ?? capabilities?.model.selected;
  return {
    nativeOptions,
    modelOptions,
    model,
    updating: Boolean(modelOption && model !== modelOption.currentValue),
    provider: loaded ? (capabilities?.provider ?? null) : null,
    loading,
    modelEditable: modelOption ? Boolean(onSetConfigOption) : capabilities?.model.enabled === true,
    onModelChange:
      modelOption && onSetConfigOption
        ? (value: string) => onSetConfigOption(modelOption.id, value)
        : props.onModelChange,
    showReasoning,
    showThinking,
    showPlanning,
  };
}

type RuntimeControls = ReturnType<typeof getRuntimeControls>;

/** Recomputes the controls only when their inputs change, so memoized children can skip renders. */
function useRuntimeControls({
  capabilities,
  capabilitiesLoaded,
  settings,
  acpConfigOptions,
  onSetConfigOption,
  onModelChange,
}: RuntimeControlsInput): RuntimeControls {
  return useMemo(
    () =>
      getRuntimeControls({
        capabilities,
        capabilitiesLoaded,
        settings,
        acpConfigOptions,
        onSetConfigOption,
        onModelChange,
      }),
    [capabilities, capabilitiesLoaded, settings, acpConfigOptions, onSetConfigOption, onModelChange]
  );
}

/** Passed as individual props so the memoized options skip renders that change none of them. */
interface RuntimeOptionsProps extends Pick<
  LeftControlsProps,
  | 'capabilities'
  | 'settings'
  | 'onSetConfigOption'
  | 'onReasoningChange'
  | 'onThinkingChange'
  | 'onPlanModeChange'
> {
  controls: RuntimeControls;
  disabled?: boolean;
}

const RuntimeOptions = memo(function RuntimeOptions({
  controls,
  capabilities,
  settings,
  onSetConfigOption,
  onReasoningChange,
  onThinkingChange,
  onPlanModeChange,
  disabled,
  mobile = false,
}: RuntimeOptionsProps & { mobile?: boolean }) {
  const row = (label: string, control: React.ReactNode) =>
    mobile ? (
      <div className="flex items-center justify-between gap-2 rounded-md border p-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        {control}
      </div>
    ) : (
      control
    );
  return (
    <>
      {controls.nativeOptions.map((option) => (
        <div key={option.id}>
          {onSetConfigOption &&
            row(
              getConfigPresentation(option).label,
              <AcpConfigSelector
                configOption={option}
                onSelect={onSetConfigOption}
                disabled={disabled}
                compact={!mobile}
              />
            )}
        </div>
      ))}
      {controls.showReasoning &&
        row(
          'Reasoning',
          <ModelSelector
            selectedModel={settings?.reasoningEffort ?? capabilities?.reasoning.selected ?? ''}
            options={capabilities?.reasoning.options ?? []}
            onChange={onReasoningChange}
            disabled={disabled}
          />
        )}
      {controls.showThinking &&
        row(
          'Extended thinking',
          <SettingsToggle
            pressed={settings?.thinkingEnabled ?? false}
            onPressedChange={onThinkingChange}
            disabled={disabled}
            icon={BrainIcon}
            label="Extended thinking mode"
            ariaLabel="Toggle thinking mode"
            shortcutId="composer.toggleThinking"
          />
        )}
      {controls.showPlanning &&
        row(
          'Planning mode',
          <SettingsToggle
            pressed={settings?.planModeEnabled ?? false}
            onPressedChange={onPlanModeChange}
            disabled={disabled}
            icon={MapTrifoldIcon}
            label="Planning mode"
            ariaLabel="Toggle planning mode"
            shortcutId="composer.togglePlanMode"
          />
        )}
    </>
  );
});

const MobileSettingsSheet = memo(function MobileSettingsSheet(props: RuntimeOptionsProps) {
  const { controls } = props;
  const [open, setOpen] = useState(false);
  if (
    !(
      controls.nativeOptions.length ||
      controls.showReasoning ||
      controls.showThinking ||
      controls.showPlanning
    )
  ) {
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
          <SlidersHorizontalIcon className="h-3.5 w-3.5" />
          <span className="@max-[22rem]/composer:sr-only">Options</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-[80dvh] overflow-y-auto"
        data-testid="chat-options-sheet"
      >
        <SheetHeader>
          <SheetTitle>Chat options</SheetTitle>
          <SheetDescription>Settings apply to the next turn.</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 py-4">
          <RuntimeOptions {...props} mobile />
        </div>
      </SheetContent>
    </Sheet>
  );
});

function getModelDisabledReason(props: LeftControlsProps, controls: RuntimeControls) {
  if (props.stopping) {
    return 'Wait for the agent to stop before changing models';
  }
  if (props.disabled) {
    return 'Model selection is unavailable while the session is disconnected or starting';
  }
  if (controls.loading) {
    return 'Loading model options';
  }
  if (!controls.modelEditable) {
    return 'This session does not support model changes';
  }
  return undefined;
}

export const LeftControls = memo(function LeftControls(props: LeftControlsProps) {
  const isMobile = useIsMobile();
  const controls = useRuntimeControls(props);
  const disabledReason = getModelDisabledReason(props, controls);
  const runtimeOptions: RuntimeOptionsProps = {
    controls,
    capabilities: props.capabilities,
    settings: props.settings,
    onSetConfigOption: props.onSetConfigOption,
    onReasoningChange: props.onReasoningChange,
    onThinkingChange: props.onThinkingChange,
    onPlanModeChange: props.onPlanModeChange,
    disabled: props.disabled || props.stopping,
  };
  const showAttachments =
    props.capabilities?.attachments.enabled === true &&
    props.capabilities.attachments.kinds.includes('image');

  return (
    <div className="flex min-w-0 flex-1 basis-auto items-center gap-1 pr-1">
      <ProviderModelPicker
        provider={controls.provider}
        model={controls.model}
        models={controls.modelOptions}
        onModelChange={controls.onModelChange}
        loading={controls.loading}
        updating={!controls.loading && controls.updating}
        disabled={Boolean(props.disabled || props.stopping || !controls.modelEditable)}
        disabledReason={disabledReason}
      />
      {isMobile ? (
        <MobileSettingsSheet {...runtimeOptions} />
      ) : (
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide">
          <RuntimeOptions {...runtimeOptions} />
        </div>
      )}
      {showAttachments && (
        <FileUploadButton
          fileInputRef={props.fileInputRef}
          onFileSelect={props.onFileSelect}
          supportedImageTypes={props.supportedImageTypes}
          disabled={props.disabled}
        />
      )}
      <QuickActionsDropdown
        onRunInThisChat={props.onQuickAction}
        thisChatDisabled={props.disabled}
        onRunInNewChat={props.onRunQuickActionInNewChat}
        newChatUnavailableReason={props.newChatUnavailableReason}
        open={props.quickActionsOpen}
        onOpenChange={props.onQuickActionsOpenChange}
      />
    </div>
  );
});

export const RightControls = memo(function RightControls({
  pendingMessageCount,
  running,
  promptInFlight = running,
  stopping,
  onStop,
  onSendClick,
  disabled,
  inputRef,
  children,
}: {
  children?: React.ReactNode;
  pendingMessageCount: number;
  running: boolean;
  promptInFlight?: boolean;
  stopping: boolean;
  onStop?: () => void;
  onSendClick: (ref: React.RefObject<HTMLTextAreaElement | null>) => void;
  disabled: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {children}
      {pendingMessageCount > 0 && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Spinner aria-hidden="true" className="h-3 w-3" />
          <span className="@max-[22rem]/composer:sr-only">Sending…</span>
        </div>
      )}
      {running && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onStop}
                  disabled={stopping}
                  className="h-7 w-7"
                  aria-label={stopping ? 'Stopping…' : 'Stop agent'}
                >
                  {stopping ? (
                    <Spinner aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <SquareIcon className="h-3 w-3" weight="fill" />
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Stop agent ({formatShortcut('composer.stop')})</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <InputGroupButton
        onClick={() => onSendClick(inputRef)}
        disabled={disabled}
        size="icon-sm"
        className="size-7"
        variant="default"
        aria-label={promptInFlight ? 'Queue message' : 'Send message'}
      >
        <PaperPlaneTiltIcon className="h-4 w-4" />
      </InputGroupButton>
    </div>
  );
});
