import { isMember } from '../lib/ast.mjs';

export default {
  meta: {
    docs: {
      description:
        'Reject z.any() and zod.any(); use a specific Zod schema, or z.unknown() with explicit narrowing.',
    },
  },
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
};
