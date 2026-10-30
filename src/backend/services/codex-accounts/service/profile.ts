import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inheritProjectTrust } from './profile-trust';
import type { AccountConfig, AccountRow, CodexRuntimeContext } from './types';

export async function resolveAccountContext(
  row: AccountRow,
  config: AccountConfig
): Promise<CodexRuntimeContext> {
  const env = config.getChildProcessEnv();
  if (row.kind === 'NATIVE_DEFAULT') {
    return {
      accountId: row.id,
      homeDir: config.getCodexHome(),
      sessionsDir: config.getCodexSessionsDir(),
      env,
    };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(row.id)) {
    throw new Error('Invalid Codex profile identifier');
  }
  const root = join(config.getBaseDir(), 'codex-accounts');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) {
    throw new Error('Codex profile directory cannot be a symlink');
  }
  await chmod(root, 0o700);
  const homeDir = join(root, row.id);
  await mkdir(homeDir, { mode: 0o700, recursive: true });
  if ((await lstat(homeDir)).isSymbolicLink()) {
    throw new Error('Codex profile directory cannot be a symlink');
  }
  await chmod(homeDir, 0o700);
  // Native credentials stay in this OS-user-only home. Never copy auth.json.
  await writeFile(join(homeDir, 'config.toml'), 'cli_auth_credentials_store = "file"\n', {
    flag: 'wx',
    mode: 0o600,
  }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  });
  const configPath = join(homeDir, 'config.toml');
  if ((await lstat(configPath)).isSymbolicLink()) {
    throw new Error('Managed Codex credential store config cannot be a symlink');
  }
  const text = await readFile(configPath, 'utf8');
  const declarations = text
    .split('\n')
    .filter((line) =>
      /^\s*(?:cli_auth_credentials_store|["']cli_auth_credentials_store["'])\s*=/.test(line)
    );
  const rootConfig = text.split(/^\s*\[/m)[0] ?? '';
  if (
    declarations.length !== 1 ||
    !/^\s*(?:cli_auth_credentials_store|["']cli_auth_credentials_store["'])\s*=\s*["']file["']\s*(?:#.*)?$/m.test(
      rootConfig
    )
  ) {
    throw new Error('Managed Codex credential store must use isolated file credentials');
  }
  await chmod(configPath, 0o600);
  await inheritProjectTrust(config.getCodexHome(), homeDir);
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_|AZURE_OPENAI_|CODEX_)/i.test(key) ||
      /^(CHATGPT_TOKEN|CHATGPT_ACCESS_TOKEN|OPENAI_BASE_URL|MODEL_PROVIDER|DEFAULT_AUTH_REQUEST)$/i.test(
        key
      )
    ) {
      delete env[key];
    }
  }
  env.CODEX_HOME = homeDir;
  const sessionsDir = join(homeDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const sessionsInfo = await lstat(sessionsDir);
  if (!sessionsInfo.isDirectory() || sessionsInfo.isSymbolicLink()) {
    throw new Error('Managed Codex sessions directory cannot be a symlink');
  }
  await chmod(sessionsDir, 0o700);
  return { accountId: row.id, homeDir, sessionsDir, env };
}

export async function resolveHistoryContext(
  row: AccountRow,
  config: AccountConfig
): Promise<CodexRuntimeContext> {
  if (row.kind === 'NATIVE_DEFAULT') {
    return {
      accountId: row.id,
      homeDir: config.getCodexHome(),
      sessionsDir: config.getCodexSessionsDir(),
      env: config.getChildProcessEnv(),
    };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(row.id)) {
    throw new Error('Invalid Codex profile identifier');
  }
  const homeDir = join(config.getBaseDir(), 'codex-accounts', row.id);
  for (const path of [dirname(homeDir), homeDir, join(homeDir, 'sessions')]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Codex account history profile is unavailable');
    }
  }
  const env = config.getChildProcessEnv();
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_|AZURE_OPENAI_|CODEX_)/i.test(key) ||
      /^(CHATGPT_TOKEN|CHATGPT_ACCESS_TOKEN|MODEL_PROVIDER|DEFAULT_AUTH_REQUEST)$/i.test(key)
    ) {
      delete env[key];
    }
  }
  env.CODEX_HOME = homeDir;
  return { accountId: row.id, homeDir, sessionsDir: join(homeDir, 'sessions'), env };
}
export async function createLoginStage(context: CodexRuntimeContext): Promise<CodexRuntimeContext> {
  const homeDir = await mkdtemp(join(dirname(context.homeDir), 'login-'));
  await chmod(homeDir, 0o700);
  await writeFile(join(homeDir, 'config.toml'), 'cli_auth_credentials_store = "file"\n', {
    mode: 0o600,
  });
  return {
    ...context,
    homeDir,
    sessionsDir: join(homeDir, 'sessions'),
    env: { ...context.env, CODEX_HOME: homeDir },
  };
}
export async function adoptLoginStage(
  stage: CodexRuntimeContext,
  target: CodexRuntimeContext,
  signal?: AbortSignal
): Promise<void> {
  const path = join(stage.homeDir, 'auth.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Native login credential file is unavailable');
  }
  await chmod(path, 0o600);
  if (signal?.aborted) {
    throw new Error('Codex login cancelled');
  }
  await rename(path, join(target.homeDir, 'auth.json'));
}
export async function discardLoginStage(stage: CodexRuntimeContext): Promise<void> {
  await rm(stage.homeDir, { recursive: true, force: true });
}
