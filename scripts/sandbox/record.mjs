// sandbox.json: what a running sandbox is, and what `--clean` trusts.
import { mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const sandboxRecordSchema = z
  .object({
    baseDir: z.string().min(1),
    frontendUrl: z.string().nullable(),
    backendUrl: z.string().nullable(),
    /** The launcher, identified by pid and start time. */
    pid: z.number().int().gt(1),
    pidStartedAt: z.string().min(1),
    /** The server's process group and its leader's start time; null until it is started. */
    pgid: z.number().int().gt(1).nullable(),
    pgidStartedAt: z.string().min(1).nullable(),
    egressPort: z.number().int().positive().nullable(),
    projectId: z.string().nullable(),
    repoPath: z.string(),
    scenario: z.string(),
  })
  .refine((record) => (record.pgid === null) === (record.pgidStartedAt === null), {
    message: 'pgid and pgidStartedAt are set together',
  });

export function readSandboxRecord(file) {
  try {
    const parsed = sandboxRecordSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeSandboxRecord(file, record) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * Creates a sandbox directory under `root` and, before anything else happens,
 * its provisional record (no server yet), so `--clean` can always find it.
 */
export function createSandboxDirectory(root, launcher, scenario) {
  const baseDir = realpathSync(mkdtempSync(join(root, 'sb-')));
  writeSandboxRecord(join(baseDir, 'sandbox.json'), {
    baseDir,
    frontendUrl: null,
    backendUrl: null,
    pid: launcher.pid,
    pidStartedAt: launcher.startedAt,
    pgid: null,
    pgidStartedAt: null,
    egressPort: null,
    projectId: null,
    repoPath: join(baseDir, 'repo'),
    scenario,
  });
  return baseDir;
}
