import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBuildRecoveryGuidance } from './build-command';

export function checkServePrerequisites(projectRoot: string, dev: boolean): string[] {
  const issues: string[] = [];
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
  } catch {
    issues.push(
      'Git could not be run. Install Git from https://git-scm.com/downloads and make sure `git --version` works in this terminal.'
    );
  }
  if (dev) {
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const missing = ['tsx', 'vite'].filter(
      (tool) => !existsSync(join(projectRoot, 'node_modules', '.bin', `${tool}${suffix}`))
    );
    if (missing.length) {
      issues.push(
        `Development tools missing: ${missing.join(', ')}. Run \`pnpm install\` from the source checkout using the pnpm version pinned in package.json. Installed packages should use \`ff serve\` without --dev.`
      );
    }
  } else if (
    !(
      existsSync(join(projectRoot, 'dist', 'client', 'index.html')) &&
      existsSync(join(projectRoot, 'dist', 'src', 'backend', 'index.js'))
    )
  ) {
    issues.push(getBuildRecoveryGuidance(projectRoot, { supportsDevMode: true }));
  }
  return issues;
}
