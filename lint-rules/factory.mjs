// Project rules use Oxlint's ESLint-compatible API.
function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') {
    return undefined;
  }
  return node.computed ? node.property.value : node.property.name;
}

function isMember(node, object, property) {
  return isIdentifier(node?.object, object) && memberName(node) === property;
}

function containsUnknownType(node, visitorKeys) {
  if (!node) {
    return false;
  }
  if (node.type === 'TSUnknownKeyword') {
    return true;
  }
  return (visitorKeys[node.type] ?? []).some((key) => {
    const child = node[key];
    return Array.isArray(child)
      ? child.some((value) => containsUnknownType(value, visitorKeys))
      : containsUnknownType(child, visitorKeys);
  });
}

const rules = {
  'no-await-import': {
    create(context) {
      return {
        AwaitExpression(node) {
          if (node.argument.type === 'ImportExpression') {
            context.report({
              node,
              message:
                'Use static imports. Extract shared modules to resolve circular dependencies.',
            });
          }
        },
      };
    },
  },
  'no-native-dialogs': {
    create(context) {
      return {
        CallExpression(node) {
          const callee = node.callee;
          const name =
            callee.type === 'Identifier'
              ? callee.name
              : isIdentifier(callee.object, 'window')
                ? memberName(callee)
                : undefined;
          if (['alert', 'confirm', 'prompt'].includes(name)) {
            context.report({
              node,
              message: 'Use ConfirmDialog or AlertDialog for browser dialogs.',
            });
          }
        },
      };
    },
  },
  'no-next-directives': {
    create(context) {
      return {
        ExpressionStatement(node) {
          if (['use client', 'use server'].includes(node.expression.value)) {
            context.report({
              node,
              message: 'Remove Next.js directives from this Vite application.',
            });
          }
        },
      };
    },
  },
  'no-zod-any': {
    create(context) {
      return {
        CallExpression(node) {
          if (isMember(node.callee, 'z', 'any') || isMember(node.callee, 'zod', 'any')) {
            context.report({
              node,
              message: 'Use a specific Zod schema, or z.unknown() with explicit narrowing.',
            });
          }
        },
      };
    },
  },
  'no-unsafe-json-parse-cast': {
    create(context) {
      return {
        TSAsExpression(node) {
          if (
            node.expression.type === 'CallExpression' &&
            isMember(node.expression.callee, 'JSON', 'parse')
          ) {
            context.report({
              node,
              message: 'Validate JSON.parse results with a Zod schema instead of a type assertion.',
            });
          }
        },
      };
    },
  },
  'no-unsafe-resolver-cast': {
    create(context) {
      return {
        TSAsExpression(node) {
          if (
            isIdentifier(node.expression, 'resolve') &&
            node.typeAnnotation.type === 'TSFunctionType' &&
            node.typeAnnotation.params.some((parameter) =>
              containsUnknownType(parameter, context.sourceCode.visitorKeys)
            )
          ) {
            context.report({
              node,
              message:
                'Type promise resolvers with proper generics and validate data before resolving.',
            });
          }
        },
      };
    },
  },
};

export default { meta: { name: 'factory' }, rules };
