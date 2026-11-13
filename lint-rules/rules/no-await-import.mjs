export default {
  meta: {
    docs: {
      description:
        'Reject awaited dynamic imports; use static imports and extract shared modules to resolve circular dependencies.',
    },
  },
  create(context) {
    return {
      AwaitExpression(node) {
        if (node.argument.type === 'ImportExpression') {
          context.report({
            node,
            message: 'Use static imports. Extract shared modules to resolve circular dependencies.',
          });
        }
      },
    };
  },
};
