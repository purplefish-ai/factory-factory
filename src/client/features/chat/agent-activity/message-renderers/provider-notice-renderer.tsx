import { StatusCallout } from '@/client/components/status-callout';
import { Spinner } from '@/components/ui/spinner';
import {
  type ProviderSessionNotice,
  readCodexReconnectTitle,
} from '@/shared/acp-protocol/protocol/provider-session-notice';

const reconnectLabels = {
  retrying: 'Codex is reconnecting',
  recovered: 'Codex reconnected',
  ended: 'Codex tried to reconnect',
};

export function ProviderNoticeRenderer({
  notice,
  className,
}: {
  notice: ProviderSessionNotice;
  className?: string;
}) {
  const { reconnect, title, severity, details } = notice;
  const progress = reconnect && readCodexReconnectTitle(title)?.progress;
  const retrying = reconnect === 'retrying';
  const label = reconnect ? reconnectLabels[reconnect] : title;
  return (
    <StatusCallout
      tone={reconnect === 'recovered' ? 'success' : severity}
      icon={retrying ? <Spinner aria-hidden="true" /> : undefined}
      role={reconnect ? 'status' : undefined}
      size="sm"
      className={className}
    >
      <span>
        {label}
        {progress ? ` · ${progress}` : ''}
      </span>
      {!reconnect && details && <div className="whitespace-pre-wrap">{details}</div>}
    </StatusCallout>
  );
}
