// Button sizing follows the `size` variant
// (docs/shadcn.md#buttons-icon-buttons-and-tooltips).
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { classNameText, jsxTagName } from '../lib/jsx.mjs';
import { SIZED_BUTTONS } from '../lib/sized-buttons.mjs';

// `h-4`, `w-3.5`, `md:size-8`, `h-px`: a fixed height, width or size from the
// spacing scale. Keywords (`w-full`, `h-auto`), fractions (`w-1/2`) and
// arbitrary values (`w-[160px]`) are layout, not control sizes, and pass.
const FIXED_SIZE_CLASS = /(?<=^|[\s'"`:!])(?:h|w|size)-(?:\d+(?:\.\d+)?|px)(?![\w./-])/;

export default {
  meta: {
    docs: {
      description:
        'Reject a fixed h-N, w-N or size-N class (with any variant prefix) in a Button or IconButton className; use a size variant. Keywords such as w-full and h-auto, arbitrary values and min-/max- widths are layout and pass.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context)) {
      return {};
    }
    return {
      JSXOpeningElement(node) {
        const name = jsxTagName(node.name);
        if (!SIZED_BUTTONS.has(name)) {
          return;
        }
        const match = FIXED_SIZE_CLASS.exec(classNameText(node, context.sourceCode));
        if (match) {
          context.report({
            node,
            message: `Use a ${name} size variant (xs, compact, sm, default, lg, inline or icon-*) instead of "${match[0]}" in className. Layout widths such as w-full pass.`,
          });
        }
      },
    };
  },
};
