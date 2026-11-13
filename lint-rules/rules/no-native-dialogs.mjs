import { isIdentifier, memberName } from '../lib/ast.mjs';

export default {
  meta: {
    docs: {
      description:
        'Reject native browser dialogs (alert, confirm, prompt); use ConfirmDialog or AlertDialog.',
    },
  },
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
};
