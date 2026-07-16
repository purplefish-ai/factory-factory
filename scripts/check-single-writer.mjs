import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const WORKSPACE_ACCESSOR_REL_PATH = 'src/backend/services/workspace/resources/workspace.accessor.ts';
const PRISMA_SCHEMA_REL_PATH = 'prisma/schema.prisma';

const PRISMA_SCALAR_TYPES = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

const workspaceFieldOwners = {
  name: new Set(['src/backend/services/workspace/service/lifecycle/data.service.ts']),
  description: new Set(['src/backend/services/workspace/service/lifecycle/data.service.ts']),
  status: new Set(['src/backend/services/workspace/service/lifecycle/state-machine.service.ts']),
  initErrorMessage: new Set([
    'src/backend/services/workspace/service/lifecycle/state-machine.service.ts',
  ]),
  initOutput: new Set(['src/backend/services/run-script/service/startup-script.service.ts']),
  initStartedAt: new Set([
    'src/backend/services/workspace/service/lifecycle/state-machine.service.ts',
  ]),
  initCompletedAt: new Set([
    'src/backend/services/workspace/service/lifecycle/state-machine.service.ts',
  ]),
  initScriptPid: new Set([
    'src/backend/services/run-script/service/startup-script.service.ts',
    'src/backend/services/workspace/service/lifecycle/state-machine.service.ts',
  ]),
  initRetryCount: new Set([
    'src/backend/services/workspace/service/lifecycle/state-machine.service.ts',
  ]),

  githubIssueNumber: new Set([
    'src/backend/services/workspace/service/lifecycle/creation.service.ts',
  ]),
  githubIssueUrl: new Set(['src/backend/services/workspace/service/lifecycle/creation.service.ts']),
  linearIssueId: new Set(['src/backend/services/workspace/service/lifecycle/creation.service.ts']),
  linearIssueIdentifier: new Set([
    'src/backend/services/workspace/service/lifecycle/creation.service.ts',
  ]),
  linearIssueUrl: new Set(['src/backend/services/workspace/service/lifecycle/creation.service.ts']),
  creationSource: new Set(['src/backend/services/workspace/service/lifecycle/creation.service.ts']),
  creationMetadata: new Set(['src/backend/services/workspace/service/lifecycle/creation.service.ts']),

  prUrl: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prNumber: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prState: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prReviewState: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prCiStatus: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prUpdatedAt: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prCiFailedAt: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prCiLastNotifiedAt: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prReviewLastCheckedAt: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),
  prReviewLastCommentId: new Set(['src/backend/services/github/service/pr-snapshot.service.ts']),

  ratchetEnabled: new Set(['src/backend/services/ratchet/service/ratchet.service.ts']),
  ratchetState: new Set(['src/backend/services/ratchet/service/ratchet.service.ts']),
  ratchetLastCheckedAt: new Set(['src/backend/services/ratchet/service/ratchet.service.ts']),
  ratchetActiveSessionId: new Set([
    'src/backend/services/ratchet/service/ratchet.service.ts',
    'src/backend/services/ratchet/service/ratchet-active-session.helpers.ts',
    'src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts',
  ]),
  ratchetLastCiRunId: new Set([
    'src/backend/services/ratchet/service/ratchet.service.ts',
    'src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts',
  ]),
  ratchetDispatchOutcome: new Set([
    'src/backend/services/ratchet/service/ratchet.service.ts',
    'src/backend/services/ratchet/service/ratchet-active-session.helpers.ts',
    'src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts',
  ]),
  ratchetDispatchRetryCount: new Set([
    'src/backend/services/ratchet/service/ratchet.service.ts',
    'src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts',
  ]),
  defaultSessionProvider: new Set([
    'src/backend/services/workspace/service/lifecycle/data.service.ts',
  ]),
  ratchetSessionProvider: new Set([
    'src/backend/services/workspace/service/lifecycle/data.service.ts',
  ]),

  hasHadSessions: new Set(['src/backend/services/session/service/lifecycle/session.repository.ts']),
  cachedKanbanColumn: new Set(['src/backend/services/workspace/service/state/kanban-state.ts']),
  stateComputedAt: new Set(['src/backend/services/workspace/service/state/kanban-state.ts']),

  worktreePath: new Set([
    'src/backend/orchestration/workspace-init.orchestrator.ts',
    'src/backend/services/workspace/service/lifecycle/state-machine.service.ts',
  ]),
  branchName: new Set([
    'src/backend/orchestration/workspace-init.orchestrator.ts',
    'src/backend/interceptors/branch-rename.interceptor.ts',
    'src/backend/services/workspace/service/lifecycle/data.service.ts',
    'src/backend/services/workspace/service/lifecycle/state-machine.service.ts',
    'src/backend/services/github/service/pr-snapshot.service.ts',
  ]),
  isAutoGeneratedBranch: new Set([
    'src/backend/orchestration/workspace-init.orchestrator.ts',
    'src/backend/services/workspace/service/lifecycle/data.service.ts',
  ]),

  runScriptCommand: new Set([
    'src/backend/orchestration/workspace-init.orchestrator.ts',
    'src/backend/services/workspace/service/query/workspace-query.service.ts',
    'src/backend/services/workspace/service/lifecycle/data.service.ts',
  ]),
  runScriptPostRunCommand: new Set([
    'src/backend/orchestration/workspace-init.orchestrator.ts',
    'src/backend/services/workspace/service/query/workspace-query.service.ts',
    'src/backend/services/workspace/service/lifecycle/data.service.ts',
  ]),
  runScriptCleanupCommand: new Set([
    'src/backend/orchestration/workspace-init.orchestrator.ts',
    'src/backend/services/workspace/service/query/workspace-query.service.ts',
    'src/backend/services/workspace/service/lifecycle/data.service.ts',
  ]),
  runScriptPid: new Set([
    'src/backend/services/run-script/service/run-script-state-machine.service.ts',
  ]),
  runScriptPort: new Set([
    'src/backend/services/run-script/service/run-script-state-machine.service.ts',
  ]),
  runScriptStartedAt: new Set([
    'src/backend/services/run-script/service/run-script-state-machine.service.ts',
  ]),
  runScriptStatus: new Set([
    'src/backend/services/run-script/service/run-script-state-machine.service.ts',
  ]),

  mode: new Set(['src/backend/services/workspace/service/lifecycle/creation.service.ts']),
  autoIterationStatus: new Set([
    'src/backend/orchestration/domain-bridges.orchestrator.ts',
    'src/backend/server.ts',
  ]),
  autoIterationConfig: new Set(['src/backend/orchestration/domain-bridges.orchestrator.ts']),
  autoIterationProgress: new Set(['src/backend/orchestration/domain-bridges.orchestrator.ts']),
  autoIterationSessionId: new Set([
    'src/backend/orchestration/domain-bridges.orchestrator.ts',
    'src/backend/server.ts',
  ]),
};

const workspaceMutationDeniedFields = new Set([
  'id',
  'projectId',
  'createdAt',
  'updatedAt',
  'periodicTaskId',
  'parentWorkspaceId',
]);

const workspaceMutationRules = {
  update: { type: 'payload', payloadIndex: 1, requireStaticPayload: true },
  transitionWithCas: {
    type: 'payload',
    payloadIndex: 2,
    requireStaticPayload: false,
    fields: [
      'status',
      'initStartedAt',
      'initErrorMessage',
      'initCompletedAt',
      'initScriptPid',
      'worktreePath',
      'branchName',
    ],
  },
  casRunScriptStatusUpdate: {
    type: 'payload',
    payloadIndex: 2,
    requireStaticPayload: false,
    fields: ['runScriptStatus', 'runScriptPid', 'runScriptPort', 'runScriptStartedAt'],
  },
  startProvisioningRetryIfAllowed: {
    type: 'static',
    fields: ['status', 'initRetryCount', 'initStartedAt', 'initErrorMessage', 'initScriptPid'],
  },
  startProvisioningFromReadyIfAllowed: {
    type: 'static',
    fields: ['status', 'initRetryCount', 'initStartedAt', 'initErrorMessage', 'initScriptPid'],
  },
  resetToNewIfAllowed: {
    type: 'static',
    fields: [
      'status',
      'initRetryCount',
      'initStartedAt',
      'initCompletedAt',
      'initErrorMessage',
      'initScriptPid',
    ],
  },
  markHasHadSessions: { type: 'static', fields: ['hasHadSessions'] },
  recordRatchetSessionEnd: {
    type: 'static',
    fields: ['ratchetActiveSessionId', 'ratchetDispatchOutcome'],
  },
  recordRatchetDispatchIfEnabled: {
    type: 'static',
    fields: [
      'ratchetActiveSessionId',
      'ratchetLastCiRunId',
      'ratchetDispatchOutcome',
      'ratchetDispatchRetryCount',
    ],
  },
  adoptRatchetActiveSessionIfEnabled: {
    type: 'static',
    fields: ['ratchetActiveSessionId', 'ratchetDispatchOutcome'],
  },
  transitionRatchetStateIfEnabled: {
    type: 'static',
    fields: ['ratchetState', 'ratchetLastCheckedAt'],
  },
  settleRatchetIdleWhileDisabled: {
    type: 'static',
    fields: ['ratchetState', 'ratchetLastCheckedAt'],
  },
  appendInitOutput: { type: 'static', fields: ['initOutput'] },
  clearInitOutput: { type: 'static', fields: ['initOutput'] },
  setInitScriptPid: { type: 'static', fields: ['initScriptPid'] },
  clearInitScriptPid: { type: 'static', fields: ['initScriptPid'] },
  resetStaleRunScriptStatuses: {
    type: 'static',
    fields: ['runScriptStatus', 'runScriptPid', 'runScriptPort', 'runScriptStartedAt'],
  },
  resetStaleAutoIterationStatuses: {
    type: 'static',
    fields: ['autoIterationStatus', 'autoIterationSessionId'],
  },
};

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(entryPath);
    }
  }
  return files;
}

function isTestPath(relPath) {
  return (
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.test.tsx') ||
    relPath.endsWith('.stories.tsx') ||
    relPath.includes('/testing/')
  );
}

function getScriptKind(filePath) {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

function getPropertyName(nameNode) {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

function normalizePrismaType(typeText) {
  return typeText.replace(/[?\[\]]/g, '');
}

function collectPrismaEnums(schemaText) {
  const enums = new Set();
  const enumPattern = /^enum\s+(\w+)\s+\{/gm;
  let match;
  while ((match = enumPattern.exec(schemaText)) !== null) {
    enums.add(match[1]);
  }
  return enums;
}

function extractPrismaModelBody(schemaText, modelName) {
  const modelStart = schemaText.match(new RegExp(`^model\\s+${modelName}\\s+\\{`, 'm'));
  if (!modelStart || modelStart.index === undefined) {
    return null;
  }

  const bodyStart = modelStart.index + modelStart[0].length;
  const bodyEnd = schemaText.indexOf('\n}', bodyStart);
  if (bodyEnd === -1) {
    return null;
  }

  return schemaText.slice(bodyStart, bodyEnd);
}

function collectPrismaModelScalarFields(schemaText, modelName) {
  const enumNames = collectPrismaEnums(schemaText);
  const modelBody = extractPrismaModelBody(schemaText, modelName);
  if (modelBody === null) {
    return null;
  }

  const fields = new Set();
  for (const rawLine of modelBody.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('@@')) {
      continue;
    }

    const [fieldName, fieldType] = line.split(/\s+/);
    if (!fieldName || !fieldType || line.includes('@relation')) {
      continue;
    }

    const normalizedType = normalizePrismaType(fieldType);
    if (PRISMA_SCALAR_TYPES.has(normalizedType) || enumNames.has(normalizedType)) {
      fields.add(fieldName);
    }
  }

  return fields;
}

function mergeExtraction(into, next) {
  for (const key of next.fields) {
    into.fields.add(key);
  }
  into.dynamic = into.dynamic || next.dynamic;
  return into;
}

function extractObjectFields(expression) {
  if (ts.isParenthesizedExpression(expression)) {
    return extractObjectFields(expression.expression);
  }

  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return extractObjectFields(expression.expression);
  }

  if (ts.isConditionalExpression(expression)) {
    const whenTrue = extractObjectFields(expression.whenTrue);
    const whenFalse = extractObjectFields(expression.whenFalse);
    return mergeExtraction(whenTrue, whenFalse);
  }

  if (ts.isBinaryExpression(expression)) {
    if (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return extractObjectFields(expression.right);
    }
    return { fields: new Set(), dynamic: true };
  }

  if (!ts.isObjectLiteralExpression(expression)) {
    return { fields: new Set(), dynamic: true };
  }

  const result = { fields: new Set(), dynamic: false };

  for (const prop of expression.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = getPropertyName(prop.name);
      if (name) {
        result.fields.add(name);
      } else {
        result.dynamic = true;
      }
      continue;
    }

    if (ts.isShorthandPropertyAssignment(prop)) {
      result.fields.add(prop.name.text);
      continue;
    }

    if (ts.isSpreadAssignment(prop)) {
      mergeExtraction(result, extractObjectFields(prop.expression));
      continue;
    }

    result.dynamic = true;
  }

  return result;
}

function isWorkspaceAccessorCallReceiver(receiver) {
  if (ts.isIdentifier(receiver) && receiver.text === 'workspaceAccessor') {
    return true;
  }

  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
    receiver.name.text === 'workspaces'
  );
}

function getWorkspaceMutationCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }

  const method = node.expression.name.text;
  const rule = workspaceMutationRules[method];
  if (!rule) {
    return null;
  }

  if (!isWorkspaceAccessorCallReceiver(node.expression.expression)) {
    return null;
  }

  return { method, rule };
}

function checkRestrictedProcedures(relPath, sourceText, violations) {
  if (relPath === 'src/backend/trpc/workspace.trpc.ts') {
    const hasGenericWorkspaceUpdate = /^\s*update:\s*publicProcedure/m.test(sourceText);
    if (hasGenericWorkspaceUpdate) {
      violations.push(
        `${relPath}: generic workspace update mutation is forbidden; use intent-specific procedures.`
      );
    }
  }

  if (relPath === 'src/backend/trpc/session.trpc.ts') {
    const hasTerminalStatusWrite =
      /updateTerminalSession[\s\S]*status:\s*z\.nativeEnum/.test(sourceText) ||
      /updateTerminalSession[\s\S]*pid:\s*z\.number/.test(sourceText);
    if (hasTerminalStatusWrite) {
      violations.push(
        `${relPath}: updateTerminalSession must not accept status/pid writes from tRPC.`
      );
    }
  }
}

function checkOwnershipForFields(relPath, fields, violations) {
  for (const field of fields) {
    const owners = workspaceFieldOwners[field];
    if (owners) {
      if (!owners.has(relPath)) {
        const ownerList = Array.from(owners).join(', ');
        violations.push(
          `${relPath}: unauthorized write of workspace field "${field}". Allowed writer(s): ${ownerList}`
        );
      }
      continue;
    }

    if (workspaceMutationDeniedFields.has(field)) {
      violations.push(
        `${relPath}: workspace field "${field}" is not mutable through workspaceAccessor.`
      );
      continue;
    }

    violations.push(
      `${relPath}: workspace field "${field}" is missing an ownership policy in scripts/check-single-writer.mjs.`
    );
  }
}

function collectWorkspaceMutatingMethods(workspaceAccessorText, filePath = WORKSPACE_ACCESSOR_REL_PATH) {
  const sourceFile = ts.createSourceFile(
    filePath,
    workspaceAccessorText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const mutatingMethods = new Set();

  function methodCallsWorkspacePrismaWrite(node) {
    let writes = false;

    function visit(inner) {
      if (writes) {
        return;
      }

      if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
        const methodTarget = inner.expression.expression;
        if (
          ts.isPropertyAccessExpression(methodTarget) &&
          ts.isIdentifier(methodTarget.expression) &&
          methodTarget.expression.text === 'prisma' &&
          methodTarget.name.text === 'workspace' &&
          (inner.expression.name.text === 'update' || inner.expression.name.text === 'updateMany')
        ) {
          writes = true;
          return;
        }

        if (
          ts.isIdentifier(methodTarget) &&
          methodTarget.text === 'prisma' &&
          inner.expression.name.text === '$executeRaw'
        ) {
          writes = true;
          return;
        }
      }

      if (ts.isTaggedTemplateExpression(inner) && ts.isPropertyAccessExpression(inner.tag)) {
        const methodTarget = inner.tag.expression;
        if (
          ts.isIdentifier(methodTarget) &&
          methodTarget.text === 'prisma' &&
          inner.tag.name.text === '$executeRaw'
        ) {
          writes = true;
          return;
        }
      }

      ts.forEachChild(inner, visit);
    }

    visit(node);
    return writes;
  }

  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.body && ts.isIdentifier(node.name)) {
      if (methodCallsWorkspacePrismaWrite(node.body)) {
        mutatingMethods.add(node.name.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return mutatingMethods;
}

function checkWorkspaceMutatorCoverage({ rootDir, violations }) {
  const accessorPath = path.join(rootDir, WORKSPACE_ACCESSOR_REL_PATH);
  const accessorText = readFileSync(accessorPath, 'utf8');
  const discovered = collectWorkspaceMutatingMethods(accessorText, accessorPath);
  const configured = new Set(Object.keys(workspaceMutationRules));

  const missingRules = Array.from(discovered)
    .filter((method) => !configured.has(method))
    .sort();
  if (missingRules.length > 0) {
    violations.push(
      `${WORKSPACE_ACCESSOR_REL_PATH}: workspace mutator(s) missing from checker rules: ${missingRules.join(', ')}`
    );
  }

  const staleRules = Array.from(configured)
    .filter((method) => !discovered.has(method))
    .sort();
  if (staleRules.length > 0) {
    violations.push(
      `${WORKSPACE_ACCESSOR_REL_PATH}: checker has stale mutator rule(s): ${staleRules.join(', ')}`
    );
  }
}

function checkWorkspaceSchemaCoverage({ rootDir, violations }) {
  const schemaPath = path.join(rootDir, PRISMA_SCHEMA_REL_PATH);
  const schemaText = readFileSync(schemaPath, 'utf8');
  const workspaceFields = collectPrismaModelScalarFields(schemaText, 'Workspace');
  if (workspaceFields === null) {
    violations.push(`${PRISMA_SCHEMA_REL_PATH}: missing Workspace model.`);
    return;
  }

  const policyFields = new Set([
    ...Object.keys(workspaceFieldOwners),
    ...Array.from(workspaceMutationDeniedFields),
  ]);

  const missingPolicy = Array.from(workspaceFields)
    .filter((field) => !policyFields.has(field))
    .sort();
  if (missingPolicy.length > 0) {
    violations.push(
      `${PRISMA_SCHEMA_REL_PATH}: Workspace field(s) missing ownership policy: ${missingPolicy.join(', ')}`
    );
  }

  const stalePolicy = Array.from(policyFields)
    .filter((field) => !workspaceFields.has(field))
    .sort();
  if (stalePolicy.length > 0) {
    violations.push(
      `${PRISMA_SCHEMA_REL_PATH}: stale Workspace ownership policy field(s): ${stalePolicy.join(', ')}`
    );
  }
}

function checkSourceText(relPath, sourceText, violations) {
  checkRestrictedProcedures(relPath, sourceText, violations);

  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(relPath)
  );

  function visit(node) {
    const mutationCall = getWorkspaceMutationCall(node);
    if (mutationCall) {
      if (mutationCall.rule.type === 'payload') {
        const payload = node.arguments[mutationCall.rule.payloadIndex];
        if (!payload) {
          violations.push(
            `${relPath}: workspaceAccessor.${mutationCall.method} call is missing payload argument.`
          );
        } else {
          const extraction = extractObjectFields(payload);
          if (extraction.dynamic && mutationCall.rule.requireStaticPayload) {
            violations.push(
              `${relPath}: workspaceAccessor.${mutationCall.method} payload must be statically analyzable object literal.`
            );
          }
          const fieldsToCheck =
            extraction.dynamic && mutationCall.rule.fields
              ? new Set(mutationCall.rule.fields)
              : extraction.fields;
          checkOwnershipForFields(relPath, fieldsToCheck, violations);
        }
      } else {
        checkOwnershipForFields(relPath, mutationCall.rule.fields, violations);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function checkFile(filePath, rootDir, violations) {
  const relPath = path.relative(rootDir, filePath).replaceAll(path.sep, '/');
  if (isTestPath(relPath)) {
    return;
  }

  const sourceText = readFileSync(filePath, 'utf8');
  checkSourceText(relPath, sourceText, violations);
}

export function collectSingleWriterViolations({
  rootDir = process.cwd(),
  backendDir = path.join(rootDir, 'src/backend'),
} = {}) {
  const violations = [];
  checkWorkspaceSchemaCoverage({ rootDir, violations });
  checkWorkspaceMutatorCoverage({ rootDir, violations });

  const sourceFiles = collectSourceFiles(backendDir);
  for (const filePath of sourceFiles) {
    checkFile(filePath, rootDir, violations);
  }

  return violations;
}

function reportViolations(violations) {
  if (violations.length === 0) {
    return;
  }

  console.error('Single-writer ownership violations found:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
}

export function runSingleWriterCheck(options = {}) {
  const violations = collectSingleWriterViolations(options);
  reportViolations(violations);
  return violations.length === 0;
}

function isExecutedDirectly() {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  return path.resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isExecutedDirectly()) {
  const passed = runSingleWriterCheck();
  if (!passed) {
    process.exit(1);
  }
}
