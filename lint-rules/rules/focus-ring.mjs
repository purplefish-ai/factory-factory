// Keyboard focus styles use the `focus-ring` utility in src/client/globals.css
// (docs/shadcn.md#buttons-icon-buttons-and-tooltips). Enabled for src/client.
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';

// Hand-rolled keyboard focus styles that the `focus-ring` utility replaces:
// `focus-visible:ring-2`, `focus-visible:outline-none`, `focus-visible:outline-ring`.
const HAND_ROLLED_FOCUS_CLASS =
  /(?<=^|[\s'"`:!])focus-visible:(?:ring-2|outline(?:-none|-ring|-2)?)(?![\w-])/;

export default {
  meta: {
    docs: {
      description:
        'Reject the hand-rolled focus-visible:ring-2 and focus-visible:outline… styles that the focus-ring utility replaces.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context)) {
      return {};
    }
    const report = (node, text) => {
      const match = typeof text === 'string' ? HAND_ROLLED_FOCUS_CLASS.exec(text) : null;
      if (match) {
        context.report({
          node,
          message: `Use the focus-ring utility (src/client/globals.css) instead of "${match[0]}".`,
        });
      }
    };
    return {
      Literal(node) {
        report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
