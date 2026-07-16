import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const repositoryRoot = process.cwd();
const thisFile = 'src/lib/icon-library.test.ts';
const lucidePackage = ['lucide', 'react'].join('-');
const lucideClassPrefix = ['lucide', ''].join('-');
const lucideIconType = ['Lucide', 'Icon'].join('');
const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});
const phosphorImportPattern = /import\s*{([\s\S]*?)}\s*from\s*['"]@phosphor-icons\/react['"]/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('icon library', () => {
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
          .filter((icon) => /\bfill-[\w-]+/.test(icon) && !/weight=["']fill["']/.test(icon))
          .map(() => `${relative(repositoryRoot, path)}: ${name}`);
      });
    });

    expect(legacyFillClasses).toEqual([]);

    const iconGuidance = readFileSync(
      join(repositoryRoot, 'docs/design/ratchet-ux-simplification-plan.md'),
      'utf8'
    );
    expect(iconGuidance).not.toContain(lucidePackage);
  });
});
