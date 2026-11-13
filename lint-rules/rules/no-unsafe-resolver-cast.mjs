import { isIdentifier } from '../lib/ast.mjs';

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

export default {
  meta: {
    docs: {
      description:
        'Reject casts of promise resolvers to function types accepting unknown; type resolvers with proper generics and validate data before resolving.',
    },
  },
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
};
