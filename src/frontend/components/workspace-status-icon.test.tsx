import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceStatusIcon } from './workspace-status-icon';

describe('WorkspaceStatusIcon', () => {
  it('prioritizes pending requests over runtime errors', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceStatusIcon
        pendingRequestType="permission_request"
        sessionRuntimeErrorMessage="runtime failed"
      />
    );

    expect(markup).toContain('lucide-shield-alert');
    expect(markup).not.toContain('lucide-triangle-alert');
  });

  it('shows runtime error icon when there is no pending request', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceStatusIcon sessionRuntimeErrorMessage="runtime failed" />
    );

    expect(markup).toContain('lucide-triangle-alert');
  });
});
