interface BackupPRIdentitySource {
  id: string;
  prUrl: string | null;
  prs: readonly { id: string; url: string }[];
}

/** PR identities the backup writer creates, including its retained flat-URL fallback. */
export function backupPRIdentities(workspace: BackupPRIdentitySource) {
  if (workspace.prs.length) {
    return workspace.prs.map(({ id, url }) => ({ id, url }));
  }
  return workspace.prUrl ? [{ id: `legacy-pr-${workspace.id}`, url: workspace.prUrl }] : [];
}
