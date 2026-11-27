// Which files are tests, stories or test support, by path. The same
// conventions as `unusedCodeConventions` in scripts/check-unused-code.ts:
// `testing/` and `test-utils/` directories and `*.test-helpers.*`,
// `*.test-support.*`, `*.test-harness.*`, `*.story-fixtures.*` and
// `*.fixture.*` files, plus test and story files themselves.
const TEST_SUPPORT_DIRECTORY = /(?:^|\/)(?:testing|test-utils)\//u;
const TEST_SUPPORT_FILE =
  /\.(?:test|spec|stories|test-helpers|test-support|test-harness|story-fixtures|fixture)\.[cm]?[jt]sx?$/u;

export function isTestSupportFile(context) {
  const filename = context.filename.replaceAll('\\', '/');
  return TEST_SUPPORT_DIRECTORY.test(filename) || TEST_SUPPORT_FILE.test(filename);
}
