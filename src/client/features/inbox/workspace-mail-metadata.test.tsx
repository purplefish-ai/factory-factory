import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceMailSummary } from '@/shared/workspace-mail';
import { MailMetadata } from './workspace-mail-metadata';

function mail(createdAt: Date): WorkspaceMailSummary {
  return {
    id: 'mail',
    revision: 1,
    subject: null,
    preview: '',
    kind: 'MESSAGE',
    taskKey: null,
    taskRevision: null,
    sourceWorkspaceId: 'source',
    sourceWorkspaceName: 'Source',
    sourceProjectName: 'Project',
    createdAt,
    readAt: null,
    acknowledgedAt: null,
    supersededAt: null,
  };
}

describe('MailMetadata dates', () => {
  it('retains precise machine dates and shows a year in readable metadata', () => {
    const markup = renderToStaticMarkup(
      <MailMetadata mail={mail(new Date('2026-11-04T10:23:45.678Z'))} />
    );
    expect(markup).toContain('dateTime="2026-11-04T10:23:45.678Z"');
    expect(markup).toContain('2026');
    expect(markup).toContain(':45');
  });

  it('renders an invalid date as readable fallback without an invalid datetime attribute', () => {
    const markup = renderToStaticMarkup(<MailMetadata mail={mail(new Date(Number.NaN))} />);
    expect(markup).toContain('Unknown date');
    expect(markup).not.toContain('dateTime=');
  });
});
