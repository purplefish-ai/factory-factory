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
    <div className="space-y-3">
      {!hideHeader && (
        <>
          <Label>Startup Script (Optional)</Label>
          <p className="text-xs text-muted-foreground">
            Command or script to run when initializing new workspaces.
          </p>
        </>
      )}

      <RadioGroup
        value={scriptType}
        onValueChange={(v) => onScriptTypeChange(v as ScriptType)}
        className="flex gap-4"
      >
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="command" id={`${idPrefix}-command`} />
          <Label htmlFor={`${idPrefix}-command`} className="font-normal cursor-pointer">
            Shell Command
          </Label>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="path" id={`${idPrefix}-path`} />
          <Label htmlFor={`${idPrefix}-path`} className="font-normal cursor-pointer">
            Script Path
          </Label>
        </div>
      </RadioGroup>

      <Input
        type="text"
        value={startupScript}
        onChange={(e) => onStartupScriptChange(e.target.value)}
        className="font-mono"
        placeholder={
          scriptType === 'command' ? 'npm install && npm run build' : './scripts/setup.sh'
        }
      />
    </div>
  );
}
