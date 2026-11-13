// Pending indicators use the shared Spinner
// (docs/architecture/client-loading.md#pending-controls).
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { jsxTagName } from '../lib/jsx.mjs';
import { hasSpinClass } from '../lib/spin-class.mjs';
import exceptions from './no-raw-spinner.exceptions.json' with { type: 'json' };

export default {
  meta: {
    docs: {
      description:
        'Reject a bare SpinnerGapIcon and animate-spin outside the shared Spinner (src/components/ui/spinner.tsx).',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context, exceptions)) {
      return {};
    }
    const message =
      'Use the shared Spinner (src/components/ui/spinner.tsx) instead of SpinnerGapIcon or animate-spin (docs/architecture/client-loading.md).';
    const report = (node, text) => {
      if (hasSpinClass(text)) {
        context.report({ node, message });
      }
    };
    return {
      // Class strings are also built in variables, `cn()` arguments and
      // status config objects, so every string is checked, not only JSX.
      Literal(node) {
        report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.cooked ?? node.value.raw);
      },
      JSXOpeningElement(node) {
        if (jsxTagName(node.name) === 'SpinnerGapIcon') {
          context.report({ node, message });
        }
      },
    };
  },
};
