import { PaletteIcon } from '@phosphor-icons/react/dist/csr/Palette';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import {
  COLOR_SCHEME_ATTRIBUTE,
  readRenderedThemeColors,
  type RenderedThemeColors,
} from '@/client/lib/appearance';
import {
  type UserSettingsPatch,
  useUpdateUserSettings,
  useUserSettings,
} from '@/client/lib/user-settings-queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  appearanceFromUserSettings,
  COLOR_SCHEME_OPTIONS,
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
import {
  SETTING_FIELD_WIDTH,
  SettingField,
  SettingHelp,
  SettingSelect,
  SettingsSection,
  useSliderDraft,
} from './settings-section';

/** Used until the page's painted colors can be read, and in environments without canvas. */
const SCHEME_COLOR_FALLBACK: Record<'light' | 'dark', RenderedThemeColors> = {
  dark: { background: '#0a0a0a', foreground: '#fafafa' },
  light: { background: '#fafafa', foreground: '#0a0a0a' },
};

/**
 * The background and text colors the active scheme and mode actually paint,
 * so a color picker without an override starts from what the user sees.
 */
function useRenderedSchemeColors(isDark: boolean): RenderedThemeColors {
  const fallback = SCHEME_COLOR_FALLBACK[isDark ? 'dark' : 'light'];
  const [colors, setColors] = useState(fallback);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const next = readRenderedThemeColors() ?? fallback;
      setColors((current) =>
        current.background === next.background && current.foreground === next.foreground
          ? current
          : next
      );
    };
    // The AppearanceProvider and next-themes write to <html>; re-read once
    // their changes have been painted rather than guessing at the timing.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 0);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', COLOR_SCHEME_ATTRIBUTE],
    });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [fallback]);

  return colors;
}

const THEME_MODES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const COLOR_SCHEMES = COLOR_SCHEME_OPTIONS.map((option) => ({
  value: option.id,
  label: option.label,
}));

interface ColorOverrideFieldProps {
  id: string;
  label: string;
  helpText: string;
  value: string | null;
  /** Shown in the picker while no override is saved. */
  placeholderColor: string;
  saving: boolean;
  onCommit: (value: string | null) => void;
}

/** A native color picker that saves on blur, plus a Reset once an override exists. */
function ColorOverrideField({
  id,
  label,
  helpText,
  value,
  placeholderColor,
  saving,
  onCommit,
}: ColorOverrideFieldProps) {
  // Set only while a pick is in progress, so choosing exactly the placeholder
  // color still saves it as an override; otherwise the picker follows the
  // saved value or the painted scheme.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) {
      return;
    }
    setDraft(null);
    const next = draft.toLowerCase();
    if (next !== value?.toLowerCase()) {
      onCommit(next);
    }
  };

  return (
    <SettingField label={label} htmlFor={id} description={helpText} saving={saving}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={draft ?? value ?? placeholderColor}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-1"
        />
        <span className="font-mono text-xs text-muted-foreground">
          {value ?? 'From color scheme'}
        </span>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onCommit(null)}>
            Reset
          </Button>
        )}
      </div>
    </SettingField>
  );
}

interface FontScaleFieldProps {
  value: number;
  saving: boolean;
  onCommit: (value: number) => void;
}

function FontScaleField({ value, saving, onCommit }: FontScaleFieldProps) {
  const { shown, onValueChange, onValueCommit } = useSliderDraft(value, onCommit);

  return (
    <SettingField
      label="Font size"
      id="appearance-font-scale-label"
      saving={saving}
      labelAccessory={<span className="font-mono text-xs text-muted-foreground">{shown}%</span>}
      description="Scales all interface text and spacing, independent of browser zoom."
    >
      <div className="flex items-center gap-2">
        <Slider
          id="appearance-font-scale"
          aria-labelledby="appearance-font-scale-label"
          aria-valuetext={`${shown}%`}
          className={SETTING_FIELD_WIDTH}
          value={[shown]}
          onValueChange={onValueChange}
          onValueCommit={onValueCommit}
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCommit(DEFAULT_FONT_SCALE)}
          disabled={value === DEFAULT_FONT_SCALE}
        >
          Reset
        </Button>
      </div>
    </SettingField>
  );
}

interface FontFamilyFieldProps {
  id: string;
  label: string;
  helpText: string;
  options: readonly FontFamilyOption[];
  value: string | null;
  saving: boolean;
  onCommit: (value: string | null) => void;
}

/** Preset font stacks plus a Custom entry that reveals a free-form font-family input. */
function FontFamilyField({
  id,
  label,
  helpText,
  options,
  value,
  saving,
  onCommit,
}: FontFamilyFieldProps) {
  const savedOptionId = fontOptionIdForValue(options, value);
  // Custom is chosen before its font is saved; presets save as soon as they are
  // picked. The choice lapses once the saved font changes (a save or reset);
  // a failed save restores the font, so the form returns with its draft.
  const [customChosenAt, setCustomChosenAt] = useState<{ value: string | null } | null>(null);
  const selectedId = customChosenAt?.value === value ? CUSTOM_FONT_OPTION_ID : savedOptionId;
  // A failed save keeps the typed font for another try.
  const [customDraft, setCustomDraft] = useState(
    savedOptionId === CUSTOM_FONT_OPTION_ID ? (value ?? '') : ''
  );
  const [customError, setCustomError] = useState<string | null>(null);

  const handleSelect = (nextId: string) => {
    setCustomChosenAt(nextId === CUSTOM_FONT_OPTION_ID ? { value } : null);
    setCustomError(null);
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

  return (
    <div className="space-y-2">
      <SettingSelect
        id={id}
        label={label}
        saving={saving}
        value={selectedId}
        options={[
          ...options.map((option) => ({ value: option.id, label: option.label })),
          { value: CUSTOM_FONT_OPTION_ID, label: 'Custom…' },
        ]}
        onValueChange={handleSelect}
        triggerClassName={SETTING_FIELD_WIDTH}
      />
      {selectedId === CUSTOM_FONT_OPTION_ID && (
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            commitCustom();
          }}
        >
          <Input
            id={`${id}-custom`}
            aria-label={`${label} family`}
            value={customDraft}
            onChange={(event) => {
              setCustomDraft(event.target.value);
              setCustomError(null);
            }}
            placeholder='"Fira Code", monospace'
            className={`${SETTING_FIELD_WIDTH} font-mono text-sm`}
            aria-invalid={customError ? true : undefined}
          />
          <Button
            type="submit"
            size="sm"
            aria-label={`Save ${label.toLowerCase()}`}
            disabled={saving || !customDraft.trim()}
          >
            Save
          </Button>
          {customError && (
            <p className="text-xs text-destructive" role="alert">
              {customError}
            </p>
          )}
          <SettingHelp>
            Any font installed on this device, written as a CSS font-family list.
          </SettingHelp>
        </form>
      )}
      <SettingHelp>{helpText}</SettingHelp>
    </div>
  );
}

const RESET_ALL = {
  appearanceColorScheme: DEFAULT_COLOR_SCHEME,
  appearanceBackgroundColor: null,
  appearanceForegroundColor: null,
  appearanceFontScale: DEFAULT_FONT_SCALE,
  appearanceFontSans: null,
  appearanceFontMono: null,
} satisfies UserSettingsPatch;

export function AppearanceSettingsSection() {
  const settingsQuery = useUserSettings();
  const updateSettings = useUpdateUserSettings();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const schemeColors = useRenderedSchemeColors(resolvedTheme === 'dark');
  const update = (patch: UserSettingsPatch) => updateSettings.mutate(patch);
  const saving = (field: keyof UserSettingsPatch) => updateSettings.isSaving(field);
  // Reset appearance also discards font choices that were never saved.
  const [resets, setResets] = useState(0);

  return (
    <SettingsSection
      title="Appearance"
      icon={<PaletteIcon className="h-5 w-5" />}
      description="Choose a color scheme, adjust text size, and pick the fonts used across the app."
      query={settingsQuery}
      errorTitle="Couldn't load appearance settings"
      contentClassName="space-y-6"
    >
      {(settings) => {
        const appearance = appearanceFromUserSettings(settings);
        return (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <SettingSelect
                id="appearance-color-scheme"
                label="Color scheme"
                description={
                  COLOR_SCHEME_OPTIONS.find((option) => option.id === appearance.colorScheme)
                    ?.description
                }
                saving={saving('appearanceColorScheme')}
                value={appearance.colorScheme}
                options={COLOR_SCHEMES}
                onValueChange={(colorScheme) => update({ appearanceColorScheme: colorScheme })}
                triggerClassName={SETTING_FIELD_WIDTH}
              />
              <SettingSelect
                id="appearance-mode"
                label="Mode"
                description="Every color scheme has a light and a dark variant."
                value={theme ?? 'system'}
                options={THEME_MODES}
                onValueChange={setTheme}
                triggerClassName={SETTING_FIELD_WIDTH}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ColorOverrideField
                id="appearance-background-color"
                label="Background color"
                helpText="Replaces the color scheme’s page background in both light and dark mode."
                value={appearance.backgroundColor}
                placeholderColor={schemeColors.background}
                saving={saving('appearanceBackgroundColor')}
                onCommit={(color) => update({ appearanceBackgroundColor: color })}
              />
              <ColorOverrideField
                id="appearance-foreground-color"
                label="Text color"
                helpText="Replaces the primary text color; secondary text is blended from it."
                value={appearance.foregroundColor}
                placeholderColor={schemeColors.foreground}
                saving={saving('appearanceForegroundColor')}
                onCommit={(color) => update({ appearanceForegroundColor: color })}
              />
            </div>

            <div className="space-y-4 border-t pt-4">
              <FontScaleField
                value={appearance.fontScale}
                saving={saving('appearanceFontScale')}
                onCommit={(fontScale) => update({ appearanceFontScale: fontScale })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <FontFamilyField
                  key={`sans-${resets}`}
                  id="appearance-font-sans"
                  label="Interface font"
                  helpText="Used for navigation, chat, and settings."
                  options={SANS_FONT_OPTIONS}
                  value={appearance.fontSans}
                  saving={saving('appearanceFontSans')}
                  onCommit={(fontSans) => update({ appearanceFontSans: fontSans })}
                />
                <FontFamilyField
                  key={`mono-${resets}`}
                  id="appearance-font-mono"
                  label="Monospace font"
                  helpText="Used for code, diffs, and terminals."
                  options={MONO_FONT_OPTIONS}
                  value={appearance.fontMono}
                  saving={saving('appearanceFontMono')}
                  onCommit={(fontMono) => update({ appearanceFontMono: fontMono })}
                />
              </div>
            </div>

            <div className="flex justify-end border-t pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setResets((count) => count + 1);
                  update(RESET_ALL);
                }}
                disabled={isDefaultAppearance(appearance)}
              >
                Reset appearance
              </Button>
            </div>
          </>
        );
      }}
    </SettingsSection>
  );
}
