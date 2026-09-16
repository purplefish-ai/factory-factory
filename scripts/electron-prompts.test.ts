import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

it('loads the Ratchet template from the unpacked Electron backend layout', () => {
  const root = resolve(import.meta.dirname, '..');
  const config = z
    .object({ files: z.array(z.string()), asarUnpack: z.array(z.string()) })
    .parse(parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')));
  const resources = mkdtempSync(join(tmpdir(), 'ff-electron-prompts-'));
  try {
    const unpackedRoot = join(resources, 'app.asar.unpacked');
    const modulePath = 'dist/src/backend/prompts/ratchet-dispatch.js';
    const templatePath = 'dist/prompts/ratchet/dispatch.md';
    const files = [
      { path: modulePath, source: 'src/backend/prompts/ratchet-dispatch.ts' },
      { path: templatePath, source: 'prompts/ratchet/dispatch.md' },
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
    writeFileSync(join(unpackedRoot, 'package.json'), '{"type":"module"}');
    const moduleUrl = pathToFileURL(join(unpackedRoot, modulePath)).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { buildRatchetDispatchPrompt } from ${JSON.stringify(moduleUrl)};
       console.log(buildRatchetDispatchPrompt('https://github.com/example/repo/pull/42', 42));`,
      ],
      { encoding: 'utf8' }
    );
    expect(output).toContain('https://github.com/example/repo/pull/42');
    expect(output).toContain('Reply to unaddressed review feedback');
    expect(output).not.toMatch(/\{\{[A-Z_]+\}\}/);
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});
