import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

it('loads the adversarial review template from the unpacked Electron backend layout', () => {
  const root = resolve(import.meta.dirname, '..');
  const config = z
    .object({ files: z.array(z.string()), asarUnpack: z.array(z.string()) })
    .parse(parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')));
  const resources = mkdtempSync(join(tmpdir(), 'ff-electron-prompts-'));
  try {
    const unpackedRoot = join(resources, 'app.asar.unpacked');
    const modulePath = 'dist/src/backend/prompts/adversarial-review-dispatch.js';
    const templatePath = 'dist/prompts/adversarial-review/dispatch.md';
    const files = [
      { path: modulePath, source: 'src/backend/prompts/adversarial-review-dispatch.ts' },
      { path: templatePath, source: 'prompts/adversarial-review/dispatch.md' },
    ];
    for (const file of files) {
      const included =
        config.files.some(
          (pattern) => !pattern.startsWith('!') && matchesGlob(file.path, pattern)
        ) &&
        !config.files.some(
          (pattern) => pattern.startsWith('!') && matchesGlob(file.path, pattern.slice(1))
        );
      const unpacked = config.asarUnpack.some((pattern) => matchesGlob(file.path, pattern));
      if (!(included && unpacked)) {
        continue;
      }
      const destination = join(unpackedRoot, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      if (file.path === modulePath) {
        const source = readFileSync(join(root, file.source), 'utf8');
        writeFileSync(
          destination,
          ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
          }).outputText
        );
      } else {
        cpSync(join(root, file.source), destination);
      }
    }
    // The unpacked backend has no package.json; do not supply a test-only ESM scope.
    const moduleUrl = pathToFileURL(join(unpackedRoot, modulePath)).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { buildAdversarialReviewDispatchPrompt } from ${JSON.stringify(moduleUrl)};
       console.log(buildAdversarialReviewDispatchPrompt({ prUrl: 'https://github.com/example/repo/pull/42', prNumber: 42, prDescription: 'description', prDiff: 'diff', existingReviewCommentsSummary: 'none' }));`,
      ],
      { encoding: 'utf8' }
    );
    expect(output).toContain('https://github.com/example/repo/pull/42');
    expect(output).toContain('description');
    expect(output).not.toMatch(/\{\{[A-Z_]+\}\}/);
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});
