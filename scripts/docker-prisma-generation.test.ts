import { execFileSync, execSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';

it('builds the Docker client after source copy without requiring generation in deps', () => {
  const root = resolve(import.meta.dirname, '..');
  const directory = mkdtempSync(join(tmpdir(), 'ff-docker-prisma-'));
  const deps = join(directory, 'deps');
  const builder = join(directory, 'builder');
  try {
    // The dependency stage has no source tree, so postinstall only prepares natives.
    mkdirSync(join(deps, 'scripts'), { recursive: true });
    mkdirSync(join(deps, 'node_modules'));
    copyFileSync(join(root, 'scripts/postinstall.mjs'), join(deps, 'scripts/postinstall.mjs'));
    execFileSync(process.execPath, [join(deps, 'scripts/postinstall.mjs')], { cwd: deps });
    expect(existsSync(join(deps, 'prisma/generated'))).toBe(false);

    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const builderStage = dockerfile.split(/^FROM base AS builder\s*$/m)[1]?.split(/^FROM /m)[0];
    if (!builderStage) {
      throw new Error('Docker builder stage is missing');
    }
    // Execute the real stage-transfer contract against the available deps artifacts.
    // A COPY of an ungenerated client must fail here just as it would in Docker.
    for (const match of builderStage.matchAll(/^COPY --from=deps (\S+) (\S+)$/gm)) {
      const [, source, destination] = match;
      cpSync(join(deps, relative('/app', source!)), join(builder, destination!), {
        recursive: true,
      });
    }

    // COPY . . supplies these real generation inputs, with no pre-generated client.
    for (const source of [
      'package.json',
      'prisma.config.ts',
      'prisma/schema.prisma',
      'src/backend/lib/env.ts',
    ]) {
      const destination = join(builder, source);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, source), destination);
    }
    rmSync(join(builder, 'node_modules'), { recursive: true, force: true });
    symlinkSync(join(root, 'node_modules'), join(builder, 'node_modules'), 'junction');
    const manifest = z
      .object({ scripts: z.object({ build: z.string() }) })
      .parse(JSON.parse(readFileSync(join(builder, 'package.json'), 'utf8')));
    const [prepareBuild] = manifest.scripts.build.split(' && ');
    execSync(prepareBuild!, { cwd: builder, stdio: 'pipe', timeout: 20_000 });
    expect(readFileSync(join(builder, 'prisma/generated/client.ts'), 'utf8')).toContain(
      'PrismaClient'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // The Prisma subprocess has a 20-second deadline; include setup and cleanup.
}, 30_000);
