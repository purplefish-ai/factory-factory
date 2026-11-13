// React 19 passes `ref` as a prop. Off for the shadcn/ui primitives in
// src/components/ui/.
import { isIdentifier, memberName } from '../lib/ast.mjs';

export default {
  meta: {
    docs: {
      description: 'Reject forwardRef: React 19 passes ref as a prop.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          isIdentifier(callee, 'forwardRef') ||
          (callee.type === 'MemberExpression' && memberName(callee) === 'forwardRef')
        ) {
          context.report({
            node,
            message:
              'React 19 passes `ref` as a prop; take it from props instead of wrapping the component in forwardRef.',
          });
        }
      },
    };
  },
};
