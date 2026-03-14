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

const ICON_MAP: Record<string, LucideIcon> = {
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
};

export function getQuickActionIcon(iconName?: string | null): LucideIcon {
  return (iconName && ICON_MAP[iconName]) || Zap;
}
