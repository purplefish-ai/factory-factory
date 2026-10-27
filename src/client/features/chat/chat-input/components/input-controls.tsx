import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
import { MapTrifoldIcon } from '@phosphor-icons/react/dist/csr/MapTrifold';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { SquareIcon } from '@phosphor-icons/react/dist/csr/Square';
import { memo, useState } from 'react';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
import { AttachmentPreview } from '@/client/features/composer';
import { ProviderModelPicker } from '@/client/features/session-selection';
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
import type { ChatSettings, MessageAttachment } from '@/lib/chat-protocol';
import { type ChatBarCapabilities, type ChatModelOption } from '@/shared/chat-capabilities';
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
              <ImageIcon className="h-3.5 w-3.5" />
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
  modLabel: string;
  modifierHeld: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  supportedImageTypes: readonly string[];
  disabled: boolean;
  onQuickAction: (action: string) => void;
  quickActionsOpen: boolean;
  onQuickActionsOpenChange: (open: boolean) => void;
  acpConfigOptions?: AcpConfigOption[] | null;
  onSetConfigOption?: (configId: string, value: string) => void;
}

function getRuntimeControls(props: LeftControlsProps) {
  const { capabilities, settings, acpConfigOptions, onSetConfigOption } = props;
  const modelOption = acpConfigOptions?.find(
    (option) => option.category === 'model' || option.id === 'model'
  );
  const nativeOptions = onSetConfigOption
    ? (acpConfigOptions ?? []).filter((option) => option !== modelOption)
    : [];
  const hasNative = (...ids: string[]) =>
    nativeOptions.some((option) => ids.includes(option.id) || ids.includes(option.category ?? ''));
  const modelOptions: ChatModelOption[] = modelOption
    ? modelOption.options.flatMap((entry) =>
        'group' in entry
          ? entry.options.map((option) => ({ value: option.value, label: option.name }))
          : [{ value: entry.value, label: entry.name }]
      )
    : (capabilities?.model.options ?? []);
  const loaded = props.capabilitiesLoaded ?? capabilities !== undefined;
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
    showReasoning:
      capabilities?.reasoning.enabled === true &&
      capabilities.reasoning.options.length > 0 &&
      !hasNative('reasoning', 'reasoning_effort'),
    showThinking: capabilities?.thinking.enabled === true && !hasNative('thinking'),
    showPlanning:
      capabilities?.planMode.enabled === true && !hasNative('collaboration_mode', 'plan_mode'),
  };
}

type RuntimeControls = ReturnType<typeof getRuntimeControls>;

const RuntimeOptions = memo(function RuntimeOptions({
  props,
  controls,
  mobile = false,
}: {
  props: LeftControlsProps;
  controls: RuntimeControls;
  mobile?: boolean;
}) {
  const { capabilities, settings, onSetConfigOption } = props;
  const disabled = props.disabled || props.running || props.stopping;
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
              option.name,
              <AcpConfigSelector
                configOption={option}
                onSelect={onSetConfigOption}
                disabled={disabled}
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
            onChange={props.onReasoningChange}
            disabled={disabled}
          />
        )}
      {controls.showThinking &&
        row(
          'Extended thinking',
          <SettingsToggle
            pressed={settings?.thinkingEnabled ?? false}
            onPressedChange={props.onThinkingChange}
            disabled={disabled}
            icon={BrainIcon}
            label="Extended thinking mode"
            ariaLabel="Toggle thinking mode"
            shortcut={`${props.modLabel}+Shift+T`}
            showShortcut={props.modifierHeld}
          />
        )}
      {controls.showPlanning &&
        row(
          'Planning mode',
          <SettingsToggle
            pressed={settings?.planModeEnabled ?? false}
            onPressedChange={props.onPlanModeChange}
            disabled={disabled}
            icon={MapTrifoldIcon}
            label="Planning mode"
            ariaLabel="Toggle planning mode"
            shortcut={`${props.modLabel}+Shift+P`}
            showShortcut={props.modifierHeld}
          />
        )}
    </>
  );
});

const MobileSettingsSheet = memo(function MobileSettingsSheet({
  props,
  controls,
}: {
  props: LeftControlsProps;
  controls: RuntimeControls;
}) {
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
          <SheetDescription>Adjust runtime settings for this conversation.</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 py-4">
          <RuntimeOptions props={props} controls={controls} mobile />
        </div>
      </SheetContent>
    </Sheet>
  );
});

function getModelDisabledReason(props: LeftControlsProps, controls: RuntimeControls) {
  if (props.running || props.stopping) {
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
  const controls = getRuntimeControls(props);
  const busy = props.running || props.stopping;
  const disabledReason = getModelDisabledReason(props, controls);
  const showAttachments =
    props.capabilities?.attachments.enabled === true &&
    props.capabilities.attachments.kinds.includes('image');

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 pr-1">
      <ProviderModelPicker
        provider={controls.provider}
        model={controls.model}
        models={controls.modelOptions}
        onModelChange={controls.onModelChange}
        loading={controls.loading}
        updating={!controls.loading && controls.updating}
        disabled={Boolean(props.disabled || busy || !controls.modelEditable)}
        disabledReason={disabledReason}
      />
      {isMobile ? (
        <MobileSettingsSheet props={props} controls={controls} />
      ) : (
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide">
          <RuntimeOptions props={props} controls={controls} />
        </div>
      )}
      {showAttachments && (
        <FileUploadButton
          fileInputRef={props.fileInputRef}
          onFileSelect={props.onFileSelect}
          supportedImageTypes={props.supportedImageTypes}
          running={Boolean(busy)}
          disabled={props.disabled}
          modLabel={props.modLabel}
          modifierHeld={props.modifierHeld}
        />
      )}
      <QuickActionsDropdown
        onAction={props.onQuickAction}
        disabled={props.disabled}
        open={props.quickActionsOpen}
        onOpenChange={props.onQuickActionsOpenChange}
        shortcut={`${props.modLabel}+Shift+A`}
        showShortcut={props.modifierHeld}
      />
    </div>
  );
});

export const RightControls = memo(function RightControls({
  pendingMessageCount,
  running,
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
          <SpinnerGapIcon className="h-3 w-3 animate-spin" />
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
            <SpinnerGapIcon className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <SquareIcon className="h-3 w-3" weight="fill" />
          )}
        </Button>
      )}
      <InputGroupButton
        onClick={() => onSendClick(inputRef)}
        disabled={disabled}
        size="icon-sm"
        aria-label={running ? 'Queue message' : 'Send message'}
      >
        <PaperPlaneTiltIcon className="h-4 w-4" />
      </InputGroupButton>
    </div>
  );
});
