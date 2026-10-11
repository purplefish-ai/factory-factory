import { PaletteIcon } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import {
  appearanceFromUserSettings,
  COLOR_SCHEME_OPTIONS,
  type ColorSchemeId,
  CUSTOM_FONT_OPTION_ID,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_FONT_SCALE,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  type FontFamilyOption,
  fontFamilySchema,
  fontOptionIdForValue,
  isDefaultAppearance,
  MONO_FONT_OPTIONS,
  SANS_FONT_OPTIONS,
} from '@/shared/appearance';

type AppearanceUpdate = Partial<{
  appearanceColorScheme: ColorSchemeId;
  appearanceBackgroundColor: string | null;
  appearanceForegroundColor: string | null;
  appearanceFontScale: number;
  appearanceFontSans: string | null;
  appearanceFontMono: string | null;
}>;

const FIELD_WIDTH = 'w-full sm:w-[280px]';

const THEME_MODES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function ThemeModeField() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="appearance-mode">Mode</Label>
      <Select value={theme ?? 'system'} onValueChange={setTheme}>
        <SelectTrigger id="appearance-mode" className={FIELD_WIDTH}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {THEME_MODES.map((mode) => (
            <SelectItem key={mode.value} value={mode.value}>
              {mode.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Every color scheme has a light and a dark variant.
      </p>
    </div>
  );
}

interface ColorSchemeFieldProps {
  value: ColorSchemeId;
  disabled: boolean;
  onChange: (value: ColorSchemeId) => void;
}

function ColorSchemeField({ value, disabled, onChange }: ColorSchemeFieldProps) {
  const selected = COLOR_SCHEME_OPTIONS.find((option) => option.id === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="appearance-color-scheme">Color scheme</Label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as ColorSchemeId)}
        disabled={disabled}
      >
        <SelectTrigger id="appearance-color-scheme" className={FIELD_WIDTH}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COLOR_SCHEME_OPTIONS.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{selected?.description}</p>
    </div>
  );
}

interface ColorOverrideFieldProps {
  id: string;
  label: string;
  helpText: string;
  value: string | null;
  /** Shown in the picker while no override is saved. */
  placeholderColor: string;
  disabled: boolean;
  onCommit: (value: string | null) => void;
}

/** A native color picker that saves on blur, plus a Reset once an override exists. */
function ColorOverrideField({
  id,
  label,
  helpText,
  value,
  placeholderColor,
  disabled,
  onCommit,
}: ColorOverrideFieldProps) {
  const shown = value ?? placeholderColor;
  const [draft, setDraft] = useState(shown);

  useEffect(() => {
    setDraft(shown);
  }, [shown]);

  const commit = () => {
    const next = draft.toLowerCase();
    if (next !== shown.toLowerCase()) {
      onCommit(next);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          disabled={disabled}
          className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-1 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="font-mono text-xs text-muted-foreground">
          {value ?? 'From color scheme'}
        </span>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onCommit(null)} disabled={disabled}>
            Reset
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{helpText}</p>
    </div>
  );
}

interface FontScaleFieldProps {
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}

function FontScaleField({ value, disabled, onCommit }: FontScaleFieldProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="space-y-1.5">
      <div className={`flex items-center justify-between ${FIELD_WIDTH}`}>
        <Label htmlFor="appearance-font-scale">Font size</Label>
        <span className="font-mono text-xs text-muted-foreground">{draft}%</span>
      </div>
      <div className="flex items-center gap-2">
        <Slider
          id="appearance-font-scale"
          className={FIELD_WIDTH}
          value={[draft]}
          onValueChange={([next]) => setDraft(next ?? value)}
          onValueCommit={([next]) => {
            if (next !== undefined && next !== value) {
              onCommit(next);
            }
          }}
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          disabled={disabled}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCommit(DEFAULT_FONT_SCALE)}
          disabled={disabled || value === DEFAULT_FONT_SCALE}
        >
          Reset
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Scales all interface text and spacing, independent of browser zoom.
      </p>
    </div>
  );
}

interface FontFamilyFieldProps {
  id: string;
  label: string;
  helpText: string;
  options: readonly FontFamilyOption[];
  value: string | null;
  disabled: boolean;
  onCommit: (value: string | null) => void;
}

/** Preset font stacks plus a Custom entry that reveals a free-form font-family input. */
function FontFamilyField({
  id,
  label,
  helpText,
  options,
  value,
  disabled,
  onCommit,
}: FontFamilyFieldProps) {
  const savedOptionId = fontOptionIdForValue(options, value);
  const [selectedId, setSelectedId] = useState(savedOptionId);
  const [customDraft, setCustomDraft] = useState(
    savedOptionId === CUSTOM_FONT_OPTION_ID ? (value ?? '') : ''
  );
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(savedOptionId);
    if (savedOptionId === CUSTOM_FONT_OPTION_ID) {
      setCustomDraft(value ?? '');
    }
  }, [savedOptionId, value]);

  const handleSelect = (nextId: string) => {
    setSelectedId(nextId);
    setCustomError(null);
    if (nextId === CUSTOM_FONT_OPTION_ID) {
      return;
    }
    const option = options.find((candidate) => candidate.id === nextId);
    if (option && option.value !== value) {
      onCommit(option.value);
    }
  };

  const commitCustom = () => {
    if (customDraft.trim() === '') {
      return;
    }
    const parsed = fontFamilySchema.safeParse(customDraft);
    if (!parsed.success) {
      setCustomError(parsed.error.issues[0]?.message ?? 'Invalid font family');
      return;
    }
    setCustomError(null);
    if (parsed.data !== value) {
      onCommit(parsed.data);
    }
  };

  const customInputId = `${id}-custom`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={selectedId} onValueChange={handleSelect} disabled={disabled}>
        <SelectTrigger id={id} className={FIELD_WIDTH}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_FONT_OPTION_ID}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {selectedId === CUSTOM_FONT_OPTION_ID && (
        <div className="space-y-1">
          <Input
            id={customInputId}
            aria-label={`${label} family`}
            value={customDraft}
            onChange={(event) => {
              setCustomDraft(event.target.value);
              setCustomError(null);
            }}
            onBlur={commitCustom}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitCustom();
              }
            }}
            placeholder='"Fira Code", monospace'
            className={`${FIELD_WIDTH} font-mono text-sm`}
            disabled={disabled}
            aria-invalid={customError ? true : undefined}
          />
          {customError && (
            <p className="text-xs text-destructive" role="alert">
              {customError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Any font installed on this device, written as a CSS font-family list.
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{helpText}</p>
    </div>
  );
}

const RESET_ALL: AppearanceUpdate = {
  appearanceColorScheme: DEFAULT_COLOR_SCHEME,
  appearanceBackgroundColor: null,
  appearanceForegroundColor: null,
  appearanceFontScale: DEFAULT_FONT_SCALE,
  appearanceFontSans: null,
  appearanceFontMono: null,
};

export function AppearanceSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const { resolvedTheme } = useTheme();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: (result) => {
      // Seed the cache so the AppearanceProvider applies the change before
      // the refetch lands, then refetch to stay authoritative.
      utils.userSettings.get.setData(undefined, result);
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update appearance: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PaletteIcon className="h-5 w-5" />
            Appearance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const appearance = appearanceFromUserSettings(settings);
  const disabled = updateSettings.isPending;
  const isDark = resolvedTheme === 'dark';
  const update = (patch: AppearanceUpdate) => updateSettings.mutate(patch);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PaletteIcon className="h-5 w-5" />
          Appearance
        </CardTitle>
        <CardDescription>
          Choose a color scheme, adjust text size, and pick the fonts used across the app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <ColorSchemeField
            value={appearance.colorScheme}
            disabled={disabled}
            onChange={(colorScheme) => update({ appearanceColorScheme: colorScheme })}
          />
          <ThemeModeField />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <ColorOverrideField
            id="appearance-background-color"
            label="Background color"
            helpText="Replaces the color scheme’s page background in both light and dark mode."
            value={appearance.backgroundColor}
            placeholderColor={isDark ? '#0a0a0a' : '#fafafa'}
            disabled={disabled}
            onCommit={(color) => update({ appearanceBackgroundColor: color })}
          />
          <ColorOverrideField
            id="appearance-foreground-color"
            label="Text color"
            helpText="Replaces the primary text color; secondary text is blended from it."
            value={appearance.foregroundColor}
            placeholderColor={isDark ? '#fafafa' : '#0a0a0a'}
            disabled={disabled}
            onCommit={(color) => update({ appearanceForegroundColor: color })}
          />
        </div>

        <div className="space-y-4 border-t pt-4">
          <FontScaleField
            value={appearance.fontScale}
            disabled={disabled}
            onCommit={(fontScale) => update({ appearanceFontScale: fontScale })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FontFamilyField
              id="appearance-font-sans"
              label="Interface font"
              helpText="Used for navigation, chat, and settings."
              options={SANS_FONT_OPTIONS}
              value={appearance.fontSans}
              disabled={disabled}
              onCommit={(fontSans) => update({ appearanceFontSans: fontSans })}
            />
            <FontFamilyField
              id="appearance-font-mono"
              label="Monospace font"
              helpText="Used for code, diffs, and terminals."
              options={MONO_FONT_OPTIONS}
              value={appearance.fontMono}
              disabled={disabled}
              onCommit={(fontMono) => update({ appearanceFontMono: fontMono })}
            />
          </div>
        </div>

        <div className="flex justify-end border-t pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => update(RESET_ALL)}
            disabled={disabled || isDefaultAppearance(appearance)}
          >
            Reset appearance
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
