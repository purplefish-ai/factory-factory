import { isMember } from '../lib/ast.mjs';

export default {
  meta: {
    docs: {
      description: 'Reject type assertions on JSON.parse results; validate them with a Zod schema.',
    },
  },
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
};
