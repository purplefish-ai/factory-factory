import { ChatCircleDotsIcon } from '@phosphor-icons/react/dist/csr/ChatCircleDots';
import { ClipboardTextIcon } from '@phosphor-icons/react/dist/csr/ClipboardText';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import type { Meta, StoryObj } from '@storybook/react';
import { StatusCallout } from '@/client/components/status-callout';
import { StatusChip, StatusDot, StatusIcon } from '@/client/components/status-indicators';
import { contrastRatio, mixOver, type Rgb } from '@/client/lib/color-contrast';
import {
  DIFF_STAT_CLASS_NAMES,
  getCiStateTone,
  getPrStatePresentation,
  getStatusToneStyle,
  STATUS_TONES,
  type StatusTone,
} from '@/client/lib/status-tones';
import { Badge } from '@/components/ui/badge';
import { COLOR_SCHEME_OPTIONS, type ColorSchemeId } from '@/shared/appearance';
import { getWorkspaceCiLabel, WORKSPACE_SIDEBAR_CI_STATES } from '@/shared/core';
import { useRenderedTokens } from './rendered-colors';

const TONE_USAGE: Record<StatusTone, string> = {
  neutral: 'Idle, draft, unknown, archived',
  working: 'Agent or setup actively working',
  waiting: 'Waiting on CI, checks or a queued update',
  attention: 'Needs you: permission, plan, answer, conflict',
  success: 'Passed, approved, ready to merge, open PR',
  warning: 'Caution messages and degraded states',
  danger: 'Failed, errors, changes requested, closed PR',
  info: 'Informational messages',
  merged: 'Merged pull requests',
};

const MEASURED_TOKENS = [
  'background',
  'card',
  ...new Set(
    STATUS_TONES.flatMap((tone) => {
      const token = getStatusToneStyle(tone).token;
      return [token, `${token}-accent`];
    })
  ),
];

function Ratio({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className={value >= 4.5 ? undefined : 'font-semibold text-destructive'}>
      {value.toFixed(1)}
    </span>
  );
}

function ToneTable() {
  const { ref, resolved } = useRenderedTokens(MEASURED_TOKENS);
  const rgb = (token: string): Rgb | null => resolved.get(token)?.rgb ?? null;
  const background = rgb('background');
  const card = rgb('card');
  const isDark =
    ref.current?.closest('.dark') !== null && ref.current?.closest('.dark') !== undefined;

  return (
    <div ref={ref} className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="py-2 pr-3 font-medium">Tone</th>
            <th className="py-2 pr-3 font-medium">Dot</th>
            <th className="py-2 pr-3 font-medium">Icon</th>
            <th className="py-2 pr-3 font-medium">Chip</th>
            <th className="py-2 pr-3 font-medium">Text</th>
            <th className="py-2 pr-3 font-medium">Callout</th>
            <th className="py-2 pr-3 font-medium" title="Contrast of the token on bg / card / tint">
              Contrast bg · card · tint
            </th>
          </tr>
        </thead>
        <tbody>
          {STATUS_TONES.map((tone) => {
            const style = getStatusToneStyle(tone);
            const color = rgb(style.token);
            const accent = rgb(`${style.token}-accent`) ?? color;
            const ratio = (surface: Rgb | null) =>
              color && surface ? contrastRatio(color, surface) : null;
            return (
              <tr key={tone} className="border-b align-middle">
                <td className="py-2 pr-3">
                  <div className="font-medium">{style.name}</div>
                  <div className="font-mono text-muted-foreground">
                    {tone} → --{style.token}
                  </div>
                  <div className="text-muted-foreground">{TONE_USAGE[tone]}</div>
                </td>
                <td className="py-2 pr-3">
                  <StatusDot tone={tone} label={style.name} />
                </td>
                <td className="py-2 pr-3">
                  <StatusIcon tone={tone} className="h-4 w-4" />
                </td>
                <td className="py-2 pr-3">
                  <div className="flex flex-col gap-1">
                    <StatusChip tone={tone}>{style.name}</StatusChip>
                    <StatusChip tone={tone} icon size="md">
                      {style.name}
                    </StatusChip>
                  </div>
                </td>
                <td className={`py-2 pr-3 font-medium ${style.text}`}>{style.name} text</td>
                <td className="py-2 pr-3">
                  <StatusCallout tone={tone} size="sm">
                    {style.name} callout
                  </StatusCallout>
                </td>
                <td className="py-2 pr-3 font-mono whitespace-nowrap">
                  <Ratio value={ratio(background)} /> · <Ratio value={ratio(card)} /> ·{' '}
                  <Ratio
                    value={
                      accent && background
                        ? ratio(mixOver(accent, background, isDark ? 0.1 : 0.15))
                        : null
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BadgeVariants() {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="success">Success</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="info">Info</Badge>
      <Badge variant="danger">Danger</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="secondary" size="count">
        4
      </Badge>
      <Badge variant="warning" size="count">
        12
      </Badge>
      <Badge variant="danger" size="count">
        3
      </Badge>
    </div>
  );
}

const SIDEBAR_ROWS: {
  name: string;
  tone: StatusTone;
  label: string;
  icon?: typeof ChatCircleDotsIcon;
}[] = [
  { name: 'Add OAuth login', tone: 'working', label: 'Agent working' },
  {
    name: 'Fix flaky tests',
    tone: 'attention',
    label: 'Needs permission',
    icon: ShieldWarningIcon,
  },
  {
    name: 'Refactor billing',
    tone: 'attention',
    label: 'Needs plan approval',
    icon: ClipboardTextIcon,
  },
  { name: 'Docs cleanup', tone: 'attention', label: 'Needs your answer', icon: ChatCircleDotsIcon },
  { name: 'Search ranking', tone: 'waiting', label: 'Waiting for CI' },
  { name: 'Dark mode banners', tone: 'success', label: 'Ready to merge' },
  { name: 'Upgrade Prisma', tone: 'danger', label: 'Setup failed' },
  { name: 'Telemetry opt-out', tone: 'merged', label: 'Merged' },
  { name: 'Spike: voice mode', tone: 'neutral', label: 'Ready for review' },
];

function InContext() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-1 rounded-md border bg-card p-2">
        <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Workspaces</div>
        {SIDEBAR_ROWS.map((row) => (
          <div
            key={row.name}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            {row.icon ? (
              <StatusIcon tone={row.tone} icon={row.icon} />
            ) : (
              <span className="flex w-3.5 justify-center">
                <StatusDot tone={row.tone} />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <StatusChip tone={row.tone}>{row.label}</StatusChip>
          </div>
        ))}
      </div>

      <div className="space-y-4">
        <div className="space-y-2 rounded-md border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">Pull request states</div>
          <div className="flex flex-wrap gap-2">
            {(['DRAFT', 'OPEN', 'APPROVED', 'CHANGES_REQUESTED', 'MERGED', 'CLOSED'] as const).map(
              (state) => {
                const presentation = getPrStatePresentation(state);
                return presentation ? (
                  <StatusChip
                    key={state}
                    tone={presentation.tone}
                    icon={GitPullRequestIcon}
                    size="md"
                  >
                    {presentation.label}
                  </StatusChip>
                ) : null;
              }
            )}
          </div>
        </div>
        <div className="space-y-2 rounded-md border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">CI and PR summary states</div>
          <div className="flex flex-wrap gap-2">
            {WORKSPACE_SIDEBAR_CI_STATES.filter((state) => state !== 'NONE').map((state) => (
              <StatusChip key={state} tone={getCiStateTone(state)} icon>
                {getWorkspaceCiLabel(state)}
              </StatusChip>
            ))}
          </div>
        </div>
        <div className="space-y-2 rounded-md border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">Diff statistics</div>
          <div className="flex gap-2 font-mono text-xs">
            <span className={DIFF_STAT_CLASS_NAMES.added}>+128</span>
            <span className={DIFF_STAT_CLASS_NAMES.removed}>−42</span>
          </div>
        </div>
        <div className="space-y-2 rounded-md border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">Badge status variants</div>
          <BadgeVariants />
        </div>
      </div>
    </div>
  );
}

function StatusPalette() {
  return (
    <div className="max-w-6xl space-y-8 bg-background p-6 text-foreground">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Status tones</h2>
          <p className="text-sm text-muted-foreground">
            One presentation per tone (src/client/lib/status-tones.ts). Contrast is measured live;
            values below 4.5:1 are flagged.
          </p>
        </div>
        <ToneTable />
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-semibold">In context</h2>
        <InContext />
      </section>
    </div>
  );
}

const meta = {
  title: 'Foundations/StatusPalette',
  component: StatusPalette,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Every status tone as a dot, icon, chip, badge, text and callout, plus typical surfaces. Use the toolbar or the per-scheme stories to compare presets. See docs/status-colors.md.',
      },
    },
  },
  // Remount on theme changes so contrast is re-measured.
  render: (_args, { globals }) => <StatusPalette key={`${globals.theme}-${globals.colorScheme}`} />,
} satisfies Meta<typeof StatusPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

function schemeStory(colorScheme: ColorSchemeId, theme: 'light' | 'dark'): Story {
  const option = COLOR_SCHEME_OPTIONS.find((candidate) => candidate.id === colorScheme);
  return {
    name: `${option?.label ?? colorScheme} ${theme}`,
    globals: { theme, colorScheme },
  };
}

export const FactoryLight = schemeStory('factory', 'light');
export const FactoryDark = schemeStory('factory', 'dark');
export const GithubLight = schemeStory('github', 'light');
export const GithubDark = schemeStory('github', 'dark');
export const OneLight = schemeStory('one', 'light');
export const OneDark = schemeStory('one', 'dark');
export const SolarizedLight = schemeStory('solarized', 'light');
export const SolarizedDark = schemeStory('solarized', 'dark');
export const HighContrastLight = schemeStory('high-contrast', 'light');
export const HighContrastDark = schemeStory('high-contrast', 'dark');
