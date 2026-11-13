// Button and DropdownMenuItem take `pending` instead of a spinner child
// (docs/architecture/client-loading.md#pending-controls).
import { EXCEPTIONS_SCHEMA, isExceptedFile } from '../lib/exceptions.mjs';
import { jsxTagName } from '../lib/jsx.mjs';
import { hasSpinClass } from '../lib/spin-class.mjs';

const SPINNER_ELEMENTS = new Set(['Spinner', 'SpinnerGapIcon']);
const PENDING_CONTROLS = new Set(['Button', 'DropdownMenuItem']);

function classNameSpins(attribute, sourceCode) {
  return (
    attribute.type === 'JSXAttribute' &&
    attribute.name.name === 'className' &&
    Boolean(attribute.value) &&
    hasSpinClass(sourceCode.getText(attribute.value))
  );
}

/** The first spinner rendered among a control's children, through conditionals and fragments. */
function findChildSpinner(node, sourceCode) {
  switch (node?.type) {
    case 'JSXElement': {
      const opening = node.openingElement;
      if (
        SPINNER_ELEMENTS.has(jsxTagName(opening.name)) ||
        opening.attributes.some((attribute) => classNameSpins(attribute, sourceCode))
      ) {
        return node;
      }
      return findInChildren(node.children, sourceCode);
    }
    case 'JSXFragment':
      return findInChildren(node.children, sourceCode);
    case 'JSXExpressionContainer':
      return findChildSpinner(node.expression, sourceCode);
    case 'ConditionalExpression':
      return (
        findChildSpinner(node.consequent, sourceCode) ??
        findChildSpinner(node.alternate, sourceCode)
      );
    case 'LogicalExpression':
      return findChildSpinner(node.left, sourceCode) ?? findChildSpinner(node.right, sourceCode);
    default:
      return undefined;
  }
}

function findInChildren(children, sourceCode) {
  for (const child of children) {
    const spinner = findChildSpinner(child, sourceCode);
    if (spinner) {
      return spinner;
    }
  }
  return undefined;
}

export default {
  meta: {
    docs: {
      description:
        'Reject a Spinner, SpinnerGapIcon or animate-spin element inside Button or DropdownMenuItem, which take pending instead.',
    },
    schema: EXCEPTIONS_SCHEMA,
  },
  create(context) {
    if (isExceptedFile(context)) {
      return {};
    }
    return {
      JSXElement(node) {
        const name = jsxTagName(node.openingElement.name);
        if (!PENDING_CONTROLS.has(name)) {
          return;
        }
        const spinner = findInChildren(node.children, context.sourceCode);
        if (spinner) {
          context.report({
            node: spinner,
            message: `Pass \`pending\` to ${name} instead of rendering a spinner inside it; pending disables the control and shows the shared Spinner in place of its icon.`,
          });
        }
      },
    };
  },
};
