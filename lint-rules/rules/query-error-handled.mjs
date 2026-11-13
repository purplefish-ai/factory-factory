// A failed request must not read as loading or empty
// (docs/architecture/client-loading.md). A result passed on whole, such as
// `<QueryState query={query}>`, or destructured with a rest element is left to
// its consumer; reads through a local alias are followed. The rule checks that
// an error field is read, not how it is rendered. It has no exceptions.
import { memberName } from '../lib/ast.mjs';

// Query result fields that only say the request is unresolved or in flight, and
// the fields that say it failed (docs/architecture/client-loading.md).
const QUERY_LOADING_FIELDS = new Set(['isLoading', 'isPending', 'isInitialLoading']);
const QUERY_ERROR_FIELDS = new Set([
  'error',
  'isError',
  'status',
  'isLoadingError',
  'isRefetchError',
]);

/**
 * `useQuery`, `useInfiniteQuery` and wrapper hooks named `use…Query`, called
 * directly or on a tRPC procedure. Suspense queries throw to an error boundary.
 */
function isQueryHookCall(node) {
  if (node?.type !== 'CallExpression') {
    return false;
  }
  const name = node.callee.type === 'Identifier' ? node.callee.name : memberName(node.callee);
  return typeof name === 'string' && /^use\w*Query$/.test(name) && !name.startsWith('useSuspense');
}

/** Fields read from a query result, or `undefined` when the whole result escapes. */
function readQueryFields(context, declarator) {
  if (declarator.id.type === 'ObjectPattern') {
    const fields = [];
    for (const property of declarator.id.properties) {
      if (property.type !== 'Property' || property.computed) {
        return undefined;
      }
      fields.push(property.key.name ?? property.key.value);
    }
    return fields;
  }
  if (declarator.id.type !== 'Identifier') {
    return undefined;
  }
  const fields = [];
  for (const variable of context.sourceCode.getDeclaredVariables(declarator)) {
    for (const reference of variable.references) {
      const parent = reference.identifier.parent;
      if (parent === declarator) {
        continue;
      }
      // `const { isLoading } = query` and `const alias = query` read through another binding.
      if (parent.type === 'VariableDeclarator' && parent.init === reference.identifier) {
        const aliased = readQueryFields(context, parent);
        if (!aliased) {
          return undefined;
        }
        fields.push(...aliased);
        continue;
      }
      if (parent.type !== 'MemberExpression' || parent.object !== reference.identifier) {
        return undefined;
      }
      fields.push(memberName(parent));
    }
  }
  return fields;
}

export default {
  meta: {
    docs: {
      description:
        'Flag a query hook result (useQuery, useInfiniteQuery or a use…Query wrapper, but not suspense queries) whose destructuring or member reads take isLoading, isPending or isInitialLoading but none of error, isError, status, isLoadingError or isRefetchError.',
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (!isQueryHookCall(node.init)) {
          return;
        }
        const fields = readQueryFields(context, node);
        if (
          fields?.some((field) => QUERY_LOADING_FIELDS.has(field)) &&
          !fields.some((field) => QUERY_ERROR_FIELDS.has(field))
        ) {
          context.report({
            node,
            message:
              'This query reads a loading flag but not `error`, so a failed request reads as loading or empty. Render it with QueryState, or handle `error` (docs/architecture/client-loading.md).',
          });
        }
      },
    };
  },
};
