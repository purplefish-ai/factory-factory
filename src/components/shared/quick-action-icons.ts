import {
  Camera,
  Check,
  Eye,
  GitBranch,
  GitPullRequest,
  type LucideIcon,
  MessageSquareText,
  Play,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';

const ICON_MAP = {
  zap: Zap,
  sparkles: Sparkles,
  eye: Eye,
  play: Play,
  terminal: Terminal,
  check: Check,
  camera: Camera,
  'git-branch': GitBranch,
  'git-pull-request': GitPullRequest,
  'message-square-text': MessageSquareText,
} satisfies Record<string, LucideIcon>;

function isQuickActionIconName(iconName: string): iconName is keyof typeof ICON_MAP {
  return Object.hasOwn(ICON_MAP, iconName);
}

export function getQuickActionIcon(iconName?: string | null): LucideIcon {
  if (iconName && isQuickActionIconName(iconName)) {
    return ICON_MAP[iconName];
  }
  return Zap;
}
