// Keep this check independent of server and native-module imports so it can run
// before unsupported runtimes try to initialize the application.
export function getNodeRuntimeIssue(version: string, requirement: string): string | undefined {
  const minimum = requirement.replace(/^>=/, '');
  const release = version.replace(/\+.*$/, '');
  const currentParts = release.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  // Package engine ranges exclude prereleases, even above the minimum major.
  if (!release.includes('-')) {
    for (let i = 0; i < 3; i += 1) {
      const current = currentParts[i] ?? 0;
      const required = minimumParts[i] ?? 0;
      if (current > required) {
        return undefined;
      }
      if (current < required || !Number.isInteger(current)) {
        break;
      }
      if (i === 2) {
        return undefined;
      }
    }
  }
  return [
    `Node.js ${version} is not supported. Factory Factory requires Node.js ${requirement}.`,
    `Install a supported version from https://nodejs.org/ and reopen your terminal.`,
    `If you use nvm, run:`,
    `  nvm install ${minimum}`,
    `  nvm use ${minimum}`,
    `Then run ff serve again.`,
  ].join('\n');
}
