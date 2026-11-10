import type { ComponentProps, ReactNode } from 'react';
import { QueryState, type QueryStateQuery } from '@/client/components/query-state';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** Width of a settings select, input or slider: full width on phones, fixed beside others. */
export const SETTING_FIELD_WIDTH = 'w-full sm:w-[280px]';

interface SectionShellProps {
  title: ReactNode;
  /** Shown before the title, e.g. `<PaletteIcon className="size-5" />`. */
  icon?: ReactNode;
  description?: ReactNode;
  /** Header control aligned to the end, e.g. a reset link. */
  action?: ReactNode;
  /** Replaces the content's default `space-y-4`. */
  contentClassName?: string;
}

interface StaticSectionProps extends SectionShellProps {
  query?: undefined;
  errorTitle?: undefined;
  children: ReactNode;
}

interface QuerySectionProps<TData> extends SectionShellProps {
  /**
   * The query the controls need. Until it has data, the section shows a
   * skeleton, or the error with Retry; controls never render with defaults.
   */
  query: QueryStateQuery<TData>;
  /** e.g. "Couldn't load notification settings". */
  errorTitle: string;
  children: (data: TData) => ReactNode;
}

/** The card every settings section uses: title, icon, description and content. */
export function SettingsSection<TData>(props: QuerySectionProps<TData>): ReactNode;
export function SettingsSection(props: StaticSectionProps): ReactNode;
export function SettingsSection<TData>(props: StaticSectionProps | QuerySectionProps<TData>) {
  const { title, icon, description, action, contentClassName } = props;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className={contentClassName ?? 'space-y-4'}>
        {props.query ? (
          <QueryState
            query={props.query}
            errorTitle={props.errorTitle}
            loading={<Skeleton className="h-10 w-full" />}
          >
            {props.children}
          </QueryState>
        ) : (
          props.children
        )}
      </CardContent>
    </Card>
  );
}

/** Muted help text under a setting's label or control. */
export function SettingHelp({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

interface SettingLabelProps {
  label: ReactNode;
  htmlFor?: string;
  id?: string;
  /** True while a change to this setting is being saved. */
  saving?: boolean;
}

function SettingLabel({ label, htmlFor, id, saving }: SettingLabelProps) {
  return (
    <span className="flex items-center gap-2">
      <Label htmlFor={htmlFor} id={id}>
        {label}
      </Label>
      {saving ? <Spinner className="size-3.5 text-muted-foreground" aria-label="Saving" /> : null}
    </span>
  );
}

interface SettingRowProps extends SettingLabelProps {
  description?: ReactNode;
  descriptionId?: string;
  /** Shown under the description, e.g. an inline error. */
  message?: ReactNode;
  /** The control, usually a `Switch` or `Button`. */
  children: ReactNode;
  className?: string;
}

/** A setting with its label and description beside its control (stacked on phones). */
export function SettingRow({
  description,
  descriptionId,
  message,
  children,
  className,
  ...label
}: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
        className
      )}
    >
      <div className="space-y-0.5">
        <SettingLabel {...label} />
        {description ? <SettingHelp id={descriptionId}>{description}</SettingHelp> : null}
        {message}
      </div>
      {children}
    </div>
  );
}

interface SettingFieldProps extends SettingLabelProps {
  /** Shown at the end of the label line, e.g. a slider's current value. */
  labelAccessory?: ReactNode;
  description?: ReactNode;
  /** The control, usually a `Select`, `Input` or `Slider`. */
  children: ReactNode;
  className?: string;
}

/** A setting with its label above its control and help text below. */
export function SettingField({
  labelAccessory,
  description,
  children,
  className,
  ...label
}: SettingFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <SettingLabel {...label} />
        {labelAccessory}
      </div>
      {children}
      {description ? <SettingHelp>{description}</SettingHelp> : null}
    </div>
  );
}

export interface SettingOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SettingSelectProps<T extends string> extends Omit<SettingFieldProps, 'children'> {
  id: string;
  value: T;
  options: readonly SettingOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  /** Applied to the trigger, e.g. {@link SETTING_FIELD_WIDTH}. */
  triggerClassName?: string;
}

/** A {@link SettingField} whose control is a select of fixed options. */
export function SettingSelect<T extends string>({
  id,
  value,
  options,
  onValueChange,
  disabled,
  triggerClassName,
  ...field
}: SettingSelectProps<T>) {
  return (
    <SettingField htmlFor={id} {...field}>
      <Select
        value={value}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.value === next);
          if (option) {
            onValueChange(option.value);
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className={triggerClassName}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingField>
  );
}
