import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

export type ScriptType = 'command' | 'path';

interface StartupScriptFormProps {
  scriptType: ScriptType;
  onScriptTypeChange: (type: ScriptType) => void;
  startupScript: string;
  onStartupScriptChange: (value: string) => void;
  /** Unique ID prefix for radio buttons to avoid conflicts when multiple forms exist */
  idPrefix?: string;
  /** Hide the label and description header (useful when embedding in dialogs with custom headers) */
  hideHeader?: boolean;
}

export function StartupScriptForm({
  scriptType,
  onScriptTypeChange,
  startupScript,
  onStartupScriptChange,
  idPrefix = 'script',
  hideHeader = false,
}: StartupScriptFormProps) {
  return (
    <div className="min-w-0 space-y-3">
      {!hideHeader && (
        <>
          <Label>Startup Script (Optional)</Label>
          <p className="text-xs text-muted-foreground break-words">
            Command or script to run when initializing new workspaces.
          </p>
        </>
      )}

      <RadioGroup
        value={scriptType}
        onValueChange={(v) => onScriptTypeChange(v as ScriptType)}
        className="min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4"
      >
        <div className="flex min-w-0 items-start gap-2">
          <RadioGroupItem value="command" id={`${idPrefix}-command`} className="mt-0.5 shrink-0" />
          <Label
            htmlFor={`${idPrefix}-command`}
            className="cursor-pointer break-words font-normal leading-snug"
          >
            Shell Command
          </Label>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <RadioGroupItem value="path" id={`${idPrefix}-path`} className="mt-0.5 shrink-0" />
          <Label
            htmlFor={`${idPrefix}-path`}
            className="cursor-pointer break-words font-normal leading-snug"
          >
            Script Path
          </Label>
        </div>
      </RadioGroup>

      <Input
        type="text"
        value={startupScript}
        onChange={(e) => onStartupScriptChange(e.target.value)}
        className="min-w-0 w-full px-2 sm:px-3 font-mono"
        placeholder={
          scriptType === 'command' ? 'npm install && npm run build' : './scripts/setup.sh'
        }
      />
    </div>
  );
}
