import { nodeFloors, supportsNode } from './setup-prerequisites.mjs';

// Keep this check independent of server and native-module imports so it can run
// before unsupported runtimes try to initialize the application.
export function getNodeRuntimeIssue(version: string, requirement: string): string | undefined {
  if (supportsNode(version, requirement)) {
    return undefined;
  }
  const { minimum } = nodeFloors(requirement);
  return [
    `Node.js ${version} is not supported. Factory Factory requires Node.js ${requirement}.`,
    `Install a supported version from https://nodejs.org/ and reopen your terminal.`,
    `If you use nvm, run:`,
    `  nvm install ${minimum}`,
    `  nvm use ${minimum}`,
    `Then run ff serve again.`,
  ].join('\n');
}
