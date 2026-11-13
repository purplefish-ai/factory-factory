// Tooltips render under the root providers' TooltipProvider
// (docs/shadcn.md#buttons-icon-buttons-and-tooltips). Tests are exempt so they
// can supply their own provider.
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { jsxTagName } from '../lib/jsx.mjs';
import exceptions from './tooltip-provider-root.exceptions.json' with { type: 'json' };

export default {
  meta: {
    docs: {
      description: 'Reject <TooltipProvider> outside the root providers.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context, exceptions)) {
      return {};
    }
    return {
      JSXOpeningElement(node) {
        if (jsxTagName(node.name) === 'TooltipProvider') {
          context.report({
            node,
            message:
              'Render tooltips under the app root TooltipProvider instead of nesting one; a nested provider without props resets the open delay to 700ms.',
          });
        }
      },
    };
  },
};
