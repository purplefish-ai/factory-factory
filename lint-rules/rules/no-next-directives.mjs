export default {
  meta: {
    docs: {
      description: "Reject the Next.js 'use client' and 'use server' directives in this Vite app.",
    },
  },
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
};
