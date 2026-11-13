// Keeps query options in one place
// (docs/architecture/client-loading.md#query-retries-and-polling). It does not
// resolve identifiers, so a local numeric constant passes. QueryClient
// defaults (`queries` and `mutations` objects) and tests are exempt.
import { isFunction } from '../lib/ast.mjs';

function propertyKey(node) {
  if (node.computed) {
    return node.key.type === 'Literal' ? node.key.value : undefined;
  }
  return node.key.type === 'Identifier' ? node.key.name : node.key.value;
}

/** `{ queries: { ... } }` or `{ mutations: { ... } }`: QueryClient defaults, not a call site. */
function isQueryClientDefault(property) {
  const owner = property.parent?.parent;
  return (
    owner?.type === 'Property' &&
    owner.value === property.parent &&
    ['queries', 'mutations'].includes(propertyKey(owner))
  );
}

/** Return values of a function body, not descending into nested functions. */
function returnedExpressions(node, visitorKeys, found = []) {
  if (!node || isFunction(node)) {
    return found;
  }
  if (node.type === 'ReturnStatement') {
    found.push(node.argument);
    return found;
  }
  for (const key of visitorKeys[node.type] ?? []) {
    const child = node[key];
    for (const value of Array.isArray(child) ? child : [child]) {
      if (value && typeof value.type === 'string') {
        returnedExpressions(value, visitorKeys, found);
      }
    }
  }
  return found;
}

const COMPARISON_OPERATORS = new Set([
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'instanceof',
]);

/** A numeric literal that the interval can evaluate to, through branches and callbacks. */
function numericIntervalLiteral(node, visitorKeys) {
  const find = (child) => numericIntervalLiteral(child, visitorKeys);
  switch (node?.type) {
    case 'Literal':
      return typeof node.value === 'number' ? node : undefined;
    case 'ConditionalExpression':
      return find(node.consequent) ?? find(node.alternate);
    case 'LogicalExpression':
      return find(node.left) ?? find(node.right);
    case 'BinaryExpression':
      // A comparison yields a boolean; its operands are never the interval.
      return COMPARISON_OPERATORS.has(node.operator)
        ? undefined
        : (find(node.left) ?? find(node.right));
    case 'UnaryExpression':
      return find(node.argument);
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return find(node.expression);
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return node.body.type === 'BlockStatement'
        ? returnedExpressions(node.body, visitorKeys).map(find).find(Boolean)
        : find(node.body);
    default:
      return undefined;
  }
}

export default {
  meta: {
    docs: {
      description:
        'Reject a numeric refetchInterval literal, including inside a conditional, arithmetic or a callback return value (comparison operands are ignored), refetchOnWindowFocus: false, and a boolean or numeric retry.',
    },
  },
  create(context) {
    // Query defaults live in src/client/lib/query-client.ts and named
    // intervals and retry exceptions in src/client/lib/query-options.ts.
    return {
      Property(node) {
        if (isQueryClientDefault(node)) {
          return;
        }
        const key = propertyKey(node);
        const value = node.value;
        if (key === 'refetchInterval') {
          const literal = numericIntervalLiteral(value, context.sourceCode.visitorKeys);
          if (literal) {
            context.report({
              node: literal,
              message:
                'Use a POLL_INTERVAL_MS tier from src/client/lib/query-options.ts instead of a numeric refetchInterval.',
            });
          }
        } else if (
          key === 'refetchOnWindowFocus' &&
          value.type === 'Literal' &&
          value.value === false
        ) {
          context.report({
            node,
            message:
              'Remove refetchOnWindowFocus: false; it is the app default (src/client/lib/query-client.ts).',
          });
        } else if (
          key === 'retry' &&
          value.type === 'Literal' &&
          ['boolean', 'number'].includes(typeof value.value)
        ) {
          context.report({
            node,
            message:
              'Rely on the app retry policy (src/client/lib/query-client.ts) or use a named QUERY_RETRY reason from src/client/lib/query-options.ts.',
          });
        }
      },
    };
  },
};
