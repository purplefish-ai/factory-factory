import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  allowedPhosphorWeights,
  type PhosphorWeight,
  phosphorWeightAllowlist,
  phosphorWeights,
} from '../../scripts/phosphor-icon-weights';

const repositoryRoot = process.cwd();
const thisFile = 'src/lib/icon-library.test.ts';
const lucidePackage = ['lucide', 'react'].join('-');
const lucideClassPrefix = ['lucide', ''].join('-');
const lucideIconType = ['Lucide', 'Icon'].join('');
const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});
const phosphorImportPattern =
  /import(?:\s+type)?\s*{([^{}]*)}\s*from\s*['"]@phosphor-icons\/react(?:\/dist\/(?:csr|lib)\/[^'"]+)?['"]/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

function literalWeights(node: ts.Node | undefined): string[] | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return [node.text];
  }
  if (node && (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node))) {
    return literalWeights(node.expression);
  }
  if (node && ts.isConditionalExpression(node)) {
    const whenTrue = literalWeights(node.whenTrue);
    const whenFalse = literalWeights(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
  }
  return undefined;
}

/**
 * Statically resolve which Phosphor icon renders which weight. A weight on a
 * non-icon tag (such as a dynamic `<Icon />`) applies to every icon the file imports.
 */
function phosphorWeightUsage(source: string, file: string) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const icons = new Map<string, string>();
  const uses: string[] = [];
  const violations: string[] = [];
  const at = (node: ts.Node) =>
    `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  for (const statement of sourceFile.statements) {
    if (!(ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('@phosphor-icons/react')) {
      continue;
    }
    const icon = /^@phosphor-icons\/react\/dist\/csr\/([A-Za-z0-9]+)$/.exec(specifier)?.[1];
    const bindings = statement.importClause?.namedBindings;
    if (icon && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        icons.set(element.name.text, icon);
      }
    } else if (specifier !== '@phosphor-icons/react/dist/lib/types') {
      violations.push(`${at(statement)}: import Phosphor icons from dist/csr/<Name> only`);
    }
  }

  const recordWeightAttribute = (node: ts.JsxAttribute) => {
    const tag = node.parent.parent.tagName.getText(sourceFile);
    const weights = literalWeights(node.initializer);
    const tagIcon = icons.get(tag);
    const targets = tagIcon ? [tagIcon] : [...new Set(icons.values())];
    if (!weights) {
      violations.push(`${at(node)}: weight must be a string literal or literal conditional`);
    } else if (targets.length === 0) {
      violations.push(`${at(node)}: weight on <${tag}> is not a Phosphor icon in this file`);
    } else {
      uses.push(...targets.flatMap((icon) => weights.map((weight) => `${icon}:${weight}`)));
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'weight') {
      recordWeightAttribute(node);
    } else if (
      icons.size > 0 &&
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      node.name.getText(sourceFile) === 'weight'
    ) {
      violations.push(`${at(node)}: pass Phosphor weights as JSX attributes`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { uses, violations };
}

function isPhosphorWeight(weight: string): weight is PhosphorWeight {
  return phosphorWeights.some((known) => known === weight);
}

function hasFillWeight(icon: string): boolean {
  return /weight\s*=\s*(?:["']fill["']|\{\s*["']fill["']\s*\})/.test(icon);
}

describe('icon library', () => {
  it('does not include named imports preceding a Phosphor import', () => {
    const source = [
      "import { DayPicker } from '@daypicker/react';",
      "import { CaretDownIcon } from '@phosphor-icons/react';",
    ].join('\n');
    expect([...source.matchAll(phosphorImportPattern)].map((match) => match[1]?.trim())).toEqual([
      'CaretDownIcon',
    ]);
  });

  it('recognizes direct icon and type imports without capturing preceding modules', () => {
    const source = [
      "import { DayPicker } from '@daypicker/react';",
      "import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';",
      "import type { Icon } from '@phosphor-icons/react/dist/lib/types';",
    ].join('\n');
    expect([...source.matchAll(phosphorImportPattern)].map((match) => match[1]?.trim())).toEqual([
      'CheckIcon',
      'Icon',
    ]);
  });

  it('loads individual Phosphor modules instead of the package barrel', () => {
    const imports = sourceFiles(join(repositoryRoot, 'src'))
      .filter((path) => relative(repositoryRoot, path) !== thisFile)
      .filter((path) => /from\s*['"]@phosphor-icons\/react['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repositoryRoot, path));
    expect(imports).toEqual([]);
  });

  it('recognizes literal and expression forms of the Phosphor fill weight', () => {
    expect(hasFillWeight('<CircleIcon weight="fill" />')).toBe(true);
    expect(hasFillWeight("<CircleIcon weight='fill' />")).toBe(true);
    expect(hasFillWeight("<CircleIcon weight={'fill'} />")).toBe(true);
    expect(hasFillWeight('<CircleIcon weight={"fill"} />')).toBe(true);
    expect(hasFillWeight('<CircleIcon weight="regular" />')).toBe(false);
  });

  it('resolves Phosphor weights per icon and rejects unverifiable weights', () => {
    const source = [
      "import { CheckIcon as DoneIcon } from '@phosphor-icons/react/dist/csr/Check';",
      "import { LeafIcon } from '@phosphor-icons/react/dist/csr/Leaf';",
      'const a = <DoneIcon weight="fill" />;',
      "const b = <LeafIcon weight={on ? 'bold' : `thin`} />;",
      'const c = <Icon weight="duotone" />;',
      'const d = <DoneIcon weight={weight} />;',
      "const e = createElement(DoneIcon, { weight: 'fill' });",
    ].join('\n');
    expect(phosphorWeightUsage(source, 'sample.tsx')).toEqual({
      uses: ['Check:fill', 'Leaf:bold', 'Leaf:thin', 'Check:duotone', 'Leaf:duotone'],
      violations: [
        'sample.tsx:6: weight must be a string literal or literal conditional',
        'sample.tsx:7: pass Phosphor weights as JSX attributes',
      ],
    });
    expect(
      phosphorWeightUsage(
        'import { CircleIcon } from \'@phosphor-icons/react/dist/ssr/Circle\';\n<Box weight="fill" />',
        'other.tsx'
      ).violations
    ).toEqual([
      'other.tsx:1: import Phosphor icons from dist/csr/<Name> only',
      'other.tsx:2: weight on <Box> is not a Phosphor icon in this file',
    ]);
  });

  it('renders only Phosphor weights that the build keeps', () => {
    const files = sourceFiles(join(repositoryRoot, 'src')).filter(
      (path) => relative(repositoryRoot, path) !== thisFile
    );
    const usage = files.map((path) =>
      phosphorWeightUsage(readFileSync(path, 'utf8'), relative(repositoryRoot, path))
    );
    expect(usage.flatMap(({ violations }) => violations)).toEqual([]);

    const uses = new Set(usage.flatMap(({ uses }) => uses));
    const disallowed = [...uses].filter((use) => {
      const [icon = '', weight = ''] = use.split(':');
      return !(isPhosphorWeight(weight) && allowedPhosphorWeights(icon).has(weight));
    });
    // Add the icon to phosphorWeightAllowlist in scripts/phosphor-icon-weights.ts.
    expect(disallowed).toEqual([]);

    const unused = Object.entries(phosphorWeightAllowlist).flatMap(([weight, icons = []]) =>
      icons.filter((icon) => !uses.has(`${icon}:${weight}`)).map((icon) => `${icon}:${weight}`)
    );
    expect(unused).toEqual([]);
  });

  it('uses Phosphor without active Lucide references', () => {
    const packageJson = packageJsonSchema.parse(
      JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
    );

    expect(packageJson.dependencies?.['@phosphor-icons/react']).toBeDefined();
    expect(packageJson.dependencies?.[lucidePackage]).toBeUndefined();

    const violations = sourceFiles(join(repositoryRoot, 'src'))
      .filter((path) => relative(repositoryRoot, path) !== thisFile)
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return source.includes(lucidePackage) ||
          source.includes(lucideIconType) ||
          source.includes(lucideClassPrefix)
          ? [relative(repositoryRoot, path)]
          : [];
      });

    expect(violations).toEqual([]);

    const deprecatedPhosphorImports = sourceFiles(join(repositoryRoot, 'src')).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(phosphorImportPattern)].flatMap((match) => {
        const importedNames = match[1];
        return importedNames
          ? importedNames
              .split(',')
              .map((name) => name.trim().replace(/^type\s+/, ''))
              .filter(Boolean)
              .filter((name) => name !== 'Icon' && !name.endsWith('Icon'))
              .map((name) => `${relative(repositoryRoot, path)}: ${name}`)
          : [];
      });
    });

    expect(deprecatedPhosphorImports).toEqual([]);

    const legacyFillClasses = sourceFiles(join(repositoryRoot, 'src')).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const importedIconNames = [...source.matchAll(phosphorImportPattern)].flatMap((match) =>
        (match[1] ?? '')
          .split(',')
          .map((name) =>
            name
              .trim()
              .replace(/^type\s+/, '')
              .split(/\s+as\s+/)
              .at(-1)
          )
          .filter((name): name is string => Boolean(name && name !== 'Icon'))
      );

      return importedIconNames.flatMap((name) => {
        const iconPattern = new RegExp(`<${name}\\b[\\s\\S]*?\\/>`, 'g');
        return [...source.matchAll(iconPattern)]
          .map((match) => match[0])
          .filter((icon) => /\bfill-[\w-]+/.test(icon) && !hasFillWeight(icon))
          .map(() => `${relative(repositoryRoot, path)}: ${name}`);
      });
    });

    expect(legacyFillClasses).toEqual([]);

    const iconGuidance = readFileSync(
      join(repositoryRoot, 'docs/design/archive/ratchet-ux-simplification-plan.md'),
      'utf8'
    );
    expect(iconGuidance).not.toContain(lucidePackage);
  });
});
