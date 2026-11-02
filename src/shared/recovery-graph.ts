export type RecoveryImportedIds = {
  projects: ReadonlySet<string>;
  workspaces: ReadonlySet<string>;
  sessions: ReadonlySet<string>;
  runs: ReadonlySet<string>;
};

/** A retained reference may outlive its source row, but cannot borrow a target row. */
export function retainedReferenceAllowed(
  sourceIds: ReadonlySet<string>,
  importedIds: ReadonlySet<string>,
  id: string,
  exists: boolean
) {
  return sourceIds.has(id) ? importedIds.has(id) : !exists;
}
