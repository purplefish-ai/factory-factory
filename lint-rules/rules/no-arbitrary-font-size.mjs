// Font sizes come from the type scale (docs/status-colors.md#small-text).
// Tests are exempt.
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import exceptions from './no-arbitrary-font-size.exceptions.json' with { type: 'json' };

// An arbitrary font size such as `text-[10px]`, `md:text-[0.8rem]` or
// `text-[1.5em]`; the type scale (`text-2xs`, `text-xs`, …) replaces them.
const ARBITRARY_FONT_SIZE_CLASS = /(?<=^|[\s'"`:!])text-\[(?:\d*\.)?\d+(?:px|r?em)\](?![\w-])/;

export default {
  meta: {
    docs: {
      description:
        "Reject arbitrary font sizes such as text-[10px] or md:text-[0.8rem]; use the type scale's text-2xs, text-xs and up instead.",
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context, exceptions)) {
      return {};
    }
    const report = (node, text) => {
      const match = typeof text === 'string' ? ARBITRARY_FONT_SIZE_CLASS.exec(text) : null;
      if (match) {
        context.report({
          node,
          message: `Use the type scale (text-2xs, text-xs, text-sm, …) instead of "${match[0]}" (docs/status-colors.md#small-text).`,
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
