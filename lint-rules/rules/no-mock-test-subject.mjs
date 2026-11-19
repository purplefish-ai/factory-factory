// A co-located test should exercise its named module. Dependency fakes and
// spies that leave the module's implementation running still work.
import { staticKeyName } from '../lib/ast.mjs';
import {
  isModuleMockCall,
  moduleMockTarget,
  resolveRepositoryModule,
  resolveRepositoryPath,
} from '../lib/module-mock.mjs';

const testSuffix = /\.(?:integration\.)?test\.tsx?$/;
const sourceExtension = /\.[cm]?[jt]sx?$/;

function observesModule(options) {
  if (options?.type !== 'ObjectExpression' || options.properties.length !== 1) {
    return false;
  }

  const [property] = options.properties;
  return (
    property.type === 'Property' &&
    staticKeyName(property.key, property.computed) === 'spy' &&
    property.value.type === 'Literal' &&
    property.value.value === true
  );
}

export default {
  meta: {
    docs: {
      description:
        'Reject vi.mock and vi.doMock that replace the module named by a co-located test. Observation-only module spies are allowed.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!testSuffix.test(filename)) {
      return {};
    }

    const subject = filename.replace(testSuffix, '');
    return {
      CallExpression(node) {
        if (!isModuleMockCall(node) || observesModule(node.arguments[1])) {
          return;
        }

        const specifier = moduleMockTarget(node.arguments[0]);
        const target =
          specifier === undefined ? undefined : resolveRepositoryPath(specifier, filename);

        const source = target === undefined ? undefined : resolveRepositoryModule(target);

        if (source?.replace(sourceExtension, '') === subject) {
          context.report({
            node: node.arguments[0],
            message: 'Use the real module under test. Mock a dependency at its public boundary.',
          });
        }
      },
    };
  },
};
