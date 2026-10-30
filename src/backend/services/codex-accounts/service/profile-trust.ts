import { lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

const projectsSchema = z.record(z.string(), z.unknown());
const trustSchema = z.object({ trust_level: z.enum(['trusted', 'untrusted']) });
const pending = new Map<string, Promise<void>>();

/** Project trust is a local repository decision, independent of ChatGPT identity. */
export async function inheritProjectTrust(nativeHome: string, managedHome: string): Promise<void> {
  if (nativeHome === managedHome) {
    return;
  }
  const previous = pending.get(managedHome) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => inherit(nativeHome, managedHome));
  pending.set(managedHome, operation);
  try {
    await operation;
  } finally {
    if (pending.get(managedHome) === operation) {
      pending.delete(managedHome);
    }
  }
}

async function inherit(nativeHome: string, managedHome: string): Promise<void> {
  let nativeText: string;
  try {
    nativeText = await readFile(join(nativeHome, 'config.toml'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const configPath = join(managedHome, 'config.toml');
  if ((await lstat(configPath)).isSymbolicLink()) {
    throw new Error('Managed Codex project trust config cannot be a symlink');
  }
  const text = await readFile(configPath, 'utf8');
  let updated: string;
  try {
    const native = parse(nativeText);
    const managed = parse(text);
    const source = projectsSchema.parse(native.projects ?? {});
    const existing = projectsSchema.parse(managed.projects ?? {});
    const missing = Object.fromEntries(
      Object.entries(source).flatMap(([path, value]) => {
        const trust = trustSchema.safeParse(value);
        return !Object.hasOwn(existing, path) && trust.success ? [[path, trust.data]] : [];
      })
    );
    if (Object.keys(missing).length === 0) {
      return;
    }
    // Keep comments and formatting for ordinary table configs. Inline project
    // tables cannot be extended with headers, so serialize that case as TOML.
    updated = `${text}\n${stringify({ projects: missing })}`;
    try {
      parse(updated);
    } catch {
      updated = stringify({ ...managed, projects: { ...existing, ...missing } });
    }
  } catch {
    // Parser diagnostics can contain private config values. Keep them local.
    throw new Error('Unable to inherit Codex project trust; check native and managed config.toml');
  }
  const stage = await mkdtemp(join(managedHome, '.project-trust-'));
  try {
    const stagedConfig = join(stage, 'config.toml');
    await writeFile(stagedConfig, updated, { mode: 0o600 });
    await rename(stagedConfig, configPath);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
