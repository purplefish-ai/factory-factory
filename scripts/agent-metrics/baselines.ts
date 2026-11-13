import ts from 'typescript';
import { z } from 'zod';
import { parseUnusedCodeBaseline } from '../check-unused-code';

export const sessionModulesPath = 'src/backend/services/session/modules.ts';

const exceptionsSchema = z.record(z.string(), z.string());

/** Entries in every `exceptions` object of a lint configuration (`.oxlintrc.json`). */
export function lintExceptionEntries(config: unknown): number {
  if (Array.isArray(config)) {
    return config.reduce<number>((total, item) => total + lintExceptionEntries(item), 0);
  }
  if (typeof config !== 'object' || config === null) {
    return 0;
  }
  return Object.entries(config).reduce<number>(
    (total, [key, value]) =>
      total +
      (key === 'exceptions'
        ? Object.keys(exceptionsSchema.parse(value)).length
        : lintExceptionEntries(value)),
    0
  );
}

const fileLengthBaselineSchema = z.record(z.string(), z.number().int());

export type BaselineSizes = {
  unusedCodeProduction: number;
  unusedCodeExports: number;
  fileLength: number;
  lintExceptions: number;
};

export function baselineSizes(
  unusedCodeBaseline: unknown,
  fileLengthBaseline: unknown,
  lintConfig: unknown
): BaselineSizes {
  const unusedCode = parseUnusedCodeBaseline(unusedCodeBaseline);
  return {
    unusedCodeProduction: Object.keys(unusedCode.production).length,
    unusedCodeExports: Object.keys(unusedCode.exports).length,
    fileLength: Object.keys(fileLengthBaselineSchema.parse(fileLengthBaseline)).length,
    lintExceptions: lintExceptionEntries(lintConfig),
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
