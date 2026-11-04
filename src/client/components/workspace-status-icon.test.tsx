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

    expect(markup).toContain('data-icon="permission-request"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Needs approval"');
    expect(markup).not.toContain('data-icon="runtime-error"');
  });

  it('falls back to a generic needs-you icon for an unknown request type', () => {
    // Server data can carry a type this client doesn't know yet.
    const unknownType = 'REVIEW' as unknown as 'permission_request';
    const markup = renderToStaticMarkup(<WorkspaceStatusIcon pendingRequestType={unknownType} />);

    expect(markup).toContain('data-icon="pending-request"');
    expect(markup).toContain('data-status-tone="attention"');
  });

  it('shows runtime error icon when there is no pending request', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceStatusIcon sessionRuntimeErrorMessage="runtime failed" />
    );

    expect(markup).toContain('data-icon="runtime-error"');
  });

  it.each(['permission_request', 'plan_approval', 'user_question'] as const)(
    'shows the %s request with the shared needs-you tone',
    (pendingRequestType) => {
      const markup = renderToStaticMarkup(
        <WorkspaceStatusIcon pendingRequestType={pendingRequestType} />
      );
      expect(markup).toContain('data-status-tone="attention"');
      expect(markup).toContain('text-warning');
    }
  );

  it('uses the danger tone for runtime errors', () => {
    const markup = renderToStaticMarkup(<WorkspaceStatusIcon sessionRuntimeErrorMessage="boom" />);
    expect(markup).toContain('text-destructive');
  });

  it('pulses the running dot only while working', () => {
    const working = renderToStaticMarkup(<WorkspaceStatusIcon isWorking />);
    expect(working).toContain('bg-running');
    expect(working).toContain('animate-pulse');
    const idle = renderToStaticMarkup(<WorkspaceStatusIcon />);
    expect(idle).toContain('bg-muted-foreground/50');
    expect(idle).not.toContain('animate-pulse');
  });
});
