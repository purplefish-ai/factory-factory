import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SQLite does not auto-create indexes on child-key columns. Every
// @relation(fields: [...]) must have its columns as the leading columns of
// some @@index, @@unique, @@id, @id, or @unique on the model, or
// child-by-parent lookups and parent-row deletes (foreign-key enforcement and
// cascade actions) degrade to table scans.
//
// Escape hatch: list "Model.field" entries here with a reason. Composite keys
// join their field names with "+". Entries whose field gains an index later
// are reported as stale so the list cannot rot.
const EXEMPT: Record<string, string> = {};

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), '..');
const schemaPath = path.join(repositoryRoot, 'prisma/schema.prisma');

interface ModelInfo {
  name: string;
  // Column lists that can serve a lookup, e.g. [["projectId", "createdAt"]].
  indexes: string[][];
  // One entry per owning-side relation: the foreign-key column list.
  relationFieldSets: string[][];
}

interface ColumnListScanState {
  parenthesisDepth: number;
  quote: '"' | "'" | null;
  escaped: boolean;
}

function consumeColumnListCharacter(
  character: string | undefined,
  state: ColumnListScanState
): boolean {
  if (state.quote) {
    if (state.escaped) {
      state.escaped = false;
    } else if (character === '\\') {
      state.escaped = true;
    } else if (character === state.quote) {
      state.quote = null;
    }
    return false;
  }

  if (character === '"' || character === "'") {
    state.quote = character;
  } else if (character === '(') {
    state.parenthesisDepth += 1;
  } else if (character === ')') {
    state.parenthesisDepth -= 1;
  }

  return character === ',' && state.parenthesisDepth === 0;
}

function parseColumnList(rawList: string): string[] {
  // Entries may carry arguments, e.g. "title(sort: Desc)" — keep the bare name.
  const entries: string[] = [];
  let entryStart = 0;
  const state: ColumnListScanState = {
    parenthesisDepth: 0,
    quote: null,
    escaped: false,
  };

  for (let index = 0; index < rawList.length; index += 1) {
    const character = rawList[index];
    if (consumeColumnListCharacter(character, state)) {
      entries.push(rawList.slice(entryStart, index));
      entryStart = index + 1;
    }
  }
  entries.push(rawList.slice(entryStart));

  return entries
    .map((entry) => entry.trim().split(/[(:\s]/)[0] ?? '')
    .filter((name) => name.length > 0);
}

function parseModelLine(line: string, model: ModelInfo): void {
  const blockAttribute = line.match(/^@@(index|unique|id)\([^[]*\[([^\]]*)\]/);
  if (blockAttribute) {
    model.indexes.push(parseColumnList(blockAttribute[2] ?? ''));
    return;
  }

  const field = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+\S+(.*)$/);
  if (!field) {
    return;
  }

  const fieldName = field[1] ?? '';
  const attributes = field[2] ?? '';
  if (/@id\b/.test(attributes) || /@unique\b/.test(attributes)) {
    model.indexes.push([fieldName]);
  }

  const relationFields = attributes.match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/);
  if (relationFields) {
    model.relationFieldSets.push(parseColumnList(relationFields[1] ?? ''));
  }
}

function parseModels(schemaText: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const matches = schemaText.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{([\s\S]*?)^\}/gm);

  for (const match of matches) {
    const model: ModelInfo = {
      name: match[1] ?? '',
      indexes: [],
      relationFieldSets: [],
    };
    for (const rawLine of (match[2] ?? '').split('\n')) {
      const line = (rawLine.split('//')[0] ?? '').trim();
      if (line.length > 0) {
        parseModelLine(line, model);
      }
    }
    models.push(model);
  }

  return models;
}

// An index serves a foreign-key lookup when its leading columns are exactly
// the foreign-key columns in any order.
function isCovered(relationColumns: string[], indexes: string[][]): boolean {
  return indexes.some((indexColumns) => {
    if (indexColumns.length < relationColumns.length) {
      return false;
    }
    const leadingColumns = new Set(indexColumns.slice(0, relationColumns.length));
    return relationColumns.every((column) => leadingColumns.has(column));
  });
}

function checkModel(model: ModelInfo, errors: string[], seenExemptions: Set<string>): void {
  for (const relationColumns of model.relationFieldSets) {
    const key = `${model.name}.${relationColumns.join('+')}`;
    const covered = isCovered(relationColumns, model.indexes);

    if (Object.hasOwn(EXEMPT, key)) {
      seenExemptions.add(key);
      if (covered) {
        errors.push(
          `Stale exemption: "${key}" is exempt but now has a covering index. Remove it from EXEMPT in scripts/check-fk-indexes.ts.`
        );
      }
      continue;
    }

    if (!covered) {
      errors.push(
        `Model "${model.name}" relation on [${relationColumns.join(', ')}] has no covering index. ` +
          `Add @@index([${relationColumns.join(', ')}]) (or exempt it with a reason in scripts/check-fk-indexes.ts).`
      );
    }
  }
}

export function collectForeignKeyIndexViolations(schemaText: string): string[] {
  const models = parseModels(schemaText);
  const errors: string[] = [];
  const seenExemptions = new Set<string>();

  for (const model of models) {
    checkModel(model, errors, seenExemptions);
  }

  for (const key of Object.keys(EXEMPT)) {
    if (!seenExemptions.has(key)) {
      errors.push(
        `Unknown exemption: "${key}" does not match any relation in prisma/schema.prisma. Remove it from EXEMPT.`
      );
    }
  }

  return errors;
}

function main(): void {
  const errors = collectForeignKeyIndexViolations(readFileSync(schemaPath, 'utf8'));

  if (errors.length > 0) {
    process.stderr.write(
      ['Foreign key index check failed:', ...errors.map((error) => `- ${error}`), ''].join('\n')
    );
    process.exit(1);
  }

  process.stdout.write('Foreign key index check passed.\n');
}

const entryPath = process.argv[1];
if (entryPath && path.resolve(entryPath) === scriptFile) {
  main();
}
