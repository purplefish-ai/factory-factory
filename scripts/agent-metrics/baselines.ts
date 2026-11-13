import ts from 'typescript';
import { z } from 'zod';
import { parseUnusedCodeBaseline } from '../check-unused-code';
import type { TreeFile } from './tree';

export const sessionModulesPath = 'src/backend/services/session/modules.ts';

/** Each custom lint rule's exception map: path → reason. */
export function isLintRuleExceptionsFile(path: string): boolean {
  return /^lint-rules\/rules\/[^/]+\.exceptions\.json$/.test(path);
}

const lintRuleExceptionsSchema = z.record(z.string(), z.string());

/** Entries across every lint rule's exceptions file; a file that is not a path-to-reason record fails. */
function lintRuleExceptionCount(files: readonly TreeFile[]): number {
  return files.reduce((total, file) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch (error) {
      throw new Error(`${file.path} is not JSON: ${String(error)}`);
    }
    const exceptions = lintRuleExceptionsSchema.safeParse(parsed);
    if (!exceptions.success) {
      throw new Error(`${file.path} is not a path-to-reason record: ${exceptions.error.message}`);
    }
    return total + Object.keys(exceptions.data).length;
  }, 0);
}

const fileLengthBaselineSchema = z.record(z.string(), z.number().int());

export type BaselineSizes = {
  unusedCodeProduction: number;
  unusedCodeExports: number;
  fileLength: number;
  /** Entries across `lint-rules/rules/*.exceptions.json`. */
  lintRuleExceptions: number;
};

export function baselineSizes(
  unusedCodeBaseline: unknown,
  fileLengthBaseline: unknown,
  lintRuleExceptionFiles: readonly TreeFile[]
): BaselineSizes {
  const unusedCode = parseUnusedCodeBaseline(unusedCodeBaseline);
  return {
    unusedCodeProduction: Object.keys(unusedCode.production).length,
    unusedCodeExports: Object.keys(unusedCode.exports).length,
    fileLength: Object.keys(fileLengthBaselineSchema.parse(fileLengthBaseline)).length,
    lintRuleExceptions: lintRuleExceptionCount(lintRuleExceptionFiles),
  };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

/** Length of the exported `sessionModuleCycles` array; `null` while the file is absent. */
export function sessionModuleCycleCount(source: string | null): number | null {
  if (source === null) {
    return null;
  }
  const file = ts.createSourceFile(sessionModulesPath, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'sessionModuleCycles' &&
        declaration.initializer
      ) {
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isArrayLiteralExpression(initializer)) {
          return initializer.elements.length;
        }
      }
    }
  }
  throw new Error(`${sessionModulesPath} has no sessionModuleCycles array literal.`);
}
