import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, expect, it } from 'vitest';
import { resolveAccountContext } from './profile';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'ff-profile-trust-'));
  directories.push(base);
  const native = join(base, 'native');
  await mkdir(native);
  const row = {
    id: 'managed',
    kind: 'MANAGED' as const,
    label: 'Managed',
    enabled: true,
    identityKey: null,
  };
  const config = {
    getBaseDir: () => base,
    getCodexHome: () => native,
    getCodexSessionsDir: () => join(native, 'sessions'),
    getChildProcessEnv: () => ({}),
  };
  const managed = join(base, 'codex-accounts', row.id, 'config.toml');
  return { row, config, native, managed };
}

it('inherits native project trust for new managed homes without copying other settings', async () => {
  const h = await fixture();
  await writeFile(
    join(h.native, 'config.toml'),
    `model = "native-model"\n[projects."/repos/iron-fillet"]\ntrust_level = "trusted"\n[projects."/repos/blocked"]\ntrust_level = "untrusted"\n`
  );
  await resolveAccountContext(h.row, h.config);
  const text = await readFile(h.managed, 'utf8');
  expect(text).toContain('[projects."/repos/iron-fillet"]');
  expect(text).toContain('trust_level = "trusted"');
  expect(text).toContain('[projects."/repos/blocked"]');
  expect(text).toContain('trust_level = "untrusted"');
  expect(text).toContain('cli_auth_credentials_store = "file"');
  expect(text).not.toContain('native-model');
  if (process.platform !== 'win32') {
    expect((await stat(h.managed)).mode & 0o777).toBe(0o600);
  }
});

it('repairs existing profiles on resume, preserving explicit trust and unrelated config', async () => {
  const h = await fixture();
  await resolveAccountContext(h.row, h.config);
  const original = `# Private profile\ncli_auth_credentials_store = "file"\nmodel = "managed-model"\n[projects."/repos/blocked"]\ntrust_level = "untrusted"\n`;
  await writeFile(h.managed, original);
  await writeFile(
    join(h.native, 'config.toml'),
    `[projects."/repos/new"]\ntrust_level = "trusted"\n[projects."/repos/blocked"]\ntrust_level = "trusted"\n`
  );
  await Promise.all(Array.from({ length: 4 }, () => resolveAccountContext(h.row, h.config)));
  const text = await readFile(h.managed, 'utf8');
  expect(text).toContain(original);
  expect(text.match(/\[projects\."\/repos\/new"\]/g)).toHaveLength(1);
  expect(text).toContain('[projects."/repos/blocked"]\ntrust_level = "untrusted"');
  await resolveAccountContext(h.row, h.config);
  expect(await readFile(h.managed, 'utf8')).toBe(text);
});

it('handles inline project tables and quoted paths as TOML', async () => {
  const h = await fixture();
  await resolveAccountContext(h.row, h.config);
  await writeFile(
    h.managed,
    'cli_auth_credentials_store = "file"\nprojects = { "/repos/blocked" = { trust_level = "untrusted" } }\n'
  );
  await writeFile(
    join(h.native, 'config.toml'),
    `[projects.'C:\\repos\\quoted"name']\ntrust_level = "trusted"\n`
  );
  await resolveAccountContext(h.row, h.config);
  expect(parse(await readFile(h.managed, 'utf8')).projects).toEqual({
    '/repos/blocked': { trust_level: 'untrusted' },
    'C:\\repos\\quoted"name': { trust_level: 'trusted' },
  });
});

it('leaves the managed config intact when native config is invalid', async () => {
  const h = await fixture();
  await resolveAccountContext(h.row, h.config);
  const original = await readFile(h.managed, 'utf8');
  await writeFile(join(h.native, 'config.toml'), 'not valid TOML');
  await expect(resolveAccountContext(h.row, h.config)).rejects.toThrow('project trust');
  expect(await readFile(h.managed, 'utf8')).toBe(original);
});
