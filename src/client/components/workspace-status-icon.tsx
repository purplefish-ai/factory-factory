import { ChatCircleDotsIcon } from '@phosphor-icons/react/dist/csr/ChatCircleDots';
import { ClipboardTextIcon } from '@phosphor-icons/react/dist/csr/ClipboardText';
import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { StatusDot, StatusIcon } from './status-indicators';

interface WorkspaceStatusIconProps {
  pendingRequestType?: 'permission_request' | 'plan_approval' | 'user_question' | null;
  isWorking?: boolean;
  sessionRuntimeErrorMessage?: string | null;
}

/** Every pending request is "needs you"; the icon says which kind. */
const PENDING_REQUEST_ICONS: Record<
  NonNullable<WorkspaceStatusIconProps['pendingRequestType']>,
  { icon: Icon; name: string }
> = {
  permission_request: { icon: ShieldWarningIcon, name: 'permission-request' },
  plan_approval: { icon: ClipboardTextIcon, name: 'plan-approval' },
  user_question: { icon: ChatCircleDotsIcon, name: 'user-question' },
};

export function WorkspaceStatusIcon({
  pendingRequestType,
  isWorking,
  sessionRuntimeErrorMessage,
}: WorkspaceStatusIconProps) {
  if (pendingRequestType) {
    const { icon, name } = PENDING_REQUEST_ICONS[pendingRequestType];
    return (
      <span data-icon={name} className="inline-flex shrink-0">
        <StatusIcon tone="attention" icon={icon} />
      </span>
    );
  }

  if (sessionRuntimeErrorMessage) {
    return (
      <span data-icon="runtime-error" className="inline-flex shrink-0">
        <StatusIcon tone="danger" icon={WarningIcon} />
      </span>
    );
  }

  return <StatusDot tone={isWorking ? 'working' : 'neutral'} />;
}
