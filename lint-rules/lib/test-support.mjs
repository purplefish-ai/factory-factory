// Which files are tests, stories or test support, by path. The same
// conventions as `unusedCodeConventions` in scripts/check-unused-code.ts:
// `testing/` and `test-utils/` directories and `*.test-helpers.*`,
// `*.test-support.*`, `*.test-harness.*`, `*.story-fixtures.*` and
// `*.fixture.*` files, plus test and story files themselves.
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const TEST_SUPPORT_DIRECTORY = /(?:^|\/)(?:testing|test-utils)\//u;
const TEST_SUPPORT_FILE =
  /\.(?:test|spec|stories|test-helpers|test-support|test-harness|story-fixtures|fixture)\.[cm]?[jt]sx?$/u;

/**
 * The directory test looks only below the repository root, so a checkout kept
 * under a directory named `testing` is not mistaken for test support.
 */
export function isTestSupportFile(context) {
  const filename = context.filename.replaceAll('\\', '/');
  const inRepository = filename.startsWith(repositoryRoot)
    ? filename.slice(repositoryRoot.length)
    : filename;
  return TEST_SUPPORT_DIRECTORY.test(inRepository) || TEST_SUPPORT_FILE.test(filename);
}
