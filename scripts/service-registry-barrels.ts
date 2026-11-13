import ts from 'typescript';

/** A capsule barrel (`src/backend/services/<capsule>/index.ts`) and its source text. */
export type CapsuleBarrel = { path: string; source: string };

function wildcardText(statement: ts.ExportDeclaration, sourceFile: ts.SourceFile): string {
  return statement.getText(sourceFile).replace(/\s+/gu, ' ');
}

/**
 * Rejects `export *` (with or without `as`, including `export type *`) in
 * capsule barrels, so each capsule's public names are listed in its `index.ts`.
 */
export function getCapsuleBarrelWildcardErrors(barrels: readonly CapsuleBarrel[]): string[] {
  return barrels.flatMap(({ path, source }) => {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return sourceFile.statements
      .filter(
        (statement): statement is ts.ExportDeclaration =>
          ts.isExportDeclaration(statement) &&
          (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
      )
      .map(
        (statement) =>
          `${path} has \`${wildcardText(statement, sourceFile)}\`; list the names it exports explicitly so the capsule's public API reads in one file.`
      );
  });
}
