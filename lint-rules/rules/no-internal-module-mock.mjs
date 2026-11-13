// A test outside a service capsule mocks the capsule through its barrel or a
// fake from its `testing/` directory, never an internal module by path: when
// that module moves, the mock silently stops applying
// (docs/architecture/agent-friendly-codebase.md, principles 2 and 3;
// src/backend/services/AGENTS.md). A capsule is a directory under
// src/backend/services/ with an index.ts, read once when the rule loads, so a
// new capsule needs an editor language server restart; root files there are
// infrastructure, not capsules. Enabled for test files under src/.
// Sealed modules inside a capsule are not modelled yet; extend `internalTarget`.
import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMember } from '../lib/ast.mjs';
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import exceptions from './no-internal-module-mock.exceptions.json' with { type: 'json' };

const SERVICES = 'src/backend/services';
const servicesDirectory = fileURLToPath(new URL(`../../${SERVICES}`, import.meta.url));
const CAPSULES = new Set(
  readdirSync(servicesDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(servicesDirectory, entry.name, 'index.ts'))
    )
    .map((entry) => entry.name)
);

/** The capsule and the path inside it for an absolute path, if it lies in one. */
function capsulePath(path) {
  const start = path.lastIndexOf(`/${SERVICES}/`);
  if (start === -1) {
    return undefined;
  }
  const [capsule, ...inner] = path.slice(start + SERVICES.length + 2).split('/');
  return CAPSULES.has(capsule) && inner.length > 0
    ? { capsule, inner: inner.join('/') }
    : undefined;
}

/** The capsule whose internal module `specifier` names, from the test at `filename`. */
function internalTarget(specifier, filename) {
  let resolved;
  if (specifier.startsWith('@/')) {
    resolved = `/src/${specifier.slice(2)}`;
  } else if (specifier.startsWith('/')) {
    // Vite resolves `/src/…` from the project root; `capsulePath` reads either form.
    resolved = specifier;
  } else if (specifier === '.' || specifier === '..' || /^\.\.?\//.test(specifier)) {
    resolved = posix.resolve(posix.dirname(filename), specifier);
  } else {
    return undefined;
  }
  const target = capsulePath(posix.normalize(resolved).replace(/\/$/, ''));
  if (!target || /^index(\.ts)?$/.test(target.inner) || /^testing(\/|$)/.test(target.inner)) {
    return undefined;
  }
  return capsulePath(filename)?.capsule === target.capsule ? undefined : target.capsule;
}

/** A string literal, or a template literal without substitutions. */
function literalValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

export default {
  meta: {
    docs: {
      description:
        "Reject vi.mock and vi.doMock of a module inside another service capsule (a directory under src/backend/services/ with an index.ts) other than its barrel or its testing/ directory. Only literal targets are checked; a test inside the capsule may mock the capsule's own modules.",
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context, exceptions)) {
      return {};
    }
    const filename = context.filename.replaceAll('\\', '/');
    return {
      CallExpression(node) {
        if (!isMember(node.callee, 'vi', 'mock') && !isMember(node.callee, 'vi', 'doMock')) {
          return;
        }
        const specifier = literalValue(node.arguments[0]);
        const capsule = specifier === undefined ? undefined : internalTarget(specifier, filename);
        if (capsule) {
          context.report({
            node: node.arguments[0],
            message: `Mock the \`${capsule}\` barrel or pass a fake from \`${capsule}/testing\`; internal paths move.`,
          });
        }
      },
    };
  },
};
