// sandbox.json: what a running sandbox is, and what `--clean` trusts.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const sandboxRecordSchema = z.object({
  baseDir: z.string().min(1),
  frontendUrl: z.string().nullable(),
  backendUrl: z.string().nullable(),
  pid: z.number().int().gt(1),
  pgid: z.number().int().gt(1),
  projectId: z.string().nullable(),
  repoPath: z.string(),
  scenario: z.string(),
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
